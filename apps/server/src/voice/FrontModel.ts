import {
  DEFAULT_VOICE_FRONT_MODEL,
  type EnvironmentVoiceFrontModel,
  type EnvironmentVoiceFrontModels,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import { parseFrontDecision, parsePartialSpeech, type PartialSpeech } from "./decision.ts";
import { FRONT_MODELS, type FrontModelEntry, getFrontModel } from "./frontModels.ts";
import { type FrontLlama, loadFrontLlama } from "./llama.ts";
import { makeOpenAiFrontSession } from "./openai.ts";
import * as VoicePack from "./pack/VoicePack.ts";

export type FrontAction = "reply" | "delegate" | "note" | "none";

export interface FrontDecision {
  readonly action: FrontAction;
  readonly speech: string;
  readonly task?: string;
  /** The task would publish, send, or change something outside the local checkout. */
  readonly outward?: boolean;
}

export interface FrontMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class FrontModelError extends Schema.TaggedError<FrontModelError>()("FrontModelError", {
  operation: Schema.Literals(["download", "load", "decide", "remove"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const base = `The voice front model failed to ${this.operation}.`;
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

export class FrontModelNotFoundError extends Schema.TaggedError<FrontModelNotFoundError>()(
  "FrontModelNotFoundError",
  { modelId: Schema.String },
) {
  override get message(): string {
    return `Unknown front model "${this.modelId}".`;
  }
}

export interface FrontModelSession {
  /**
   * Output forced through a JSON schema, so it always decodes. A shared message prefix reuses the KV cache. Interrupting the effect aborts generation.
   * `onSpeech` sees the speech grow while it generates, where the engine streams.
   */
  readonly decide: (
    messages: readonly FrontMessage[],
    onSpeech?: (speech: PartialSpeech) => void,
  ) => Effect.Effect<FrontDecision, FrontModelError>;
}

export class FrontModel extends Context.Service<
  FrontModel,
  {
    /** Loads the configured model (managed GGUF, or the OpenAI-compatible URL override) and keeps it loaded for the scope, e.g. one call. */
    readonly acquire: Effect.Effect<FrontModelSession, FrontModelError, Scope.Scope>;
    readonly models: Effect.Effect<EnvironmentVoiceFrontModels, FrontModelError>;
    /** Completes once the model is installed; progress shows in `models` meanwhile. */
    readonly download: (
      modelId: string,
    ) => Effect.Effect<EnvironmentVoiceFrontModels, FrontModelError | FrontModelNotFoundError>;
    readonly cancelDownload: (
      modelId: string,
    ) => Effect.Effect<EnvironmentVoiceFrontModels, FrontModelError>;
    /** Unloads the model first, ending the front model of any call using it. */
    readonly remove: (
      modelId: string,
    ) => Effect.Effect<EnvironmentVoiceFrontModels, FrontModelError | FrontModelNotFoundError>;
  }
>()("t3/voice/FrontModel") {}

/** A loaded model holds 2-4 GiB, so it goes once no call has used it for a while. */
const IDLE_UNLOAD = "5 minutes";

export const make = Effect.fn("FrontModel.make")(function* (
  load: (
    path: string,
    signal: AbortSignal,
    pack: VoicePack.VoicePackInstall,
  ) => Promise<FrontLlama> = (path, signal, pack) =>
    loadFrontLlama(path, signal, {
      packRoot: pack.root,
      gpu: pack.gpu,
      ...(pack.libraryPath ? { libraryPath: pack.libraryPath } : {}),
    }),
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const voicePack = yield* VoicePack.VoicePack;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  type Transfer = {
    downloaded: number;
    verifying: boolean;
    readonly fiber: Deferred.Deferred<Fiber.Fiber<string, FrontModelError>>;
  };
  const transfers = new Map<string, Transfer>();
  // Settings and a call's first acquire share one transfer per model.
  const transferFiber = (model: FrontModelEntry) =>
    Effect.suspend(() => {
      const existing = transfers.get(model.id);
      if (existing) return Deferred.await(existing.fiber);
      const transfer: Transfer = { downloaded: 0, verifying: false, fiber: Deferred.makeUnsafe() };
      transfers.set(model.id, transfer);
      return store
        .download(model, {
          onProgress: (downloaded) => {
            transfer.downloaded = downloaded;
          },
          onVerificationStart: () => {
            transfer.verifying = true;
          },
        })
        .pipe(
          Effect.mapError((cause) => new FrontModelError({ operation: "download", cause })),
          Effect.ensuring(Effect.sync(() => transfers.delete(model.id))),
          Effect.forkIn(scope),
          Effect.tap((fiber) => Deferred.succeed(transfer.fiber, fiber)),
        );
    });
  const install = Effect.fn("FrontModel.install")(function* (model: FrontModelEntry) {
    const exit = yield* Fiber.await(yield* transferFiber(model));
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      return yield* new FrontModelError({
        operation: "download",
        detail: "The download was cancelled.",
      });
    return yield* exit;
  });
  const workers: RcMap.RcMap<FrontModelEntry, FrontLlama, FrontModelError> = yield* RcMap.make({
    lookup: Effect.fn("FrontModel.load")(
      function* (model: FrontModelEntry) {
        const path = yield* install(model);
        // Held for the worker's life, so an upgrade never deletes files it has loaded.
        const pack = yield* voicePack.use.pipe(
          Effect.mapError(
            (cause) => new FrontModelError({ operation: "load", detail: cause.detail, cause }),
          ),
        );
        return yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: (signal) => load(path, signal, pack),
            catch: (cause) => new FrontModelError({ operation: "load", cause }),
          }),
          (loaded) => Effect.promise(() => loaded.dispose()),
        );
      },
      (effect, model) =>
        // RcMap keeps a failed lookup until it idles out, even when its caller was interrupted.
        // Evict it so the next call retries, such as once the voice pack has downloaded.
        Effect.tapError(effect, () => RcMap.invalidate(workers, model)),
    ),
    idleTimeToLive: IDLE_UNLOAD,
  });
  const acquire = Effect.fn("FrontModel.acquire")(function* () {
    const configured = (yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new FrontModelError({ operation: "load", cause })),
    )).voiceFrontModel;
    if (typeof configured !== "string")
      return yield* makeOpenAiFrontSession(configured).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
    const model = getFrontModel(configured);
    if (!model)
      return yield* new FrontModelError({
        operation: "load",
        detail: `Unknown front model "${configured}".`,
      });
    const loaded = yield* RcMap.get(workers, model);
    const decide: FrontModelSession["decide"] = Effect.fn("FrontModel.decide")(
      function* (messages, onSpeech) {
        let streamed = "";
        let spoken: PartialSpeech | undefined;
        const onChunk = onSpeech
          ? (chunk: string) => {
              if (spoken?.complete) return;
              streamed += chunk;
              const speech = parsePartialSpeech(streamed);
              if (
                !speech ||
                (speech.speech === spoken?.speech && speech.complete === spoken.complete)
              )
                return;
              spoken = speech;
              onSpeech(speech);
            }
          : undefined;
        const text = yield* Effect.tryPromise({
          try: (signal) => loaded.decide(messages, signal, onChunk),
          catch: (cause) => new FrontModelError({ operation: "decide", cause }),
        });
        const decision = parseFrontDecision(text);
        if (!decision)
          return yield* new FrontModelError({
            operation: "decide",
            detail: `The model's reply was not a decision: ${text.slice(0, 200)}`,
          });
        return decision;
      },
    );
    return { decide } satisfies FrontModelSession;
  });
  const models = Effect.fn("FrontModel.models")(function* () {
    const configured = (yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new FrontModelError({ operation: "load", cause })),
    )).voiceFrontModel;
    const list = yield* Effect.forEach(
      FRONT_MODELS,
      (model) =>
        store.isReady(model).pipe(
          Effect.map((ready): EnvironmentVoiceFrontModel => {
            const transfer = transfers.get(model.id);
            return {
              id: model.id,
              name: model.name,
              description: model.description,
              size: model.size,
              recommended: model.id === DEFAULT_VOICE_FRONT_MODEL,
              active: model.id === configured,
              state: transfer
                ? transfer.verifying
                  ? "verifying"
                  : "downloading"
                : ready
                  ? "installed"
                  : "downloadable",
              ...(transfer ? { downloaded: transfer.downloaded } : {}),
            };
          }),
        ),
      { concurrency: "unbounded" },
    );
    return { models: list };
  });
  const find = (modelId: string) =>
    Effect.fromNullishOr(getFrontModel(modelId)).pipe(
      Effect.mapError(() => new FrontModelNotFoundError({ modelId })),
    );
  const cancel = (modelId: string) =>
    Effect.suspend(() => {
      const transfer = transfers.get(modelId);
      return transfer
        ? Deferred.await(transfer.fiber).pipe(Effect.flatMap(Fiber.interrupt))
        : Effect.void;
    });
  return FrontModel.of({
    acquire: acquire(),
    models: models(),
    download: Effect.fn("FrontModel.download")(function* (modelId) {
      yield* install(yield* find(modelId));
      return yield* models();
    }),
    cancelDownload: Effect.fn("FrontModel.cancelDownload")(function* (modelId) {
      yield* cancel(modelId);
      return yield* models();
    }),
    remove: Effect.fn("FrontModel.remove")(function* (modelId) {
      const model = yield* find(modelId);
      yield* cancel(modelId);
      yield* RcMap.invalidate(workers, model);
      yield* store
        .remove(model)
        .pipe(Effect.mapError((cause) => new FrontModelError({ operation: "remove", cause })));
      return yield* models();
    }),
  });
});

export const layer = Layer.effect(FrontModel, make());

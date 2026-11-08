import type { EnvironmentVoiceTtsModel } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as RcRef from "effect/RcRef";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  KOKORO_DEFAULT_VOICE,
  KOKORO_MODEL_FILES,
  KOKORO_SAMPLE_RATE,
  loadKokoroSpeaker,
  type KokoroSpeaker,
} from "./kokoro.ts";
import { splitSentences } from "./sentences.ts";
import * as VoicePack from "../voice/pack/VoicePack.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

export class TextToSpeechError extends Schema.TaggedError<TextToSpeechError>()(
  "TextToSpeechError",
  {
    operation: Schema.Literals(["download", "load", "synthesize", "remove"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const base = `Speech synthesis failed to ${this.operation}.`;
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

export class TextToSpeech extends Context.Service<
  TextToSpeech,
  {
    readonly sampleRate: number;
    /** Loads the voice now and keeps it loaded until the scope closes, as a call does. */
    readonly hold: Effect.Effect<void, TextToSpeechError, Scope.Scope>;
    /** 24 kHz mono PCM, one chunk per sentence, so playback starts on the first. */
    readonly synthesize: (
      text: string,
      voice?: string,
    ) => Stream.Stream<Float32Array, TextToSpeechError>;
    readonly model: Effect.Effect<EnvironmentVoiceTtsModel>;
    /** Completes once the model is installed; progress shows in `model` meanwhile. */
    readonly download: Effect.Effect<EnvironmentVoiceTtsModel, TextToSpeechError>;
    readonly cancelDownload: Effect.Effect<EnvironmentVoiceTtsModel>;
    /** A call already speaking keeps its loaded voice; the next one needs a new download. */
    readonly remove: Effect.Effect<EnvironmentVoiceTtsModel, TextToSpeechError>;
  }
>()("t3/speech/TextToSpeech") {}

/** Kokoro's worker holds about 0.9 GiB, so it goes once nothing has spoken for a while. */
const IDLE_UNLOAD = "5 minutes";

const KOKORO_NAME = "Kokoro 82M";
const KOKORO_SIZE = KOKORO_MODEL_FILES.reduce((total, file) => total + file.size, 0);

const isTextToSpeechError = Schema.is(TextToSpeechError);

// Store errors carry temp paths and URLs; Settings gets a reason and the log keeps the detail.
const describe = (cause: Cause.Cause<TextToSpeechError>) => {
  const error = Cause.squash(cause);
  const inner = isTextToSpeechError(error) ? error.cause : error;
  const tag = Predicate.hasProperty(inner, "_tag") ? inner._tag : undefined;
  if (tag === "SpeechModelDownloadError" && inner instanceof Error) return inner.message;
  if (tag === "PlatformError")
    return "Could not save the model. Check free disk space, then try again.";
  if (tag === "HttpError")
    return "Could not reach the download server. Check the connection, then try again.";
  return "The download failed. Try again.";
};

export const make = Effect.fn("TextToSpeech.make")(function* (
  load: (
    directory: string,
    signal: AbortSignal,
    pack: VoicePack.VoicePackInstall,
  ) => Promise<KokoroSpeaker> = (directory, signal, pack) =>
    loadKokoroSpeaker(directory, signal, { packRoot: pack.root }),
) {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const voicePack = yield* VoicePack.VoicePack;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  type Transfer = {
    downloaded: number;
    verifying: boolean;
    readonly fiber: Deferred.Deferred<Fiber.Fiber<string, TextToSpeechError>>;
  };
  let transfer: Transfer | undefined;
  let failure: string | undefined;
  // Settings and a call's first acquire share one transfer.
  const transferFiber = Effect.suspend(() => {
    if (transfer) return Deferred.await(transfer.fiber);
    const current: Transfer = { downloaded: 0, verifying: false, fiber: Deferred.makeUnsafe() };
    transfer = current;
    failure = undefined;
    let finished = 0;
    return Effect.forEach(KOKORO_MODEL_FILES, (file) =>
      store
        .download(file, {
          onProgress: (downloaded) => {
            current.downloaded = finished + downloaded;
          },
          onVerificationStart: () => {
            current.verifying = true;
          },
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished += file.size;
              current.downloaded = finished;
              current.verifying = false;
            }),
          ),
        ),
    ).pipe(
      // config.json sits at the model root that transformers.js reads from.
      Effect.map((installed) => path.dirname(installed[0]!)),
      Effect.mapError((cause) => new TextToSpeechError({ operation: "download", cause })),
      Effect.onExit((exit) => {
        if (transfer === current) transfer = undefined;
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        failure = describe(exit.cause);
        return Effect.logWarning("voice model download failed", { cause: exit.cause });
      }),
      Effect.forkIn(scope),
      Effect.tap((fiber) => Deferred.succeed(current.fiber, fiber)),
    );
  });
  const install = Effect.fn("TextToSpeech.install")(function* () {
    const exit = yield* Fiber.await(yield* transferFiber);
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      return yield* new TextToSpeechError({
        operation: "download",
        detail: "The download was cancelled.",
      });
    return yield* exit;
  });
  const acquire = Effect.fn("TextToSpeech.acquire")(function* () {
    // Held for the worker's life, so an upgrade never deletes files it has loaded.
    const pack = yield* voicePack.use.pipe(
      Effect.mapError((cause) => new TextToSpeechError({ operation: "load", cause })),
    );
    const directory = yield* install();
    return yield* Effect.tryPromise({
      try: (signal) => load(directory, signal, pack),
      catch: (cause) => new TextToSpeechError({ operation: "load", cause }),
    });
  });
  const speaker = yield* RcRef.make({
    acquire: Effect.acquireRelease(acquire(), (loaded) => Effect.promise(() => loaded.dispose())),
    idleTimeToLive: IDLE_UNLOAD,
  });
  const render = Effect.fn("TextToSpeech.renderSentence")(function* (
    loaded: KokoroSpeaker,
    sentence: string,
    voice: string,
  ) {
    return yield* Effect.tryPromise({
      try: () => loaded.speak(sentence, voice),
      catch: (cause) => new TextToSpeechError({ operation: "synthesize", cause }),
    });
  });
  const model = Effect.fn("TextToSpeech.model")(function* () {
    const ready = yield* Effect.forEach(KOKORO_MODEL_FILES, (file) => store.isReady(file), {
      concurrency: "unbounded",
    });
    const current = transfer;
    return {
      name: KOKORO_NAME,
      size: KOKORO_SIZE,
      state: current
        ? current.verifying
          ? "verifying"
          : "downloading"
        : ready.every(Boolean)
          ? "installed"
          : "downloadable",
      ...(current ? { downloaded: current.downloaded } : {}),
      ...(failure === undefined || current ? {} : { error: failure }),
    } satisfies EnvironmentVoiceTtsModel;
  });
  const cancel = Effect.suspend(() =>
    transfer ? Deferred.await(transfer.fiber).pipe(Effect.flatMap(Fiber.interrupt)) : Effect.void,
  );
  const download = Effect.fn("TextToSpeech.download")(function* () {
    yield* install();
    return yield* model();
  });
  const cancelDownload = Effect.fn("TextToSpeech.cancelDownload")(function* () {
    yield* cancel;
    return yield* model();
  });
  const remove = Effect.fn("TextToSpeech.remove")(function* () {
    yield* cancel;
    failure = undefined;
    yield* RcRef.invalidate(speaker);
    yield* Effect.forEach(KOKORO_MODEL_FILES, (file) => store.remove(file)).pipe(
      Effect.mapError((cause) => new TextToSpeechError({ operation: "remove", cause })),
    );
    return yield* model();
  });
  return TextToSpeech.of({
    model: model(),
    download: download(),
    cancelDownload: cancelDownload(),
    remove: remove(),
    sampleRate: KOKORO_SAMPLE_RATE,
    hold: RcRef.get(speaker).pipe(Effect.asVoid, Effect.withSpan("TextToSpeech.hold")),
    synthesize: (text, voice = KOKORO_DEFAULT_VOICE) =>
      Stream.unwrap(
        RcRef.get(speaker).pipe(
          Effect.map((loaded) =>
            Stream.fromIterable(splitSentences(text)).pipe(
              Stream.mapEffect((sentence) => render(loaded, sentence, voice)),
            ),
          ),
        ),
      ).pipe(Stream.withSpan("TextToSpeech.synthesize")),
  });
});

export const layer = Layer.effect(TextToSpeech, make());

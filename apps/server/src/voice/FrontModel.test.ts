import * as NodeServices from "@effect/platform-node/NodeServices";
import type { VoiceFrontModel } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import * as FrontModel from "./FrontModel.ts";
import type { FrontLlama } from "./llama.ts";
import * as VoicePack from "./pack/VoicePack.ts";

const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: () => Effect.succeed(true),
    installedPath: () => Effect.undefined,
    download: (file) => Effect.succeed(`/models/${file.filename}`),
    remove: () => Effect.void,
    fetch: () => Effect.die("not used"),
  }),
);

const services = (voiceFrontModel: VoiceFrontModel) =>
  Layer.mergeAll(
    store,
    NodeServices.layer,
    FetchHttpClient.layer,
    ServerSettings.ServerSettingsService.layerTest({ voiceFrontModel }),
    Layer.mock(VoicePack.VoicePack)({
      use: Effect.succeed({ root: "/voice-pack", gpu: "auto" as const }),
    }),
  );

const messages = [
  { role: "system", content: "You are the voice." },
  { role: "user", content: "run the test" },
] as const;

it.effect("loads a managed model once per call and unloads it after idling", () => {
  const loads: string[] = [];
  let disposed = 0;
  const replies = [
    `{"action":"delegate","speech":" On it. ","task":"Push the branch.","outward":true}`,
    `{"action":"none","speech":"mm-hm","task":"None.","outward":true}`,
    `{"action":"reply"`,
  ];
  const load = async (path: string): Promise<FrontLlama> => {
    loads.push(path);
    return {
      gpu: "cpu",
      decide: async () => replies.shift()!,
      dispose: async () => void (disposed += 1),
    };
  };
  return Effect.gen(function* () {
    const front = yield* FrontModel.make(load);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* front.acquire;
        expect(yield* session.decide(messages)).toEqual({
          action: "delegate",
          speech: "On it.",
          task: "Push the branch.",
          outward: true,
        });
        expect(yield* session.decide(messages)).toEqual({ action: "none", speech: "" });
        const error = yield* Effect.flip(session.decide(messages));
        expect(error.message).toContain("was not a decision");
      }),
    );
    yield* Effect.scoped(front.acquire);
    expect(loads).toEqual(["/models/Qwen3-1.7B-Q4_K_M.gguf"]);
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(1);
  }).pipe(Effect.provide(services("unsloth/Qwen3-1.7B-GGUF")));
});

it.effect("retries a failed load on the next call instead of caching the failure", () => {
  let attempts = 0;
  const load = async (): Promise<FrontLlama> => {
    attempts += 1;
    if (attempts === 1) throw new Error("no voice pack yet");
    return { gpu: "cpu", decide: async () => "{}", dispose: async () => {} };
  };
  return Effect.gen(function* () {
    const front = yield* FrontModel.make(load);
    yield* Effect.flip(Effect.scoped(front.acquire));
    yield* Effect.scoped(front.acquire);
    expect(attempts).toBe(2);
  }).pipe(Effect.provide(services("unsloth/Qwen3-1.7B-GGUF")));
});

it.effect("a call interrupted before the voice pack existed doesn't block later calls", () => {
  let packs = 0;
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const missing = yield* Deferred.make<void, VoicePack.VoicePackError>();
    const evicted = yield* Deferred.make<void>();
    const pack = Layer.mock(VoicePack.VoicePack)({
      use: Effect.suspend(() =>
        ++packs === 1
          ? Effect.addFinalizer(() => Deferred.succeed(evicted, undefined)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(missing)),
              Effect.as({ root: "", gpu: "auto" as const }),
            )
          : Effect.succeed({ root: "/voice-pack", gpu: "auto" as const }),
      ),
    });
    yield* Effect.gen(function* () {
      const front = yield* FrontModel.make(async () => ({
        gpu: "cpu",
        decide: async () => "{}",
        dispose: async () => {},
      }));
      // The voice failed first, so the call is interrupted while the front model still loads.
      const call = yield* Effect.forkChild(Effect.scoped(front.acquire));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(call);
      yield* Deferred.fail(missing, new VoicePack.VoicePackError({ operation: "load" }));
      // The failed load's scope closes only when its cache entry goes.
      yield* Deferred.await(evicted);
      yield* Effect.scoped(front.acquire);
    }).pipe(Effect.provide(Layer.mergeAll(services("unsloth/Qwen3-1.7B-GGUF"), pack)));
  });
});

it.effect("rejects a model id outside the catalog", () =>
  Effect.gen(function* () {
    const front = yield* FrontModel.make(() => Promise.reject(new Error("unreachable")));
    const error = yield* Effect.flip(Effect.scoped(front.acquire));
    expect(error.message).toContain('Unknown front model "someone/else"');
  }).pipe(Effect.provide(services("someone/else"))),
);

it.effect("shares one download between settings and a call, and cancels it for both", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(
      (_file, progress) =>
        Effect.sync(() => progress?.onProgress?.(1024)).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        ),
    );
    const front = yield* FrontModel.make(() => Promise.reject(new Error("not loaded"))).pipe(
      Effect.provideService(SpeechModelStore.SpeechModelStore, {
        isReady: () => Effect.succeed(false),
        installedPath: () => Effect.undefined,
        download,
        remove: () => Effect.void,
        fetch: () => Effect.die("not used"),
      }),
    );
    const id = "unsloth/Qwen3-1.7B-GGUF";
    // Started at once, so each is waiting on the transfer before the next step.
    const fromSettings = yield* Effect.forkChild(front.download(id), { startImmediately: true });
    yield* Deferred.await(started);
    const fromCall = yield* Effect.forkChild(Effect.scoped(front.acquire), {
      startImmediately: true,
    });
    expect((yield* front.models).models).toMatchObject([
      { id: "unsloth/Qwen3-4B-Instruct-2507-GGUF", recommended: true, state: "downloadable" },
      { id, active: true, state: "downloading", downloaded: 1024 },
    ]);
    const after = yield* front.cancelDownload(id);
    expect(after.models[1]).toMatchObject({ state: "downloadable" });
    const errors = [
      yield* Effect.flip(Fiber.join(fromSettings)),
      yield* Effect.flip(Fiber.join(fromCall)),
    ];
    for (const error of errors) expect(error.message).toContain("download was cancelled");
    expect(download).toHaveBeenCalledOnce();
    expect((yield* Effect.flip(front.download("someone/else")))._tag).toBe(
      "FrontModelNotFoundError",
    );
  }).pipe(Effect.provide(services("unsloth/Qwen3-1.7B-GGUF"))),
);

const endpoint = { url: "http://127.0.0.1:8080/v1/", model: "qwen" };
const completion = (content: string) =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

it.effect("sends the conversation to an OpenAI-compatible server under the decision schema", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () =>
      completion(`{"action":"reply","speech":"Hi there.","task":"","outward":false}`),
    );
    const front = yield* FrontModel.make();
    const decision = yield* Effect.scoped(
      Effect.flatMap(front.acquire, (session) => session.decide(messages)),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(decision).toEqual({ action: "reply", speech: "Hi there." });
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "qwen", messages, temperature: 0 });
    expect(body.response_format.json_schema.schema.required).toEqual([
      "action",
      "speech",
      "task",
      "outward",
    ]);
  }).pipe(Effect.provide(services(endpoint))),
);

it.effect.each([
  [
    "a failed request",
    async () => new Response("model not loaded", { status: 503 }),
    "answered 503: model not loaded",
  ],
  [
    "a reply outside the schema",
    async () => completion("Sure, on it!"),
    'Model "qwen" ignored the decision schema',
  ],
  [
    "a body that is not a completion",
    async () => Response.json({ error: "nope" }),
    "did not return a chat completion",
  ],
] as const)("explains %s from the server", ([, reply, message]) =>
  Effect.gen(function* () {
    const front = yield* FrontModel.make();
    const error = yield* Effect.flip(
      Effect.scoped(Effect.flatMap(front.acquire, (session) => session.decide(messages))),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, vi.fn<typeof fetch>(reply)));
    expect(error._tag).toBe("FrontModelError");
    expect(error.message).toContain(message);
  }).pipe(Effect.provide(services(endpoint))),
);

it.effect("interrupting a decision aborts the request", () =>
  Effect.gen(function* () {
    const aborted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const upstream = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          init?.signal?.addEventListener("abort", () => {
            aborted.resolve();
            reject(init.signal?.reason);
          });
        }),
    );
    const front = yield* FrontModel.make();
    const fiber = yield* Effect.scoped(
      Effect.flatMap(front.acquire, (session) => session.decide(messages)),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => aborted.promise);
  }).pipe(Effect.provide(services(endpoint))),
);

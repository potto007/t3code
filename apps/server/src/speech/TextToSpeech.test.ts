import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import type { KokoroSpeaker } from "./kokoro.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as TextToSpeech from "./TextToSpeech.ts";
import * as VoicePack from "../voice/pack/VoicePack.ts";

const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: () => Effect.succeed(true),
    installedPath: () => Effect.undefined,
    download: (file) => Effect.succeed(`/models/${file.directory}/${file.filename}`),
    remove: () => Effect.void,
    fetch: () => Effect.die("not used"),
  }),
);

it.effect("renders a chunk per sentence on one worker, unloaded once speech goes idle", () => {
  const loads: string[] = [];
  const spoken: string[] = [];
  let disposed = 0;
  const load = async (directory: string): Promise<KokoroSpeaker> => {
    loads.push(directory);
    return {
      speak: async (text, voice) => {
        spoken.push(`${voice}: ${text}`);
        return Float32Array.of(text.length);
      },
      dispose: async () => void (disposed += 1),
    };
  };
  return Effect.gen(function* () {
    const tts = yield* TextToSpeech.make(load);
    const first = yield* Stream.runCollect(tts.synthesize("Sure. Running the tests now."));
    expect(first.map((pcm) => [...pcm])).toEqual([[5], [22]]);
    yield* Stream.runDrain(tts.synthesize("Done.", "bm_george"));
    expect(spoken).toEqual([
      "af_heart: Sure.",
      "af_heart: Running the tests now.",
      "bm_george: Done.",
    ]);
    expect(loads).toEqual(["/models/kokoro-82m-v1.0-onnx"]);
    expect(disposed).toBe(0);
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(1);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* tts.hold;
        yield* TestClock.adjust("10 minutes");
        expect([loads.length, disposed]).toEqual([2, 1]);
      }),
    );
    yield* TestClock.adjust("5 minutes");
    expect(disposed).toBe(2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        store,
        NodeServices.layer,
        Layer.mock(VoicePack.VoicePack)({
          use: Effect.succeed({ root: "/voice-pack", gpu: "auto" as const }),
        }),
      ),
    ),
  );
});

const KOKORO_BYTES = 325_535_886;

/** A store whose files exist once downloaded; `download` runs the given step per file. */
const fileStore = (
  step: (
    file: SpeechModelStore.ModelFile,
    progress?: { readonly onProgress?: (downloaded: number) => void },
  ) => Effect.Effect<void, PlatformError.PlatformError>,
) => {
  const installed = new Set<string>();
  const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(
    (file, progress) =>
      step(file, progress).pipe(
        Effect.tap(() => Effect.sync(() => installed.add(file.filename))),
        Effect.as(`/models/${file.directory}/${file.filename}`),
      ),
  );
  const remove = vi.fn((file: SpeechModelStore.ModelFile) =>
    Effect.sync(() => void installed.delete(file.filename)),
  );
  return {
    download,
    remove,
    layer: Layer.succeed(
      SpeechModelStore.SpeechModelStore,
      SpeechModelStore.SpeechModelStore.of({
        isReady: (file) => Effect.sync(() => installed.has(file.filename)),
        installedPath: () => Effect.undefined,
        download,
        remove,
        fetch: () => Effect.die("not used"),
      }),
    ),
  };
};

const services = (store: Layer.Layer<SpeechModelStore.SpeechModelStore>) =>
  Layer.mergeAll(
    store,
    NodeServices.layer,
    Layer.mock(VoicePack.VoicePack)({
      use: Effect.succeed({ root: "/voice-pack", gpu: "auto" as const }),
    }),
  );

const speaker = async (): Promise<KokoroSpeaker> => ({
  speak: async () => new Float32Array(1),
  dispose: async () => {},
});

it.effect("shares one download between settings and a call, and cancels it for both", () => {
  const files = fileStore((file, progress) =>
    file.filename === "onnx/model.onnx"
      ? Effect.sync(() => progress?.onProgress?.(1024)).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        )
      : Effect.void,
  );
  const started = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const tts = yield* TextToSpeech.make(speaker);
    expect(yield* tts.model).toEqual({
      name: "Kokoro 82M",
      size: KOKORO_BYTES,
      state: "downloadable",
    });
    const fromSettings = yield* Effect.forkChild(tts.download, { startImmediately: true });
    yield* Deferred.await(started);
    const fromCall = yield* Effect.forkChild(Effect.scoped(tts.hold), { startImmediately: true });
    // The three small files are done, so progress counts them too.
    expect(yield* tts.model).toMatchObject({ state: "downloading", downloaded: 3654 + 1024 });
    expect(yield* tts.cancelDownload).toEqual({
      name: "Kokoro 82M",
      size: KOKORO_BYTES,
      state: "downloadable",
    });
    expect((yield* Effect.flip(Fiber.join(fromSettings))).message).toContain(
      "download was cancelled",
    );
    expect((yield* Effect.flip(Fiber.join(fromCall))).message).toContain("download was cancelled");
    expect(files.download).toHaveBeenCalledTimes(4);
  }).pipe(Effect.scoped, Effect.provide(services(files.layer)));
});

it.effect("shows why a download failed until a retry, which a call can also make", () => {
  let attempts = 0;
  const files = fileStore((file) =>
    file.filename === "onnx/model.onnx" && ++attempts === 1
      ? Effect.fail(
          PlatformError.badArgument({
            module: "test",
            method: "download",
            description: "Speech model download failed: status 503.",
          }),
        )
      : Effect.void,
  );
  return Effect.gen(function* () {
    const tts = yield* TextToSpeech.make(speaker);
    const error = yield* Effect.flip(tts.download);
    expect(error.operation).toBe("download");
    expect(yield* tts.model).toMatchObject({
      state: "downloadable",
      error: expect.stringContaining("status 503"),
    });
    yield* Effect.scoped(tts.hold);
    expect(yield* tts.model).toEqual({
      name: "Kokoro 82M",
      size: KOKORO_BYTES,
      state: "installed",
    });
  }).pipe(Effect.scoped, Effect.provide(services(files.layer)));
});

it.effect("removes every model file and reloads from a fresh download", () => {
  const files = fileStore(() => Effect.void);
  let disposed = 0;
  return Effect.gen(function* () {
    const tts = yield* TextToSpeech.make(async () => ({
      speak: async () => new Float32Array(1),
      dispose: async () => void (disposed += 1),
    }));
    expect((yield* tts.download).state).toBe("installed");
    yield* Stream.runDrain(tts.synthesize("Hello."));
    expect((yield* tts.remove).state).toBe("downloadable");
    expect(files.remove.mock.calls.map(([file]) => file.filename)).toEqual([
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model.onnx",
    ]);
    expect(disposed).toBe(1);
    yield* Stream.runDrain(tts.synthesize("Hello again."));
    expect((yield* tts.model).state).toBe("installed");
  }).pipe(Effect.scoped, Effect.provide(services(files.layer)));
});

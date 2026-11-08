// @effect-diagnostics nodeBuiltinImport:off - fixture tarballs need gzip and their registry digests.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as SpeechModelStore from "../../speech/SpeechModelStore.ts";
import type { VoicePackHost, VoicePackManifest } from "./variant.ts";
import * as VoicePack from "./VoicePack.ts";

/** A one-file npm tarball: `package/<file>` holding `body`. */
const npmTarball = (file: string, body: string) => {
  const header = Buffer.alloc(512);
  header.write(`package/${file}`, 0, 100);
  header.write("0000644\0", 100, 8);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("0", 156, 1);
  header.write("ustar\x0000", 257, 8);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0`, 148, 7);
  const data = Buffer.from(body);
  return NodeZlib.gzipSync(
    Buffer.concat([
      header,
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
};

const served = new Map<string, Buffer>();
const pkg = (name: string, file: string, body: string) => {
  const url = `https://registry.example/${name}.tgz`;
  const bytes = npmTarball(file, body);
  served.set(url, bytes);
  return {
    path: `node_modules/${name}`,
    name,
    version: "1.0.0",
    url,
    sha512: NodeCrypto.createHash("sha512").update(bytes).digest("hex"),
    size: bytes.length,
  };
};

const manifest = {
  roots: { "kokoro-js": "1.0.0", "node-llama-cpp": "1.0.0" },
  packages: [
    pkg("kokoro-js", "index.js", "kokoro"),
    pkg("node-llama-cpp", "index.js", "llama"),
    { ...pkg("@node-llama-cpp/linux-x64", "bins/cpu.node", "cpu"), os: ["linux"], cpu: ["x64"] },
    {
      ...pkg("@node-llama-cpp/linux-x64-cuda", "bins/cuda.node", "cuda"),
      os: ["linux"],
      cpu: ["x64"],
    },
  ],
  cudaRuntime: [],
} as unknown as VoicePackManifest;

const host: VoicePackHost = {
  platform: "linux",
  arch: "x64",
  wsl: false,
  nvidiaDriver: 615,
  cudaRuntime: true,
  vulkan: false,
};

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body = served.get(request.url);
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: body ? 200 : 404,
          headers: body ? { "content-length": String(body.length) } : {},
        }),
      );
      return Object.defineProperty(response, "stream", {
        value: body ? Stream.make(new Uint8Array(body)) : Stream.empty,
      });
    }),
  ),
);

const services = SpeechModelStore.layer.pipe(
  Layer.provide(http),
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "voice-pack-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeEffectCrypto.layer)),
);

const open = (options: VoicePack.VoicePackOptions = {}) =>
  VoicePack.make({
    manifest,
    detect: async () => host,
    probe: async (_, gpu) => gpu,
    ...options,
  });

const packDirectories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const base = path.join(config.stateDir, "speech", "voice-pack");
  const names = yield* fs.readDirectory(base).pipe(Effect.orElseSucceed(() => []));
  return { base, names: names.filter((name) => name !== "current").sort() };
});

it.layer(services)("VoicePack", (it) => {
  it.effect("installs verified packages for the machine's variant and probes its GPU build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pack = yield* open();
      const before = yield* pack.status;
      expect(before).toMatchObject({ supported: true, state: "downloadable", variant: "cuda" });
      expect(before.cpuSize).toBeLessThan(before.size);
      const after = yield* pack.download("auto");
      expect(after).toMatchObject({ state: "installed", variant: "cuda", gpu: "cuda" });
      const install = yield* Effect.scoped(pack.use);
      expect(install.gpu).toBe("auto");
      expect(
        yield* fs.readFileString(
          `${install.root}/node_modules/@node-llama-cpp/linux-x64-cuda/bins/cuda.node`,
        ),
      ).toBe("cuda");
      expect(yield* fs.readFileString(`${install.root}/node_modules/kokoro-js/index.js`)).toBe(
        "kokoro",
      );
      // Nothing is left from the download: no tarballs, no staging directory.
      expect((yield* packDirectories).names).toEqual([install.root.split("/").at(-1)]);
      yield* pack.remove;
    }),
  );

  it.effect("offers no CPU download where the GPU build is the only one", () =>
    Effect.gen(function* () {
      const pack = yield* open({
        detect: async () => ({ ...host, platform: "darwin", arch: "arm64", nvidiaDriver: null }),
      });
      const status = yield* pack.status;
      expect(status).toMatchObject({ supported: true, variant: "metal" });
      expect(status.cpuSize).toBeUndefined();
    }),
  );

  it.effect("rejects a tarball whose sha512 differs before extracting anything", () =>
    Effect.gen(function* () {
      const [first, ...rest] = manifest.packages;
      const tampered = {
        ...manifest,
        packages: [{ ...first!, sha512: "0".repeat(128) }, ...rest],
      } as VoicePackManifest;
      const pack = yield* open({ manifest: tampered });
      const error = yield* Effect.flip(pack.download("auto"));
      expect(error._tag).toBe("VoicePackError");
      expect((yield* pack.status).state).toBe("downloadable");
      expect((yield* packDirectories).names).toEqual([]);
    }),
  );

  it.effect("records a GPU build that fails its probe and runs workers on the CPU", () =>
    Effect.gen(function* () {
      const pack = yield* open({
        probe: async () => {
          // The worker reports a stack, which the row must not show.
          throw new Error(
            "Error: libcudart.so.13: cannot open shared object file\n    at probe (file:///[eval1]:25:19)",
          );
        },
      });
      expect(yield* pack.download("auto")).toMatchObject({
        state: "installed",
        variant: "cuda",
        gpu: "cpu",
        gpuError: "libcudart.so.13: cannot open shared object file",
      });
      expect((yield* Effect.scoped(pack.use)).gpu).toBe(false);
      // Markers written before probes were trimmed still hold the stack.
      const fs = yield* FileSystem.FileSystem;
      const { base, names } = yield* packDirectories;
      const marker = `${base}/${names[0]}/.installed.json`;
      const stale = JSON.parse(yield* fs.readFileString(marker));
      stale.gpuError = "Error: libcudart.so.13: cannot open\n    at probe (file:///[eval1]:25:19)";
      yield* fs.writeFileString(marker, JSON.stringify(stale));
      expect((yield* pack.status).gpuError).toBe("libcudart.so.13: cannot open");
      yield* pack.remove;
    }),
  );

  it.effect("keeps a pack a worker holds until it is released, across remove and switching", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pack = yield* open();
      yield* pack.download("auto");
      const cuda = yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* pack.use;
          // Switching to the CPU pack installs beside the held one.
          expect(yield* pack.download("cpu")).toMatchObject({ state: "installed", variant: "cpu" });
          expect(yield* fs.exists(held.root)).toBe(true);
          expect((yield* packDirectories).names).toHaveLength(2);
          return held.root;
        }),
      );
      expect(yield* fs.exists(cuda)).toBe(false);
      expect((yield* packDirectories).names).toHaveLength(1);
      // Removing the pack a call holds marks it gone at once and deletes it after the call.
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* pack.use;
          expect((yield* pack.remove).state).toBe("downloadable");
          expect(yield* fs.exists(held.root)).toBe(true);
          return held.root;
        }),
      );
      expect(yield* fs.exists(root)).toBe(false);
      expect(yield* Effect.flip(Effect.scoped(pack.use))).toMatchObject({ operation: "load" });
    }),
  );
});

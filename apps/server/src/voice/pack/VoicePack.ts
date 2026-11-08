// @effect-diagnostics nodeBuiltinImport:off - the manifest hash needs a synchronous digest.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentVoicePack } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import * as SpeechModelStore from "../../speech/SpeechModelStore.ts";
import { probeFrontGpu } from "../llama.ts";
import { extractNpmTarball, extractWheelFiles } from "./extract.ts";
import { detectVoicePackHost } from "./host.ts";
import {
  chooseVoicePackPlan,
  cudaBuildDirectory,
  selectVoicePackFiles,
  VOICE_PACK_MANIFEST,
  voicePackEntryFilter,
  type VoicePackHost,
  type VoicePackManifest,
  type VoicePackPlan,
} from "./variant.ts";

export class VoicePackError extends Schema.TaggedError<VoicePackError>()("VoicePackError", {
  operation: Schema.Literals(["download", "load", "remove"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const base = `The voice pack failed to ${this.operation}.`;
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

/** An installed pack: workers resolve their modules from `root`. */
export interface VoicePackInstall {
  readonly root: string;
  /** False when the pack's GPU build failed its probe, so workers skip straight to the CPU. */
  readonly gpu: "auto" | false;
  /** Prepended to a worker's PATH: Windows finds a DLL's dependencies there, not beside it. */
  readonly libraryPath?: string;
}

export class VoicePack extends Context.Service<
  VoicePack,
  {
    readonly status: Effect.Effect<EnvironmentVoicePack>;
    /** Completes once the pack is installed and probed; progress shows in `status` meanwhile. */
    readonly download: (
      variant: "auto" | "cpu",
    ) => Effect.Effect<EnvironmentVoicePack, VoicePackError>;
    readonly cancelDownload: Effect.Effect<EnvironmentVoicePack>;
    /** Running calls keep their pack until they end; its files go when the last one releases it. */
    readonly remove: Effect.Effect<EnvironmentVoicePack, VoicePackError>;
    /** The installed pack, kept on disk until the scope closes. */
    readonly use: Effect.Effect<VoicePackInstall, VoicePackError, Scope.Scope>;
  }
>()("t3/voice/pack/VoicePack") {}

type Marker = {
  readonly variant: VoicePackPlan["variant"];
  readonly cudaRuntime: VoicePackPlan["cudaRuntime"];
  gpu?: string;
  gpuError?: string;
};
const MarkerJson = Schema.fromJsonString(
  Schema.Struct({
    variant: Schema.Literals(["cpu", "vulkan", "cuda", "metal"]),
    cudaRuntime: Schema.NullOr(Schema.Literals(["system", "download"])),
    gpu: Schema.optional(Schema.String),
    gpuError: Schema.optional(Schema.String),
  }),
);
const decodeMarker = Schema.decodeUnknownOption(MarkerJson);
const encodeMarker = Schema.encodeEffect(MarkerJson);
// Workers resolve from the pack root: findPackageJSON walks into its node_modules.
const PACK_PACKAGE_JSON = `{"name":"t3-voice-pack","private":true}\n`;

const MARKER = ".installed.json";
// Probe workers report a stack; markers written before that was trimmed still carry one.
const probeMessage = (message: string) => message.split("\n")[0]!.replace(/^Error: /, "");
const CURRENT = "current";
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Runs extraction until it settles, even when interrupted: a sibling package failing would
 * otherwise leave this one writing into the staging directory after it has been removed.
 */
const settle = (run: (signal: AbortSignal) => Promise<void>) =>
  Effect.callback<void, VoicePackError>((resume) => {
    const controller = new AbortController();
    const settled = run(controller.signal).then(
      () => resume(Effect.void),
      (cause) => resume(Effect.fail(new VoicePackError({ operation: "download", cause }))),
    );
    return Effect.promise(() => {
      controller.abort();
      return settled;
    });
  });

const packId = (manifest: VoicePackManifest, plan: VoicePackPlan) => {
  const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const runtime = plan.cudaRuntime === "download" ? "-cudart" : "";
  return `${hash.slice(0, 12)}-${plan.key}-${plan.variant}${runtime}`;
};

export interface VoicePackOptions {
  readonly manifest?: VoicePackManifest;
  readonly detect?: () => Promise<VoicePackHost>;
  /** Loads llama.cpp from the pack on its GPU build; resolves with the backend it ran on. */
  readonly probe?: (
    root: string,
    gpu: string,
    signal: AbortSignal,
    libraryPath?: string,
  ) => Promise<string>;
}

export const make = Effect.fn("VoicePack.make")(function* (options: VoicePackOptions = {}) {
  const manifest = options.manifest ?? VOICE_PACK_MANIFEST;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const detect = options.detect ?? (() => detectVoicePackHost(platform, arch));
  const probe = options.probe ?? probeFrontGpu;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const config = yield* ServerConfig.ServerConfig;
  const override = yield* Config.String("T3CODE_VOICE_PACK_DIR").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  // Worktrees share one pack through the override, so only the server's own directory is swept.
  const shared = Option.isSome(override);
  const base = Option.getOrElse(override, () => path.join(config.stateDir, "speech", "voice-pack"));
  const downloads = path.join(base, ".downloads");
  const scope = yield* Effect.scope;
  const host = yield* Effect.promise(detect).pipe(Effect.cached);

  const libraryPath = (root: string, variant: VoicePackPlan["variant"]) =>
    platform === "win32" && variant === "cuda"
      ? path.join(root, cudaBuildDirectory({ key: "win32-x64" }))
      : undefined;
  const hashPrefix = packId(manifest, { key: "", variant: "cpu", cudaRuntime: null }).slice(0, 12);
  const readCurrent = fs.readFileString(path.join(base, CURRENT)).pipe(
    Effect.map((id) => id.trim()),
    Effect.orElseSucceed(() => ""),
  );
  const readMarker = (id: string) =>
    fs.readFileString(path.join(base, id, MARKER)).pipe(
      Effect.map((text) => Option.getOrUndefined(decodeMarker(text))),
      Effect.map((marker) =>
        marker?.gpuError ? { ...marker, gpuError: probeMessage(marker.gpuError) } : marker,
      ),
      Effect.orElseSucceed(() => undefined),
    );
  /** The installed pack, if it was built from this app's manifest. */
  const installed = Effect.gen(function* () {
    const id = yield* readCurrent;
    if (!id.startsWith(`${hashPrefix}-`)) return undefined;
    const marker = yield* readMarker(id);
    return marker ? { id, marker } : undefined;
  });

  // Pack directories in use by workers, and those to delete once their last user leaves.
  const users = new Map<string, number>();
  const doomed = new Set<string>();
  const sweep = (id: string) =>
    users.get(id)
      ? Effect.sync(() => void doomed.add(id))
      : fs
          .remove(path.join(base, id), { recursive: true, force: true })
          .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => doomed.delete(id))));
  const sweepAllBut = Effect.fn("VoicePack.sweep")(function* (keep: string) {
    if (shared) return;
    for (const name of yield* fs.readDirectory(base).pipe(Effect.orElseSucceed(() => []))) {
      if (name !== keep && name !== CURRENT && name !== ".downloads") yield* sweep(name);
    }
  });
  // Nothing runs before the store opens, so leftovers from an earlier process are safe to drop.
  if (!shared) {
    yield* fs.remove(downloads, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* sweepAllBut(yield* readCurrent);
  }

  type Transfer = {
    readonly plan: VoicePackPlan;
    readonly size: number;
    readonly progress: Map<string, number>;
    /** Every file arrived and matched its digest; the pack is being probed and moved in. */
    verifying: boolean;
    readonly fiber: Deferred.Deferred<Fiber.Fiber<void, VoicePackError>>;
  };
  let transfer: Transfer | undefined;

  const install = Effect.fn("VoicePack.install")(function* (
    plan: VoicePackPlan,
    current: Transfer,
  ) {
    const id = packId(manifest, plan);
    yield* Effect.annotateCurrentSpan({ packId: id });
    const files = selectVoicePackFiles(plan, manifest);
    const staging = path.join(base, `${id}.${yield* random.uuidV4()}.partial`);
    const fetchOne = (key: string, file: SpeechModelStore.RemoteFile, destination: string) =>
      store.fetch(file, destination, {
        onProgress: (downloaded) => void current.progress.set(key, downloaded),
      });
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* Effect.forEach(
        files.packages,
        (entry) =>
          Effect.gen(function* () {
            const key = `${entry.name}@${entry.version}`;
            const tarball = yield* fetchOne(
              key,
              {
                id: key,
                url: entry.url,
                size: entry.size,
                digest: { algorithm: "sha512", hex: entry.sha512 },
              },
              path.join(downloads, `${entry.path.replaceAll("/", "+")}.tgz`),
            );
            // The digest matched before this point; extraction never sees unverified bytes.
            yield* settle((signal) =>
              extractNpmTarball(
                tarball,
                path.join(staging, entry.path),
                voicePackEntryFilter(entry.name, plan),
                signal,
              ),
            );
            yield* fs.remove(tarball, { force: true });
          }),
        { concurrency: DOWNLOAD_CONCURRENCY, discard: true },
      );
      yield* Effect.forEach(
        files.wheels,
        (wheel) =>
          Effect.gen(function* () {
            const key = `${wheel.name}@${wheel.version}`;
            const file = yield* fetchOne(
              key,
              {
                id: key,
                url: wheel.url,
                size: wheel.size,
                digest: { algorithm: "sha256", hex: wheel.sha256 },
              },
              path.join(downloads, `${wheel.name}-${wheel.version}.whl`),
            );
            yield* settle((signal) =>
              extractWheelFiles(
                file,
                path.join(staging, cudaBuildDirectory(plan)),
                [...wheel.files, wheel.license],
                signal,
              ),
            );
            yield* fs.remove(file, { force: true });
          }),
        { concurrency: DOWNLOAD_CONCURRENCY, discard: true },
      );
      current.verifying = true;
      yield* fs.writeFileString(path.join(staging, "package.json"), PACK_PACKAGE_JSON);
      const marker: Marker = { variant: plan.variant, cudaRuntime: plan.cudaRuntime };
      if (plan.variant !== "cpu") {
        // A GPU build that fails here would fail every call; record it and run on the CPU.
        const ran = yield* Effect.tryPromise({
          try: (signal) => probe(staging, plan.variant, signal, libraryPath(staging, plan.variant)),
          catch: (cause) => probeMessage(cause instanceof Error ? cause.message : String(cause)),
        }).pipe(
          Effect.match({
            onSuccess: (gpu) => (gpu === plan.variant ? undefined : `The build ran on ${gpu}.`),
            onFailure: (message) => message,
          }),
        );
        marker.gpu = ran === undefined ? plan.variant : "cpu";
        if (ran !== undefined) marker.gpuError = ran;
      }
      yield* fs.writeFileString(path.join(staging, MARKER), yield* encodeMarker(marker));
      if (users.get(id)) {
        // A reinstall of the pack a call is using: keep the live copy, drop the new one.
        yield* fs.remove(staging, { recursive: true, force: true });
      } else {
        yield* fs.remove(path.join(base, id), { recursive: true, force: true });
        yield* fs.rename(staging, path.join(base, id));
      }
      doomed.delete(id);
      yield* fs.writeFileString(path.join(base, CURRENT), id);
      yield* sweepAllBut(id);
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) => new VoicePackError({ operation: "download", cause })),
    );
  });

  const status = Effect.fn("VoicePack.status")(function* () {
    const facts = yield* host;
    const auto = chooseVoicePackPlan(facts);
    if (!auto) return { supported: false, state: "downloadable", variant: "cpu", size: 0 } as const;
    const current = transfer;
    const done = current ? undefined : yield* installed;
    // A transfer shows its own plan, an install what it holds, otherwise what a click would fetch.
    const plan: VoicePackPlan = current?.plan ?? (done ? { ...auto, ...done.marker } : auto);
    const files = selectVoicePackFiles(plan, manifest);
    // Apple Silicon has only the Metal build, so a CPU pick would fetch the same pack.
    const cpu = chooseVoicePackPlan(facts, "cpu");
    return {
      supported: true,
      state: current
        ? current.verifying
          ? "verifying"
          : "downloading"
        : done
          ? "installed"
          : "downloadable",
      variant: plan.variant,
      size: files.packageBytes + files.wheelBytes,
      ...(files.wheelBytes > 0 ? { cudaRuntimeSize: files.wheelBytes } : {}),
      ...(plan.variant !== "cpu" && cpu?.variant === "cpu"
        ? { cpuSize: selectVoicePackFiles(cpu, manifest).packageBytes }
        : {}),
      ...(current ? { downloaded: [...current.progress.values()].reduce((a, b) => a + b, 0) } : {}),
      ...(done?.marker.gpu ? { gpu: done.marker.gpu } : {}),
      ...(done?.marker.gpuError ? { gpuError: done.marker.gpuError } : {}),
    } satisfies EnvironmentVoicePack;
  });

  const transferFiber = (plan: VoicePackPlan) =>
    Effect.suspend(() => {
      if (transfer) return Deferred.await(transfer.fiber);
      const files = selectVoicePackFiles(plan, manifest);
      const current: Transfer = {
        plan,
        size: files.packageBytes + files.wheelBytes,
        progress: new Map(),
        verifying: false,
        fiber: Deferred.makeUnsafe(),
      };
      transfer = current;
      return install(plan, current).pipe(
        Effect.ensuring(
          Effect.sync(() => (transfer = undefined)).pipe(
            // A server sharing the directory may be mid-download in it.
            Effect.andThen(
              shared ? Effect.void : fs.remove(downloads, { recursive: true }).pipe(Effect.ignore),
            ),
          ),
        ),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Deferred.succeed(current.fiber, fiber)),
      );
    });

  const cancel = Effect.suspend(() =>
    transfer ? Deferred.await(transfer.fiber).pipe(Effect.flatMap(Fiber.interrupt)) : Effect.void,
  );

  return VoicePack.of({
    status: status(),
    download: Effect.fn("VoicePack.download")(function* (variant) {
      const plan = chooseVoicePackPlan(yield* host, variant);
      if (!plan)
        return yield* new VoicePackError({
          operation: "download",
          detail: "Voice calls aren't available on this platform.",
        });
      const exit = yield* Fiber.await(yield* transferFiber(plan));
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        return yield* new VoicePackError({
          operation: "download",
          detail: "The download was cancelled.",
        });
      yield* exit;
      return yield* status();
    }),
    cancelDownload: Effect.gen(function* () {
      yield* cancel;
      return yield* status();
    }).pipe(Effect.withSpan("VoicePack.cancelDownload")),
    remove: Effect.gen(function* () {
      yield* cancel;
      const id = yield* readCurrent;
      yield* fs
        .remove(path.join(base, CURRENT), { force: true })
        .pipe(Effect.mapError((cause) => new VoicePackError({ operation: "remove", cause })));
      if (id) yield* sweep(id);
      return yield* status();
    }).pipe(Effect.withSpan("VoicePack.remove")),
    use: Effect.acquireRelease(
      Effect.gen(function* () {
        const found = yield* installed;
        if (!found)
          return yield* new VoicePackError({
            operation: "load",
            detail: "Download the voice pack in Settings → Voice → Conversation.",
          });
        users.set(found.id, (users.get(found.id) ?? 0) + 1);
        const root = path.join(base, found.id);
        const libraries = libraryPath(root, found.marker.variant);
        return {
          id: found.id,
          root,
          gpu: found.marker.gpuError ? (false as const) : ("auto" as const),
          ...(libraries ? { libraryPath: libraries } : {}),
        };
      }),
      ({ id }) =>
        Effect.suspend(() => {
          const left = (users.get(id) ?? 1) - 1;
          if (left > 0) users.set(id, left);
          else users.delete(id);
          return left === 0 && doomed.has(id) ? sweep(id) : Effect.void;
        }),
    ).pipe(
      Effect.map(({ id: _, ...install }): VoicePackInstall => install),
      Effect.withSpan("VoicePack.use"),
    ),
  });
});

export const layer = Layer.effect(VoicePack, make());

import manifestJson from "./manifest.json" with { type: "json" };

export type VoicePackVariant = "cpu" | "vulkan" | "cuda" | "metal";

/** What the download-time choice depends on, gathered by `detectVoicePackHost`. */
export interface VoicePackHost {
  readonly platform: string;
  readonly arch: string;
  /** WSL's Vulkan is a deviceless software driver, so a GPU build there runs on the CPU. */
  readonly wsl: boolean;
  /** NVIDIA driver major version, or null without one. */
  readonly nvidiaDriver: number | null;
  /** libcudart, libcublas and libcublasLt 13 load from the system. */
  readonly cudaRuntime: boolean;
  readonly vulkan: boolean;
}

export interface VoicePackPlan {
  readonly key: string;
  readonly variant: VoicePackVariant;
  /** "download" adds NVIDIA's runtime wheels beside the CUDA build. */
  readonly cudaRuntime: "system" | "download" | null;
}

// node-llama-cpp's CUDA build targets CUDA 13, whose runtime needs driver 580 or newer.
const CUDA_MIN_DRIVER = 580;

// The CPU build stays beside each GPU build: llama.cpp falls back to it when the GPU fails.
const LLAMA_BUILDS: Record<string, Partial<Record<VoicePackVariant, readonly string[]>>> = {
  "linux-x64": {
    cpu: ["linux-x64"],
    vulkan: ["linux-x64", "linux-x64-vulkan"],
    cuda: ["linux-x64", "linux-x64-cuda"],
  },
  "linux-arm64": { cpu: ["linux-arm64"] },
  "win32-x64": {
    cpu: ["win-x64"],
    vulkan: ["win-x64", "win-x64-vulkan"],
    cuda: ["win-x64", "win-x64-cuda"],
  },
  "win32-arm64": { cpu: ["win-arm64"] },
  "darwin-arm64": { metal: ["mac-arm64-metal"] },
  "darwin-x64": { cpu: ["mac-x64"] },
};

/** The pack for this machine, or undefined where no llama.cpp build exists. */
export function chooseVoicePackPlan(
  host: VoicePackHost,
  preference: "auto" | "cpu" = "auto",
): VoicePackPlan | undefined {
  const key = `${host.platform}-${host.arch}`;
  const builds = LLAMA_BUILDS[key];
  if (!builds) return undefined;
  const plan = (variant: VoicePackVariant, cudaRuntime: VoicePackPlan["cudaRuntime"] = null) => ({
    key,
    variant,
    cudaRuntime,
  });
  if (builds.metal) return plan("metal");
  if (preference === "auto" && builds.cuda && (host.nvidiaDriver ?? 0) >= CUDA_MIN_DRIVER)
    return plan("cuda", host.cudaRuntime ? "system" : "download");
  if (preference === "auto" && builds.vulkan && host.vulkan && !host.wsl) return plan("vulkan");
  return plan("cpu");
}

export type VoicePackManifest = typeof manifestJson;
export type VoicePackPackage = VoicePackManifest["packages"][number];
export const VOICE_PACK_MANIFEST: VoicePackManifest = manifestJson;

/** npm packages and wheels a plan downloads, with the bytes each one costs. */
export function selectVoicePackFiles(
  plan: VoicePackPlan,
  manifest: VoicePackManifest = VOICE_PACK_MANIFEST,
) {
  const [platform, arch] = plan.key.split("-") as [string, string];
  const builds = new Set(
    (LLAMA_BUILDS[plan.key]?.[plan.variant] ?? []).map((name) => `@node-llama-cpp/${name}`),
  );
  const matches = (allowed: readonly string[] | undefined, value: string) =>
    allowed === undefined || allowed.includes(value);
  const packages = manifest.packages.filter((entry) =>
    entry.name.startsWith("@node-llama-cpp/")
      ? builds.has(entry.name)
      : matches("os" in entry ? entry.os : undefined, platform) &&
        matches("cpu" in entry ? entry.cpu : undefined, arch),
  );
  const wheels =
    plan.cudaRuntime === "download"
      ? manifest.cudaRuntime.map((wheel) => {
          const file = wheel.platforms[plan.key as keyof typeof wheel.platforms];
          return { name: wheel.name, version: wheel.version, license: wheel.license, ...file };
        })
      : [];
  return {
    packages,
    wheels,
    packageBytes: packages.reduce((total, entry) => total + entry.size, 0),
    wheelBytes: wheels.reduce((total, wheel) => total + wheel.size, 0),
  };
}

/** Skips onnxruntime-node's binaries for other platforms; the tarball carries all of them. */
export function voicePackEntryFilter(name: string, plan: VoicePackPlan) {
  if (name !== "onnxruntime-node") return undefined;
  const [platform, arch] = plan.key.split("-") as [string, string];
  return (path: string) =>
    !path.startsWith("bin/napi-v3/") || path.startsWith(`bin/napi-v3/${platform}/${arch}/`);
}

/** Where llama.cpp's CUDA build sits inside the pack; NVIDIA's runtime goes beside it. */
export function cudaBuildDirectory(plan: Pick<VoicePackPlan, "key">) {
  const build = plan.key === "win32-x64" ? "win-x64-cuda" : "linux-x64-cuda";
  return `node_modules/@node-llama-cpp/${build}/bins/${build}`;
}

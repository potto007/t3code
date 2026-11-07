// @effect-diagnostics nodeBuiltinImport:off - one-shot hardware probes outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { VoicePackHost } from "./variant.ts";

const run = (command: string, args: readonly string[]) =>
  new Promise<string>((resolve) => {
    NodeChildProcess.execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, out) =>
      resolve(error ? "" : out),
    );
  });

const exists = (file: string) => NodeFS.existsSync(file);

const CUDA_LIBRARIES = {
  linux: ["libcudart.so.13", "libcublas.so.13", "libcublasLt.so.13"],
  win32: ["cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll"],
} as const;

/** Facts the voice pack variant depends on. Only libraries the loader can find count. */
export async function detectVoicePackHost(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<VoicePackHost> {
  const wsl =
    platform === "linux" &&
    (NodeOS.release().toLowerCase().includes("microsoft") ||
      exists("/proc/sys/fs/binfmt_misc/WSLInterop"));
  const loaderCache = platform === "linux" ? await run("/sbin/ldconfig", ["-p"]) : "";
  const searchPath = ((platform === "win32" ? process.env.PATH : process.env.LD_LIBRARY_PATH) ?? "")
    .split(NodePath.delimiter)
    .filter(Boolean);
  const findable = (library: string) =>
    loaderCache.includes(`${library} `) ||
    searchPath.some((directory) => exists(NodePath.join(directory, library)));

  let driver = "";
  if (platform === "linux" && !wsl && exists("/proc/driver/nvidia/version")) {
    const version = NodeFS.readFileSync("/proc/driver/nvidia/version", "utf8");
    driver = /Kernel Module\s+(?:for \S+\s+)?(\d+)\./.exec(version)?.[1] ?? "";
  }
  if (!driver && (platform === "linux" || platform === "win32")) {
    const smi =
      wsl && exists("/usr/lib/wsl/lib/nvidia-smi") ? "/usr/lib/wsl/lib/nvidia-smi" : "nvidia-smi";
    driver =
      /^(\d+)\./.exec(
        (await run(smi, ["--query-gpu=driver_version", "--format=csv,noheader"])).trim(),
      )?.[1] ?? "";
  }
  const libraries = platform === "linux" || platform === "win32" ? CUDA_LIBRARIES[platform] : [];
  return {
    platform,
    arch,
    wsl,
    nvidiaDriver: driver ? Number(driver) : null,
    cudaRuntime: libraries.length > 0 && libraries.every(findable),
    vulkan:
      platform === "linux"
        ? loaderCache.includes("libvulkan.so.1 ")
        : platform === "win32" &&
          exists(
            NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "vulkan-1.dll"),
          ),
  };
}

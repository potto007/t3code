import { expect, it } from "vite-plus/test";

import {
  chooseVoicePackPlan,
  selectVoicePackFiles,
  voicePackEntryFilter,
  type VoicePackHost,
} from "./variant.ts";

const host = (overrides: Partial<VoicePackHost>): VoicePackHost => ({
  platform: "linux",
  arch: "x64",
  wsl: false,
  nvidiaDriver: null,
  cudaRuntime: false,
  vulkan: false,
  ...overrides,
});

it.each([
  ["linux, no GPU", host({}), "auto", "cpu", null],
  ["linux, Vulkan loader", host({ vulkan: true }), "auto", "vulkan", null],
  [
    "linux, driver and toolkit",
    host({ nvidiaDriver: 580, cudaRuntime: true }),
    "auto",
    "cuda",
    "system",
  ],
  ["linux, driver only", host({ nvidiaDriver: 615 }), "auto", "cuda", "download"],
  ["linux, driver too old", host({ nvidiaDriver: 575, vulkan: true }), "auto", "vulkan", null],
  ["linux, driver too old, no Vulkan", host({ nvidiaDriver: 550 }), "auto", "cpu", null],
  ["linux, driver only, CPU chosen", host({ nvidiaDriver: 615 }), "cpu", "cpu", null],
  ["WSL, driver only", host({ wsl: true, nvidiaDriver: 615 }), "auto", "cuda", "download"],
  [
    "WSL, driver and toolkit",
    host({ wsl: true, nvidiaDriver: 615, cudaRuntime: true }),
    "auto",
    "cuda",
    "system",
  ],
  [
    "WSL, driver too old",
    host({ wsl: true, nvidiaDriver: 560, vulkan: true }),
    "auto",
    "cpu",
    null,
  ],
  [
    "windows, driver only",
    host({ platform: "win32", nvidiaDriver: 581 }),
    "auto",
    "cuda",
    "download",
  ],
  ["windows, Vulkan", host({ platform: "win32", vulkan: true }), "auto", "vulkan", null],
  [
    "linux arm64, driver",
    host({ arch: "arm64", nvidiaDriver: 615, vulkan: true }),
    "auto",
    "cpu",
    null,
  ],
  ["macOS arm64", host({ platform: "darwin", arch: "arm64" }), "auto", "metal", null],
  ["macOS arm64, CPU chosen", host({ platform: "darwin", arch: "arm64" }), "cpu", "metal", null],
  ["macOS x64", host({ platform: "darwin", arch: "x64" }), "auto", "cpu", null],
] as const)("%s -> %s", (_, facts, preference, variant, cudaRuntime) => {
  expect(chooseVoicePackPlan(facts, preference)).toMatchObject({ variant, cudaRuntime });
});

it("has no pack where llama.cpp has no build", () => {
  expect(chooseVoicePackPlan(host({ arch: "riscv64" }))).toBeUndefined();
  expect(chooseVoicePackPlan(host({ platform: "freebsd" }))).toBeUndefined();
});

it("downloads one llama.cpp build per variant, the CPU fallback, and the runtime only when missing", () => {
  const llama = (facts: VoicePackHost, preference: "auto" | "cpu" = "auto") => {
    const files = selectVoicePackFiles(chooseVoicePackPlan(facts, preference)!);
    return {
      builds: files.packages
        .filter((entry) => entry.name.startsWith("@node-llama-cpp/"))
        .map((entry) => entry.name.slice("@node-llama-cpp/".length)),
      wheels: files.wheels.map((wheel) => wheel.name),
    };
  };
  expect(llama(host({ nvidiaDriver: 615 }))).toEqual({
    builds: ["linux-x64", "linux-x64-cuda"],
    wheels: ["nvidia-cuda-runtime", "nvidia-cublas"],
  });
  expect(llama(host({ nvidiaDriver: 615, cudaRuntime: true }))).toEqual({
    builds: ["linux-x64", "linux-x64-cuda"],
    wheels: [],
  });
  expect(llama(host({ nvidiaDriver: 615 }), "cpu")).toEqual({ builds: ["linux-x64"], wheels: [] });
  expect(llama(host({ platform: "win32", vulkan: true }))).toEqual({
    builds: ["win-x64", "win-x64-vulkan"],
    wheels: [],
  });
  expect(llama(host({ platform: "darwin", arch: "arm64" }))).toEqual({
    builds: ["mac-arm64-metal"],
    wheels: [],
  });
});

it("pins every package by sha512 and leaves sharp, onnxruntime-web and cuda-ext out", () => {
  const plan = chooseVoicePackPlan(host({ nvidiaDriver: 615 }))!;
  const { packages } = selectVoicePackFiles(plan);
  const names = packages.map((entry) => entry.name);
  expect(names).toEqual(expect.arrayContaining(["kokoro-js", "node-llama-cpp", "phonemizer"]));
  for (const removed of ["sharp", "onnxruntime-web", "@node-llama-cpp/linux-x64-cuda-ext"])
    expect(names).not.toContain(removed);
  for (const entry of packages) {
    expect(entry.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(entry.url).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  }
});

it("extracts only this platform's ONNX Runtime binaries", () => {
  const include = voicePackEntryFilter("onnxruntime-node", chooseVoicePackPlan(host({}))!)!;
  expect(include("dist/index.js")).toBe(true);
  expect(include("bin/napi-v3/linux/x64/libonnxruntime.so.1")).toBe(true);
  expect(include("bin/napi-v3/linux/arm64/libonnxruntime.so.1")).toBe(false);
  expect(include("bin/napi-v3/win32/x64/onnxruntime.dll")).toBe(false);
  expect(voicePackEntryFilter("kokoro-js", chooseVoicePackPlan(host({}))!)).toBeUndefined();
});

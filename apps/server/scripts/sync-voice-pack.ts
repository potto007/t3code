// @effect-diagnostics nodeBuiltinImport:off - standalone manifest generation uses Node I/O and npm.
// @effect-diagnostics globalConsole:off - standalone maintenance command output.
// @effect-diagnostics globalFetch:off - a one-off script outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Pins the voice runtime that calls download into T3 home. npm resolves the exact tree once here;
 * its lockfile layout is the layout the pack extracts, so Node resolves modules in it unchanged.
 */
const ROOTS = { "kokoro-js": "1.2.1", "node-llama-cpp": "3.22.3" } as const;

// transformers.js loads sharp only for images and onnxruntime-web only in browsers; the worker
// stubs sharp. node-llama-cpp's reflink helper serves its unused model downloader. The cuda-ext
// builds are CUDA 12 fallbacks of the CUDA 13 build, 416 MB each.
const REMOVED = new Set([
  "@huggingface/transformers>sharp",
  "@huggingface/transformers>onnxruntime-web",
  "node-llama-cpp>@reflink/reflink",
  "node-llama-cpp>@node-llama-cpp/linux-x64-cuda-ext",
  "node-llama-cpp>@node-llama-cpp/win-x64-cuda-ext",
]);

// NVIDIA's redistributable CUDA 13 runtime, for machines with a driver but no toolkit.
const CUDA_WHEELS = [
  {
    name: "nvidia-cuda-runtime",
    version: "13.5.37",
    files: {
      "linux-x64": ["nvidia/cu13/lib/libcudart.so.13"],
      "win32-x64": ["nvidia/cu13/bin/x86_64/cudart64_13.dll"],
    },
  },
  {
    name: "nvidia-cublas",
    version: "13.10.0.20",
    files: {
      "linux-x64": ["nvidia/cu13/lib/libcublas.so.13", "nvidia/cu13/lib/libcublasLt.so.13"],
      "win32-x64": [
        "nvidia/cu13/bin/x86_64/cublas64_13.dll",
        "nvidia/cu13/bin/x86_64/cublasLt64_13.dll",
      ],
    },
  },
] as const;

type LockEntry = {
  readonly name?: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  readonly os?: string[];
  readonly cpu?: string[];
  readonly libc?: string[];
};

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-voice-pack-"));
try {
  NodeFS.writeFileSync(
    NodePath.join(directory, "package.json"),
    JSON.stringify({ name: "t3-voice-pack", private: true, dependencies: ROOTS }),
  );
  NodeChildProcess.execFileSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: directory, stdio: "inherit" },
  );
  const lock = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, LockEntry> };

  const nameOf = (key: string) => key.slice(key.lastIndexOf("node_modules/") + 13);
  const resolve = (from: string, name: string) => {
    for (let base = from; ;) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      if (!base) return undefined;
      base = base.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, "");
    }
  };
  const reached = new Set<string>();
  const visit = (key: string) => {
    const entry = lock.packages[key]!;
    const parent = key === "" ? "" : nameOf(key);
    const edges = [
      ...Object.keys(entry.dependencies ?? {}).map((name) => [name, false] as const),
      ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, true] as const),
      ...Object.keys(entry.peerDependencies ?? {}).map(
        (name) => [name, entry.peerDependenciesMeta?.[name]?.optional === true] as const,
      ),
    ];
    for (const [name, optional] of edges) {
      if (REMOVED.has(`${parent}>${name}`)) continue;
      const target = resolve(key, name);
      if (!target) {
        if (optional) continue;
        throw new Error(`${key || "root"} depends on ${name}, which npm did not resolve.`);
      }
      if (reached.has(target)) continue;
      reached.add(target);
      visit(target);
    }
  };
  visit("");

  // The registry answers HEAD without a length; a one-byte range reports the total.
  const head = async (url: string) => {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    await response.body?.cancel();
    const length = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
    if (response.status !== 206 || !Number.isSafeInteger(length) || length <= 0)
      throw new Error(`Could not size ${url}.`);
    return length;
  };
  const keys = [...reached].sort();
  const packages = [];
  for (let index = 0; index < keys.length; index += 16) {
    packages.push(
      ...(await Promise.all(
        keys.slice(index, index + 16).map(async (key) => {
          const entry = lock.packages[key]!;
          if (!entry.integrity.startsWith("sha512-"))
            throw new Error(`${key} has no sha512 integrity.`);
          return {
            path: key,
            name: entry.name ?? nameOf(key),
            version: entry.version,
            url: entry.resolved,
            sha512: Buffer.from(entry.integrity.slice(7), "base64").toString("hex"),
            size: await head(entry.resolved),
            ...(entry.os ? { os: entry.os } : {}),
            ...(entry.cpu ? { cpu: entry.cpu } : {}),
            ...(entry.libc ? { libc: entry.libc } : {}),
          };
        }),
      )),
    );
  }

  const cudaRuntime = await Promise.all(
    CUDA_WHEELS.map(async (wheel) => {
      const release = (await (
        await fetch(`https://pypi.org/pypi/${wheel.name}/${wheel.version}/json`)
      ).json()) as {
        urls: { filename: string; url: string; size: number; digests: { sha256: string } }[];
      };
      const pick = (tag: string) => {
        const file = release.urls.find((candidate) => candidate.filename.includes(tag));
        if (!file) throw new Error(`${wheel.name} ${wheel.version} has no ${tag} wheel.`);
        return { url: file.url, sha256: file.digests.sha256, size: file.size };
      };
      return {
        name: wheel.name,
        version: wheel.version,
        license: `${wheel.name.replaceAll("-", "_")}-${wheel.version}.dist-info/licenses/License.txt`,
        platforms: {
          "linux-x64": { ...pick("manylinux"), files: wheel.files["linux-x64"] },
          "win32-x64": { ...pick("win_amd64"), files: wheel.files["win32-x64"] },
        },
      };
    }),
  );

  const target = new URL("../src/voice/pack/manifest.json", import.meta.url);
  NodeFS.writeFileSync(
    target,
    `${JSON.stringify({ roots: ROOTS, packages, cudaRuntime }, null, 2)}\n`,
  );
  console.log(`Pinned ${packages.length} packages and ${cudaRuntime.length} CUDA runtime wheels.`);
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

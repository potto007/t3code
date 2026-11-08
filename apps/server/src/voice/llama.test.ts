// @effect-diagnostics nodeBuiltinImport:off - fixture packs are plain files the worker reads from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { loadFrontLlama, probeFrontGpu } from "./llama.ts";

// Replies with the last message; "hang" generates until the worker aborts it.
const fixture = `data:text/javascript,${encodeURIComponent(`
  export const load = async ({ path, gpu, schema }) => ({
    // Forks made while loading must not inherit the worker's own entry.
    gpu: \`\${gpu === false ? "cpu" : "fake"} \${JSON.stringify(process.execArgv)}\`,
    decide: (messages, signal, onTextChunk) => {
      const last = messages.at(-1).content;
      if (last !== "hang") {
        const text = JSON.stringify({ path, last, keys: schema.required });
        for (let at = 0; at < text.length; at += 7) onTextChunk(text.slice(at, at + 7));
        return Promise.resolve(text);
      }
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
`)}`;

it("decides from an isolated process and keeps working after an interrupted decision", async () => {
  const llama = await loadFrontLlama("/models/front.gguf", new AbortController().signal, {
    moduleUrl: fixture,
  });
  try {
    expect(llama.gpu).toBe("fake []");
    const interrupted = new AbortController();
    const hung = llama.decide([{ role: "user", content: "hang" }], interrupted.signal);
    const chunks: string[] = [];
    const next = llama.decide(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
      (chunk) => chunks.push(chunk),
    );
    interrupted.abort(new Error("barge-in"));
    await expect(hung).rejects.toThrow("barge-in");
    // The queued decision only runs once the worker has dropped the interrupted one.
    const text = await next;
    // Generation streams in order, all of it before the decision resolves.
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(text)).toEqual({
      path: "/models/front.gguf",
      last: "hi",
      keys: ["action", "speech", "task", "outward"],
    });
  } finally {
    await llama.dispose();
  }
});

it("abort kills the process and fails the decision in flight", async () => {
  const controller = new AbortController();
  const llama = await loadFrontLlama("unused", controller.signal, { moduleUrl: fixture });
  const hung = llama.decide([{ role: "user", content: "hang" }], new AbortController().signal);
  controller.abort();
  await expect(hung).rejects.toThrow("Front model process stopped.");
  await expect(
    llama.decide([{ role: "user", content: "later" }], new AbortController().signal),
  ).rejects.toThrow("Front model process stopped.");
  await llama.dispose();
});

it("probes llama.cpp's GPU build from the voice pack", async () => {
  const packRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-voice-pack-"));
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(packRoot, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(packRoot, file), text);
  };
  write("package.json", `{"name":"t3-voice-pack","private":true}`);
  write("node_modules/node-llama-cpp/package.json", `{"name":"node-llama-cpp","type":"module"}`);
  // Vulkan without a device reports no VRAM, as in WSL.
  write(
    "node_modules/node-llama-cpp/dist/index.js",
    `export const getLlama = async ({ gpu }) => ({ gpu,
      getVramState: async () => ({ total: gpu === "vulkan" ? 0 : 1 }), dispose: async () => {} });`,
  );
  write(
    "node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js",
    "export const getGbnfGrammarForGbnfJsonSchema = () => '';",
  );
  try {
    expect(await probeFrontGpu(packRoot, "cuda", new AbortController().signal)).toBe("cuda");
    await expect(probeFrontGpu(packRoot, "vulkan", new AbortController().signal)).rejects.toThrow(
      "The vulkan build found no GPU device.",
    );
  } finally {
    NodeFS.rmSync(packRoot, { recursive: true, force: true });
  }
});

// @effect-diagnostics nodeBuiltinImport:off - fixture packs are plain files the worker reads from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { loadKokoroSpeaker } from "./kokoro.ts";

// Each sentence renders as one sample holding its length; "hang" never finishes.
const fixture = `data:text/javascript,${encodeURIComponent(`
  export const KokoroTTS = { from_pretrained: async (path, options) => ({
    generate: (text, { voice }) => text === "hang" ? new Promise(() => {}) :
      Promise.resolve({ audio: Float32Array.of(text.length + voice.length), sampling_rate: 24000 }),
  }) };
`)}`;

it("renders queued sentences in order from an isolated process", async () => {
  const speaker = await loadKokoroSpeaker("unused", new AbortController().signal, {
    moduleUrl: fixture,
  });
  try {
    const rendered = await Promise.all([speaker.speak("one", "v"), speaker.speak("three", "vv")]);
    expect(rendered.map((pcm) => [...pcm])).toEqual([[4], [7]]);
  } finally {
    await speaker.dispose();
  }
});

it("abort kills the process and fails the sentence in flight", async () => {
  const controller = new AbortController();
  const speaker = await loadKokoroSpeaker("unused", controller.signal, { moduleUrl: fixture });
  const hung = speaker.speak("hang", "v");
  controller.abort();
  await expect(hung).rejects.toThrow("Speech synthesis process stopped.");
  await expect(speaker.speak("later", "v")).rejects.toThrow("Speech synthesis process stopped.");
  await speaker.dispose();
});

it("loads kokoro-js and its transformers.js from the voice pack, never the hub", async () => {
  const packRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-voice-pack-"));
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(packRoot, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(packRoot, file), text);
  };
  write("package.json", `{"name":"t3-voice-pack","private":true}`);
  write("node_modules/kokoro-js/package.json", `{"name":"kokoro-js","main":"dist/kokoro.cjs"}`);
  write(
    "node_modules/kokoro-js/dist/kokoro.cjs",
    `const { env } = require("@huggingface/transformers");
    exports.KokoroTTS = { from_pretrained: async () => ({ generate: async (text) => ({
      audio: Float32Array.of(env.allowRemoteModels ? -1 : text.length), sampling_rate: 24000 }) }) };`,
  );
  write(
    "node_modules/@huggingface/transformers/package.json",
    `{"name":"@huggingface/transformers"}`,
  );
  write(
    "node_modules/@huggingface/transformers/index.js",
    `exports.env = { allowRemoteModels: true };`,
  );
  const speaker = await loadKokoroSpeaker("unused", new AbortController().signal, { packRoot });
  try {
    expect([...(await speaker.speak("four", "v"))]).toEqual([4]);
  } finally {
    await speaker.dispose();
    NodeFS.rmSync(packRoot, { recursive: true, force: true });
  }
});

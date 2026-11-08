// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

import { FRONT_DECISION_JSON_SCHEMA } from "./decision.ts";
import type { FrontMessage } from "./FrontModel.ts";

// node-llama-cpp is ESM with top-level await, so it loads with import() from its disk entry in the
// voice pack. The engine is the seam tests replace through moduleUrl.
const loaderEntry = `
  const loadEngine = async (moduleUrl, packRoot) => {
    if (moduleUrl) return await import(moduleUrl);
    const { findPackageJSON } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const packagePath =
      findPackageJSON("node-llama-cpp", pathToFileURL(join(packRoot, "package.json")));
    if (!packagePath) throw new Error("The voice pack has no front model package.");
    const fromPackage = (file) => import(pathToFileURL(join(dirname(packagePath), file)).href);
    const llamaCpp = await fromPackage("dist/index.js");
    const { getGbnfGrammarForGbnfJsonSchema } =
      await fromPackage("dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js");
    const { availableParallelism } = await import("node:os");
    // Speech recognition and synthesis share the CPU during a call; llama.cpp spins every
    // thread it owns, and oversubscribed it slows by an order of magnitude.
    const options = { build: "never", skipDownload: true, progressLogs: false, logLevel: "error",
      maxThreads: Math.max(1, Math.floor(availableParallelism() / 2)) };
    return {
      // Loads exactly one GPU build, so a missing CUDA runtime fails here instead of falling back.
      probe: async (gpu) => {
        const llama = await llamaCpp.getLlama({ ...options, gpu });
        try {
          if (llama.gpu && (await llama.getVramState()).total === 0)
            throw new Error(\`The \${gpu} build found no GPU device.\`);
          return String(llama.gpu || "cpu");
        } finally {
          await llama.dispose();
        }
      },
      load: async ({ path, gpu, schema }) => {
        let llama = await llamaCpp.getLlama({ ...options, gpu });
        // A GPU build can load with no usable device (Vulkan with only a software driver, as in
        // WSL) and then runs slower than the CPU build.
        if (llama.gpu && (await llama.getVramState()).total === 0) {
          await llama.dispose();
          llama = await llamaCpp.getLlama({ ...options, gpu: false });
        }
        const model = await llama.loadModel({ modelPath: path });
        const context = await model.createContext({ contextSize: 8192 });
        // Thinking would spend the latency budget before the first decision token.
        const chatWrapper = llamaCpp.resolveChatWrapper(model, { customWrapperSettings: {
          qwen: { thoughts: "discourage" }, gemma4: { reasoning: false } } });
        const chat = new llamaCpp.LlamaChat({ contextSequence: context.getSequence(), chatWrapper });
        // Compact JSON: indentation would cost a decode step per whitespace token.
        const grammar = new llamaCpp.LlamaGrammar(llama, {
          grammar: getGbnfGrammarForGbnfJsonSchema(schema, { allowNewLines: false }),
          stopGenerationTriggers: [llamaCpp.LlamaText(["\\n\\n\\n\\n"])], trimWhitespaceSuffix: true });
        return {
          gpu: llama.gpu || "cpu",
          // The context sequence keeps its tokens, so a history that extends the last one only
          // evaluates the new messages.
          decide: async (messages, signal, onTextChunk) => {
            const history = messages.map((message) => message.role === "assistant"
              ? { type: "model", response: [message.content] }
              : { type: message.role, text: message.content });
            history.push({ type: "model", response: [] });
            const result = await chat.generateResponse(history,
              { grammar, signal, temperature: 0, maxTokens: 512, onTextChunk });
            return result.response;
          },
        };
      },
    };
  };
`;

const entry = `
// node-llama-cpp probes each prebuilt binary in a fork that inherits execArgv; this worker's "-e"
// entry, or a Node SEA's baked-in flags, would displace the probe script and fail every binary.
process.execArgv.splice(0);
let engine;
let running = Promise.resolve();
const controllers = new Map();
const reply = (message) => process.send({ type: "t3-front-reply", ...message });
const failure = (error) => error instanceof Error ? error.stack ?? error.message : String(error);
process.on("message", async (message) => {
  if (message.kind === "probe") {
    try {
      const gpu = await (await loadEngine(message.moduleUrl, message.packRoot)).probe(message.gpu);
      reply({ id: message.id, ok: true, gpu });
    } catch (error) {
      reply({ id: message.id, ok: false, error: failure(error) });
    }
  } else if (message.kind === "load") {
    try {
      engine = await (await loadEngine(message.moduleUrl, message.packRoot)).load(message);
      reply({ id: message.id, ok: true, gpu: String(engine.gpu) });
    } catch (error) {
      reply({ id: message.id, ok: false, error: failure(error) });
    }
  } else if (message.kind === "abort") {
    controllers.get(message.id)?.abort();
  } else if (message.kind === "decide") {
    const controller = new AbortController();
    controllers.set(message.id, controller);
    // One sequence holds the KV cache, so decisions run one at a time.
    running = running.then(async () => {
      try {
        if (controller.signal.aborted) throw new Error("Aborted.");
        const onTextChunk = (text) => process.send({ type: "t3-front-chunk", id: message.id, text });
        reply({ id: message.id, ok: true,
          text: await engine.decide(message.messages, controller.signal, onTextChunk) });
      } catch (error) {
        reply({ id: message.id, ok: false, error: failure(error) });
      } finally {
        controllers.delete(message.id);
      }
    });
  }
});
process.on("disconnect", () => process.exit(0));
`;

export async function runFrontModelWorker() {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function(
    `return (async () => {${loaderEntry}${entry}})();`,
  ) as () => Promise<void>;
  await run();
}

function frontWorkerArgs() {
  if (NodeSea.isSea()) return ["__speech-worker", "front"];
  return ["--input-type=module", "-e", loaderEntry + entry];
}

type Reply = {
  readonly type: "t3-front-reply";
  readonly id: number;
  readonly ok: boolean;
  readonly text?: string;
  readonly gpu?: string;
  readonly error?: string;
};

export type FrontLlama = Awaited<ReturnType<typeof loadFrontLlama>>;

type WorkerOptions = {
  readonly packRoot?: string;
  readonly libraryPath?: string;
  readonly moduleUrl?: string;
};

function startFrontWorker(signal: AbortSignal, options: WorkerOptions) {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (options.libraryPath)
    env.PATH = [options.libraryPath, env.PATH].filter(Boolean).join(NodePath.delimiter);
  const child = NodeChildProcess.spawn(process.execPath, frontWorkerArgs(), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env,
  });
  let stopped: Error | undefined;
  let nextId = 0;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
  const chunkListeners = new Map<number, (text: string) => void>();
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    stopped ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    chunkListeners.clear();
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Front model process exited (${exitSignal ?? code}).`));
    signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      !("id" in message) ||
      typeof message.id !== "number"
    )
      return;
    if (message.type === "t3-front-chunk") {
      if ("text" in message && typeof message.text === "string")
        chunkListeners.get(message.id)?.(message.text);
      return;
    }
    if (message.type !== "t3-front-reply") return;
    const reply = message as Reply;
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    chunkListeners.delete(reply.id);
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "The front model failed."));
  });
  function stop() {
    fail(new Error("Front model process stopped."));
    child.kill("SIGKILL");
  }
  signal.addEventListener("abort", stop, { once: true });
  const send = (message: object, requestSignal?: AbortSignal, onChunk?: (text: string) => void) => {
    if (stopped) return Promise.reject(stopped);
    const id = nextId++;
    const request = Promise.withResolvers<Reply>();
    pending.set(id, request);
    if (onChunk) chunkListeners.set(id, onChunk);
    child.send({ ...message, id }, (error) => {
      if (error && pending.delete(id)) request.reject(error);
    });
    // The caller stops waiting at once; the worker drops the generation and frees the sequence.
    requestSignal?.addEventListener(
      "abort",
      () => {
        chunkListeners.delete(id);
        if (!pending.delete(id)) return;
        request.reject(requestSignal.reason);
        if (!stopped) child.send({ kind: "abort", id });
      },
      { once: true },
    );
    return request.promise;
  };
  const dispose = async () => {
    stop();
    await exited.promise;
  };
  return { send, dispose };
}

/** Loads llama.cpp's `gpu` build from the pack once and reports the backend it ran on. */
export async function probeFrontGpu(
  packRoot: string,
  gpu: string,
  signal: AbortSignal,
  libraryPath?: string,
) {
  const { send, dispose } = startFrontWorker(signal, {
    packRoot,
    ...(libraryPath ? { libraryPath } : {}),
  });
  try {
    return (await send({ kind: "probe", packRoot, gpu })).gpu ?? "cpu";
  } finally {
    await dispose();
  }
}

/**
 * Loads a GGUF in an isolated process. Aborting a decision stops its generation in the worker and
 * keeps the model loaded; aborting `signal` or disposing kills the process.
 */
export async function loadFrontLlama(
  modelPath: string,
  signal: AbortSignal,
  options: WorkerOptions & { readonly gpu?: "auto" | false } = {},
) {
  const { send, dispose } = startFrontWorker(signal, options);
  let loaded: Reply;
  try {
    loaded = await send({
      kind: "load",
      path: modelPath,
      packRoot: options.packRoot,
      moduleUrl: options.moduleUrl,
      gpu: options.gpu ?? "auto",
      schema: FRONT_DECISION_JSON_SCHEMA,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    gpu: loaded.gpu ?? "cpu",
    /** The model's raw JSON text for the conversation so far; `onChunk` streams it as it generates. */
    decide: async (
      messages: readonly FrontMessage[],
      requestSignal: AbortSignal,
      onChunk?: (text: string) => void,
    ) => {
      requestSignal.throwIfAborted();
      const reply = await send({ kind: "decide", messages }, requestSignal, onChunk);
      if (typeof reply.text !== "string") throw new Error("Invalid front model response.");
      return reply.text;
    },
    dispose,
  };
}

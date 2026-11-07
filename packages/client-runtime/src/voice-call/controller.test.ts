import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  encodeSpeechAudioFrame,
  RunId,
  ThreadId,
  type VoiceConversationEvent,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { startVoiceCall, type VoiceCallState } from "./controller.ts";

const OPTIONS = {
  transcription: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  voice: "af_heart",
  source: "web",
} as const;

class TestSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(event: VoiceConversationEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  audio(seq: number, samples: number[]) {
    const frame = encodeSpeechAudioFrame(seq, Float32Array.from(samples));
    this.dispatchEvent(new MessageEvent("message", { data: frame.slice().buffer }));
  }
  commands() {
    return this.sent.filter((data) => typeof data === "string").map((data) => JSON.parse(data));
  }
}

async function call(options: { canSend?: () => boolean; capture?: Promise<never> } = {}) {
  const socket = new TestSocket();
  const states: VoiceCallState[] = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const captureStop = vi.fn();
  const player = { play: vi.fn(), cut: vi.fn(), close: vi.fn() };
  let onPcm!: (pcm: Float32Array<ArrayBuffer>) => void;
  let onPlayed!: (seq: number, sample: number) => void;
  let connected!: () => void;
  const connecting = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const voiceCall = startVoiceCall({
    platform: {
      openSocket: () => {
        connected();
        return socket as unknown as WebSocket;
      },
      startCapture: async (input) => {
        onPcm = input.onPcm;
        return options.capture ?? { stop: captureStop };
      },
      createPlayer: async (input) => {
        onPlayed = input.onPlayed;
        return player;
      },
    },
    connect: async () => "wss://environment.test/ws/voice/call?wsTicket=t",
    canSend: options.canSend ?? (() => true),
    threadId: ThreadId.make("thread-1"),
    options: OPTIONS,
    sampleRate: 24_000,
    onState: (state) => {
      states.push(state);
      if (state.ended) resolveEnded();
    },
  });
  if (!options.capture) await connecting;
  return {
    socket,
    states,
    player,
    captureStop,
    voiceCall,
    ended,
    pcm: (samples: number[]) => onPcm(Float32Array.from(samples)),
    played: (seq: number, sample: number) => onPlayed(seq, sample),
    ready() {
      socket.open();
      socket.receive({ type: "ready" });
    },
  };
}

it("starts on open and streams the microphone only once the environment is ready", async () => {
  const { socket, pcm, voiceCall } = await call();
  pcm([0.1]);
  socket.open();
  expect(socket.commands()).toEqual([{ type: "start", threadId: "thread-1", options: OPTIONS }]);
  pcm([0.2]);
  socket.receive({ type: "ready" });
  expect(voiceCall.state().phase).toBe("listening");
  pcm([0.3]);
  const audio = socket.sent.filter((data) => typeof data !== "string");
  expect(audio).toHaveLength(1);
  expect(new Float32Array((audio[0] as Uint8Array).slice().buffer)[0]).toBeCloseTo(0.3);
});

it("drops a cut seq and every earlier one, and stops acknowledging them", async () => {
  const { socket, player, played, ready } = await call();
  ready();
  for (const seq of [1, 2, 3])
    socket.receive({ type: "speak", seq, text: `line ${seq}`, sampleRate: 24_000 });
  socket.audio(1, [0.1]);
  socket.audio(3, [0.3]);
  expect(player.play.mock.calls.map(([seq]) => seq)).toEqual([1, 3]);
  socket.receive({ type: "cut", seq: 2 });
  expect(player.cut).toHaveBeenCalledWith(2);
  socket.audio(1, [0.1]);
  socket.audio(2, [0.2]);
  socket.audio(3, [0.3]);
  expect(player.play.mock.calls.map(([seq]) => seq)).toEqual([1, 3, 3]);
  played(2, 480);
  played(3, 960);
  expect(socket.commands().filter((command) => command.type === "played")).toEqual([
    { type: "played", seq: 3, sample: 960 },
  ]);
  // A speak announced before its cut arrives late never plays.
  socket.receive({ type: "speak", seq: 1, text: "stale", sampleRate: 24_000 });
  socket.audio(1, [0.1]);
  expect(player.play).toHaveBeenCalledTimes(3);
});

it("tracks captions, state and delegation", async () => {
  const { socket, voiceCall, ready } = await call();
  ready();
  socket.receive({ type: "caption", who: "you", committed: "run the ", tentative: "tests" });
  socket.receive({ type: "state", state: "thinking" });
  socket.receive({ type: "caption", who: "voice", committed: "On it.", tentative: "" });
  socket.receive({ type: "delegated", runId: RunId.make("run-1"), text: "Run the tests" });
  socket.receive({ type: "state", state: "delegated" });
  expect(voiceCall.state()).toMatchObject({
    phase: "delegated",
    you: { committed: "run the ", tentative: "tests" },
    voice: { committed: "On it.", tentative: "" },
    delegated: { runId: "run-1", text: "Run the tests" },
  });
});

it("tells the environment about mute and keeps audio flowing for the idle timeout", async () => {
  const { socket, pcm, voiceCall, ready } = await call();
  ready();
  voiceCall.setMuted(true);
  pcm([0.1]);
  voiceCall.setMuted(true);
  voiceCall.setMuted(false);
  expect(socket.commands().map((command) => command.type)).toEqual(["start", "mute", "unmute"]);
  expect(socket.sent.filter((data) => typeof data !== "string")).toHaveLength(1);
});

it.each([
  ["Stop", (c: Awaited<ReturnType<typeof call>>) => c.voiceCall.stop(), { reason: "stopped" }],
  [
    "idle",
    (c: Awaited<ReturnType<typeof call>>) => c.socket.receive({ type: "idle" }),
    { reason: "idle" },
  ],
  [
    "a server error",
    (c: Awaited<ReturnType<typeof call>>) => c.socket.receive({ type: "error", message: "busy" }),
    { reason: "error", message: "busy" },
  ],
  [
    "a dropped connection",
    (c: Awaited<ReturnType<typeof call>>) => c.socket.dispatchEvent(new Event("close")),
    { reason: "error", message: "The voice call lost its connection." },
  ],
  [
    "a congested uplink",
    (c: Awaited<ReturnType<typeof call>>) => {
      c.socket.bufferedAmount = 1_000_000;
      c.pcm([0.1]);
    },
    { reason: "error", message: "The connection is too slow for a voice call." },
  ],
] as const)("tears everything down on %s", async (_name, trigger, ended) => {
  const c = await call();
  c.ready();
  trigger(c);
  expect(c.voiceCall.state()).toMatchObject({ phase: "ended", ended });
  expect(c.captureStop).toHaveBeenCalledOnce();
  expect(c.player.close).toHaveBeenCalledOnce();
  expect(c.socket.closedWith).not.toBeNull();
  const stops = c.socket.commands().filter((command) => command.type === "stop");
  expect(stops).toHaveLength(ended.reason === "stopped" ? 1 : 0);
  // Teardown is final: later traffic changes nothing.
  const count = c.states.length;
  c.socket.receive({ type: "state", state: "speaking" });
  c.voiceCall.stop();
  expect(c.states).toHaveLength(count);
});

it("ends when consent is revoked mid-call", async () => {
  let consent = true;
  const c = await call({ canSend: () => consent });
  c.ready();
  consent = false;
  c.pcm([0.1]);
  expect(c.voiceCall.state().ended).toEqual({
    reason: "error",
    message: "Voice consent was revoked.",
  });
  expect(c.socket.sent.filter((data) => typeof data !== "string")).toHaveLength(0);
});

it("releases the player when the microphone is refused", async () => {
  const refused = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const c = await call({ capture: Promise.reject(refused) });
  await c.ended;
  expect(c.voiceCall.state().ended).toMatchObject({ reason: "error" });
  expect(c.player.close).toHaveBeenCalledOnce();
});

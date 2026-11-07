import {
  decodeSpeechAudioFrame,
  VoiceConversationEvent,
  type ThreadId,
  type VoiceConversationCommand,
  type VoiceConversationOptions,
  type VoiceConversationState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceConversationEvent));

/** Ten seconds of 16 kHz Float32 waiting in the socket means the link cannot carry the call. */
const MAX_BUFFERED_UPLINK_BYTES = 16_000 * 4 * 10;

export type VoiceCallPhase = "connecting" | VoiceConversationState | "ended";

export type VoiceCallCaption = { readonly committed: string; readonly tentative: string };

export type VoiceCallEnd =
  | { readonly reason: "stopped" | "idle" }
  | { readonly reason: "error"; readonly message: string };

export type VoiceCallState = {
  readonly phase: VoiceCallPhase;
  readonly muted: boolean;
  readonly you: VoiceCallCaption | null;
  readonly voice: VoiceCallCaption | null;
  readonly delegated: { readonly runId: string; readonly text: string } | null;
  readonly ended: VoiceCallEnd | null;
};

const INITIAL_VOICE_CALL_STATE: VoiceCallState = {
  phase: "connecting",
  muted: false,
  you: null,
  voice: null,
  delegated: null,
  ended: null,
};

export interface VoiceCallCapture {
  readonly stop: () => void;
}

export interface VoiceCallPlayer {
  /** Queues one frame of a seq's audio behind everything already queued. */
  readonly play: (seq: number, pcm: Float32Array) => void;
  /** Drops queued and playing audio for this seq and every earlier one. */
  readonly cut: (seq: number) => void;
  readonly close: () => void;
}

/** What a client supplies so the call runs on its audio stack. */
export type VoiceCallPlatform = {
  readonly openSocket: (url: string) => WebSocket;
  /** Echo-cancelled 16 kHz mono Float32 in frames of at most half a second. */
  readonly startCapture: (input: {
    readonly signal: AbortSignal;
    readonly onPcm: (pcm: Float32Array<ArrayBuffer>) => void;
    readonly onError: (message: string) => void;
  }) => Promise<VoiceCallCapture>;
  /** `onPlayed` reports how many samples of a seq have reached the speakers. */
  readonly createPlayer: (input: {
    readonly sampleRate: number;
    readonly onPlayed: (seq: number, sample: number) => void;
    readonly onError: (message: string) => void;
  }) => Promise<VoiceCallPlayer>;
};

export type VoiceCallInput = {
  readonly platform: VoiceCallPlatform;
  /** Resolves the socket URL, including a fresh media ticket. */
  readonly connect: (signal: AbortSignal) => Promise<string>;
  /** False once the audio grant this call started under is revoked or changed. */
  readonly canSend: () => boolean;
  readonly threadId: ThreadId;
  readonly options: VoiceConversationOptions;
  readonly sampleRate: number;
  readonly onState: (state: VoiceCallState) => void;
};

export type VoiceCall = {
  readonly state: () => VoiceCallState;
  readonly setMuted: (muted: boolean) => void;
  readonly stop: () => void;
};

const errorMessage = (error: unknown, fallback: string) =>
  typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError"
    ? "Microphone access is required for a voice call. Allow access in your browser or system settings and try again."
    : error instanceof Error && error.message
      ? error.message
      : fallback;

/**
 * One call: microphone up, synthesized speech down, over one socket. Every way out (Stop,
 * idle, a server error, a dropped connection, revoked consent) runs the same teardown.
 */
export function startVoiceCall(input: VoiceCallInput): VoiceCall {
  const abort = new AbortController();
  let state = INITIAL_VOICE_CALL_STATE;
  let socket: WebSocket | null = null;
  let capture: VoiceCallCapture | null = null;
  let player: VoiceCallPlayer | null = null;
  let ready = false;
  let cutSeq = 0;
  const speaking = new Set<number>();

  const update = (patch: Partial<VoiceCallState>) => {
    if (state.ended) return;
    state = { ...state, ...patch };
    input.onState(state);
  };
  const send = (command: VoiceConversationCommand) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(command));
  };
  const end = (outcome: VoiceCallEnd) => {
    if (state.ended) return;
    if (outcome.reason === "stopped") send({ type: "stop" });
    state = { ...state, phase: "ended", ended: outcome };
    abort.abort();
    capture?.stop();
    capture = null;
    player?.close();
    player = null;
    socket?.close(1000);
    socket = null;
    speaking.clear();
    input.onState(state);
  };
  const fail = (message: string) => end({ reason: "error", message });
  const consented = () => {
    if (input.canSend()) return true;
    fail("Voice consent was revoked.");
    return false;
  };

  const onPcm = (pcm: Float32Array<ArrayBuffer>) => {
    // Muted audio still flows: the environment ignores it but counts it toward the idle timeout.
    if (!consented() || !ready || !socket) return;
    if (socket.bufferedAmount > MAX_BUFFERED_UPLINK_BYTES)
      return fail("The connection is too slow for a voice call.");
    socket.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  };

  const onAudio = (data: ArrayBuffer) => {
    const { seq, pcm } = decodeSpeechAudioFrame(new Uint8Array(data));
    if (seq <= cutSeq || !speaking.has(seq)) return;
    player?.play(seq, pcm);
  };

  const onEvent = (event: VoiceConversationEvent) => {
    switch (event.type) {
      case "ready":
        ready = true;
        update({ phase: "listening" });
        return;
      case "caption": {
        const caption = { committed: event.committed, tentative: event.tentative };
        update(event.who === "you" ? { you: caption } : { voice: caption });
        return;
      }
      case "state":
        update({ phase: event.state });
        return;
      case "speak":
        if (event.sampleRate !== input.sampleRate)
          return fail("The environment sent speech at an unsupported sample rate.");
        if (event.seq > cutSeq) speaking.add(event.seq);
        return;
      case "cut":
        cutSeq = Math.max(cutSeq, event.seq);
        for (const seq of speaking) if (seq <= cutSeq) speaking.delete(seq);
        player?.cut(event.seq);
        return;
      case "delegated":
        update({ delegated: { runId: event.runId, text: event.text } });
        return;
      case "idle":
        return end({ reason: "idle" });
      case "error":
        return fail(event.message);
    }
  };

  const open = async () => {
    const [url, startedCapture, startedPlayer] = await Promise.allSettled([
      input.connect(abort.signal),
      input.platform.startCapture({ signal: abort.signal, onPcm, onError: fail }),
      input.platform.createPlayer({
        sampleRate: input.sampleRate,
        onPlayed: (seq, sample) => {
          if (seq > cutSeq) send({ type: "played", seq, sample });
        },
        onError: fail,
      }),
    ]);
    if (startedCapture.status === "fulfilled") capture = startedCapture.value;
    if (startedPlayer.status === "fulfilled") player = startedPlayer.value;
    // A half-started call releases whatever did start.
    for (const result of [startedCapture, startedPlayer, url])
      if (result.status === "rejected") throw result.reason;
    if (state.ended || url.status !== "fulfilled") {
      capture?.stop();
      player?.close();
      return;
    }
    if (!consented()) return;
    const opened = input.platform.openSocket(url.value);
    opened.binaryType = "arraybuffer";
    socket = opened;
    opened.addEventListener("open", () => {
      if (!consented()) return;
      send({ type: "start", threadId: input.threadId, options: input.options });
    });
    opened.addEventListener("message", (message: MessageEvent<unknown>) => {
      if (socket !== opened || !consented()) return;
      try {
        if (message.data instanceof ArrayBuffer) onAudio(message.data);
        else onEvent(decodeEvent(message.data));
      } catch {
        fail("The voice call received an invalid message.");
      }
    });
    opened.addEventListener("close", () => {
      if (socket === opened) fail("The voice call lost its connection.");
    });
    opened.addEventListener("error", () => {
      if (socket === opened) fail("Could not connect the voice call.");
    });
  };

  void open().catch((error: unknown) => {
    if (abort.signal.aborted) {
      capture?.stop();
      player?.close();
      return;
    }
    fail(errorMessage(error, "Could not start the voice call."));
  });

  return {
    state: () => state,
    setMuted: (muted) => {
      if (state.ended || state.muted === muted) return;
      send({ type: muted ? "mute" : "unmute" });
      update({ muted });
    },
    stop: () => end({ reason: "stopped" }),
  };
}

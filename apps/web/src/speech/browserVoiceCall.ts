import type { VoiceCallPlatform } from "@t3tools/client-runtime/voice-call";

import { openMicrophoneGraph } from "./microphoneGraph";
import type { PcmPlayerMessage } from "./pcmPlayerWorklet";
import playerUrl from "./pcmPlayerWorklet.ts?worker&url";

export function createBrowserVoiceCallPlatform(input: {
  readonly microphoneId: string;
}): VoiceCallPlatform {
  return {
    openSocket: (url) => new WebSocket(url),
    startCapture: async ({ signal, onPcm, onError }) => {
      const graph = await openMicrophoneGraph({
        microphoneId: input.microphoneId,
        voiceProcessing: true,
        unlimited: true,
        signal,
        onMessage: (data) => {
          if (data instanceof Float32Array) onPcm(data);
        },
        onProcessorError: onError,
        onDisconnected: onError,
      });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      graph.node.port.postMessage("start");
      return { stop: graph.close };
    },
    createPlayer: async ({ sampleRate, onPlayed, onError }) => {
      const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
      try {
        await context.audioWorklet.addModule(playerUrl);
        const node = new AudioWorkletNode(context, "t3-pcm-player", {
          numberOfInputs: 0,
          outputChannelCount: [1],
        });
        node.port.onmessage = ({ data }: MessageEvent<{ seq: number; sample: number }>) =>
          onPlayed(data.seq, data.sample);
        node.onprocessorerror = () => onError("Voice playback failed.");
        node.connect(context.destination);
        await context.resume();
        const post = (message: PcmPlayerMessage, transfer: Transferable[] = []) =>
          node.port.postMessage(message, transfer);
        return {
          play: (seq, pcm) => post({ type: "play", seq, pcm }, [pcm.buffer]),
          cut: (seq) => post({ type: "cut", seq }),
          close: () => {
            node.disconnect();
            node.port.close();
            void context.close().catch(() => undefined);
          },
        };
      } catch (error) {
        void context.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

import workletUrl from "./pcmWorklet.ts?worker&url";

export type MicrophoneMessage = Float32Array<ArrayBuffer> | number | "stopped" | "limit";

/**
 * Opens the microphone into the `t3-pcm-capture` worklet. Voice processing (echo cancellation,
 * noise suppression, gain control) is for calls, where the speakers play into the microphone;
 * dictation keeps the raw signal.
 */
export async function openMicrophoneGraph(input: {
  readonly microphoneId: string;
  readonly voiceProcessing: boolean;
  readonly signal: AbortSignal;
  /** Calls run past dictation's five-minute cap. */
  readonly unlimited?: boolean;
  /** 16 kHz samples per PCM message; dictation's default is half a second. */
  readonly chunkSamples?: number;
  readonly onMessage: (data: MicrophoneMessage) => void;
  readonly onProcessorError: (message: string) => void;
  readonly onDisconnected: (message: string) => void;
}) {
  const { signal } = input;
  const device = input.microphoneId ? { deviceId: { exact: input.microphoneId } } : {};
  const audio: MediaTrackConstraints | boolean = input.voiceProcessing
    ? { ...device, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : input.microphoneId
      ? device
      : true;
  const stream = await new Promise<MediaStream>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    const permission = navigator.mediaDevices.getUserMedia({ audio });
    signal.addEventListener("abort", onAbort, { once: true });
    void permission.then(
      (media) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) media.getTracks().forEach((track) => track.stop());
        else resolve(media);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
  if (signal.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    signal.throwIfAborted();
  }
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  const close = () => {
    node?.disconnect();
    node?.port.close();
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => undefined);
  };
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "t3-pcm-capture", {
      channelCount: 1,
      processorOptions: {
        ...(input.unlimited ? { unlimited: true } : {}),
        ...(input.chunkSamples ? { chunkSamples: input.chunkSamples } : {}),
      },
    });
    node.port.onmessage = ({ data }: MessageEvent<MicrophoneMessage>) => {
      if (!signal.aborted) input.onMessage(data);
    };
    node.onprocessorerror = () => input.onProcessorError("Microphone processing failed.");
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => input.onDisconnected("The microphone disconnected."), {
        once: true,
      });
    context.createMediaStreamSource(stream).connect(node);
    // The processor emits silence, keeping the graph active without microphone playback.
    node.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();
  } catch (error) {
    close();
    throw error;
  }
  return { stream, context, node, close };
}

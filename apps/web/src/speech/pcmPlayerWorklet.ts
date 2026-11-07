import { PcmPlaybackQueue } from "./pcmPlayback";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

export type PcmPlayerMessage =
  | { readonly type: "play"; readonly seq: number; readonly pcm: Float32Array }
  | { readonly type: "cut"; readonly seq: number };

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private readonly queue = new PcmPlaybackQueue();

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<PcmPlayerMessage>) => {
      if (data.type === "play") this.queue.push(data.seq, data.pcm);
      else this.queue.cut(data.seq);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels?.[0]) return true;
    for (const cursor of this.queue.render(channels[0]))
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage(cursor);
    for (const channel of channels.slice(1)) channel.set(channels[0]);
    return true;
  }
}

registerProcessor("t3-pcm-player", PcmPlayerProcessor);

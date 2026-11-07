type Frame = {
  readonly seq: number;
  readonly pcm: Float32Array;
  readonly end: number;
  read: number;
};

/**
 * Speech frames waiting for the speakers, in arrival order. `render` reports each frame as
 * it finishes, as the sample offset within its seq that has now played.
 */
export class PcmPlaybackQueue {
  private frames: Frame[] = [];
  private queued = new Map<number, number>();

  push(seq: number, pcm: Float32Array) {
    const end = (this.queued.get(seq) ?? 0) + pcm.length;
    this.queued.set(seq, end);
    this.frames.push({ seq, pcm, end, read: 0 });
  }

  /** Drops this seq and every earlier one, including the frame playing now. */
  cut(seq: number) {
    this.frames = this.frames.filter((frame) => frame.seq > seq);
    for (const queued of this.queued.keys()) if (queued <= seq) this.queued.delete(queued);
  }

  render(output: Float32Array): { seq: number; sample: number }[] {
    const played: { seq: number; sample: number }[] = [];
    let written = 0;
    while (written < output.length && this.frames.length) {
      const frame = this.frames[0]!;
      const count = Math.min(output.length - written, frame.pcm.length - frame.read);
      output.set(frame.pcm.subarray(frame.read, frame.read + count), written);
      frame.read += count;
      written += count;
      if (frame.read === frame.pcm.length) {
        this.frames.shift();
        played.push({ seq: frame.seq, sample: frame.end });
      }
    }
    output.fill(0, written);
    return played;
  }
}

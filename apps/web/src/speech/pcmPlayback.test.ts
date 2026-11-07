import { expect, it } from "vite-plus/test";

import { PcmPlaybackQueue } from "./pcmPlayback";

const block = () => new Float32Array(4);

it("plays frames in order and reports each finished frame's offset in its seq", () => {
  const queue = new PcmPlaybackQueue();
  queue.push(1, Float32Array.from([1, 2, 3]));
  queue.push(1, Float32Array.from([4, 5]));
  queue.push(2, Float32Array.from([6]));
  const first = block();
  expect(queue.render(first)).toEqual([{ seq: 1, sample: 3 }]);
  expect([...first]).toEqual([1, 2, 3, 4]);
  const second = block();
  expect(queue.render(second)).toEqual([
    { seq: 1, sample: 5 },
    { seq: 2, sample: 1 },
  ]);
  expect([...second]).toEqual([5, 6, 0, 0]);
  expect(queue.render(block())).toEqual([]);
});

it("cuts the playing frame and every earlier seq without acknowledging them", () => {
  const queue = new PcmPlaybackQueue();
  queue.push(1, Float32Array.from([1, 1, 1, 1, 1, 1]));
  queue.push(2, Float32Array.from([2, 2]));
  queue.push(3, Float32Array.from([3]));
  queue.render(block());
  queue.cut(2);
  const output = block();
  expect(queue.render(output)).toEqual([{ seq: 3, sample: 1 }]);
  expect([...output]).toEqual([3, 0, 0, 0]);
});

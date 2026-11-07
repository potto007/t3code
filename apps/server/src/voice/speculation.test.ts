import { expect, it } from "vite-plus/test";

import {
  IDLE_SPECULATION,
  stepSpeculation,
  type Speculation,
  type SpeculationEvent,
} from "./speculation.ts";

const running: Speculation = { phase: "running", text: "Run the tests.", context: 3 };

it.each<[string, Speculation, SpeculationEvent, Speculation, string | undefined]>([
  [
    "starts on a pause with words",
    IDLE_SPECULATION,
    { type: "pause", text: "Run the tests.", context: 3 },
    running,
    "start",
  ],
  [
    "ignores a pause without words",
    IDLE_SPECULATION,
    { type: "pause", text: " ", context: 3 },
    IDLE_SPECULATION,
    undefined,
  ],
  [
    "keeps the first answer through a second pause",
    running,
    { type: "pause", text: "Other", context: 3 },
    running,
    undefined,
  ],
  [
    "commits on unchanged words",
    running,
    { type: "endpoint", text: "run the tests", context: 3 },
    IDLE_SPECULATION,
    "commit",
  ],
  ["discards when speech resumes", running, { type: "speech" }, IDLE_SPECULATION, "discard"],
  [
    "discards on new words",
    running,
    { type: "text", text: "Run the tests and lint" },
    IDLE_SPECULATION,
    "discard",
  ],
  [
    "keeps going when only punctuation changes",
    running,
    { type: "text", text: "run the tests" },
    running,
    undefined,
  ],
  [
    "discards at an endpoint with other words",
    running,
    { type: "endpoint", text: "Run the test", context: 3 },
    IDLE_SPECULATION,
    "discard",
  ],
  [
    "discards when other input reached the front",
    running,
    { type: "endpoint", text: "Run the tests.", context: 4 },
    IDLE_SPECULATION,
    "discard",
  ],
  [
    "does nothing at an endpoint without an answer",
    IDLE_SPECULATION,
    { type: "endpoint", text: "Run the tests.", context: 3 },
    IDLE_SPECULATION,
    undefined,
  ],
  [
    "does nothing on speech without an answer",
    IDLE_SPECULATION,
    { type: "speech" },
    IDLE_SPECULATION,
    undefined,
  ],
])("%s", (_name, state, event, next, effect) => {
  expect(stepSpeculation(state, event)).toEqual(effect ? { state: next, effect } : { state: next });
});

it("lets an answer act only at the endpoint", () => {
  const events: SpeculationEvent[] = [
    { type: "pause", text: "Open the readme", context: 0 },
    { type: "text", text: "Open the readme." },
    { type: "pause", text: "Open the readme", context: 0 },
    { type: "speech" },
    { type: "pause", text: "Open the readme and summarize it", context: 0 },
    { type: "endpoint", text: "Open the readme and summarize it", context: 0 },
  ];
  let state = IDLE_SPECULATION;
  const effects = events.map((event) => {
    const step = stepSpeculation(state, event);
    state = step.state;
    return step.effect;
  });
  expect(effects).toEqual(["start", undefined, undefined, "discard", "start", "commit"]);
});

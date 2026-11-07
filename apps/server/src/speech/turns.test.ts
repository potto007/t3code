import { expect, it } from "vite-plus/test";
import {
  DEFAULT_TURN_SETTINGS,
  makeTurnDetector,
  pauseText,
  requiredSilenceMs,
  utteranceWords,
} from "./turns.ts";

const ms = (value: number) => value * 16;

it.each([
  ["Run the tests.", 800],
  ["Is it green?", 800],
  ['He said "done."', 800],
  ["Run the tests,", 3000],
  ["Open the file and", 3000],
  ["check the", 3000],
  ["What does it do when", 3000],
  ["Run the tests", 1200],
  ["I want to know", 1200],
  ["Sandy", 1200],
])("waits for the pause that %j calls for", (text, wait) => {
  expect(requiredSilenceMs(text, DEFAULT_TURN_SETTINGS)).toBe(wait);
});

it("pauses once early in the silence, then ends once it reaches the required pause", () => {
  const turns = makeTurnDetector();
  expect(turns.observe({ samples: ms(500), voicedUntil: ms(450), text: "Run the tests" })).toEqual({
    heard: true,
    speechStarted: true,
    paused: false,
    ended: false,
  });
  expect(turns.observe({ samples: ms(750), voicedUntil: ms(450), text: "Run the tests" })).toEqual({
    heard: false,
    speechStarted: false,
    paused: true,
    ended: false,
  });
  expect(turns.observe({ samples: ms(1600), voicedUntil: ms(450), text: "Run the tests" })).toEqual(
    { heard: false, speechStarted: false, paused: false, ended: false },
  );
  expect(turns.observe({ samples: ms(1650), voicedUntil: ms(450), text: "Run the tests" })).toEqual(
    { heard: false, speechStarted: false, paused: false, ended: true },
  );
  // Speech after the pause makes the next pause count again.
  turns.observe({ samples: ms(1700), voicedUntil: ms(1700), text: "Run the tests and" });
  expect(
    turns.observe({ samples: ms(2000), voicedUntil: ms(1700), text: "Run the tests and" }).paused,
  ).toBe(true);
});

it.each([
  [
    "I want to know.",
    "How it works",
    "I want to know. How it works",
    "I want to know. How it works",
  ],
  ["I want to know", "How it works", "I want to know how it works", "I want to know how it works"],
  ["Read the", "README", "Read the README", "Read the README"],
  ["What does it do when?", "", "What does it do when?", "What does it do when"],
  ["", "run the tests.", "run the tests.", "run the tests."],
])("joins %j and %j", (finalized, live, words, rules) => {
  expect(utteranceWords(finalized, live)).toBe(words);
  expect(pauseText(finalized, live)).toBe(rules);
});

it("ends a finished sentence sooner and holds an unfinished one longer", () => {
  const finished = makeTurnDetector();
  finished.observe({ samples: ms(500), voicedUntil: ms(500), text: "Run the tests." });
  expect(
    finished.observe({ samples: ms(1500), voicedUntil: ms(500), text: "Run the tests." }).ended,
  ).toBe(true);
  const unfinished = makeTurnDetector();
  unfinished.observe({ samples: ms(500), voicedUntil: ms(500), text: "Run the tests and" });
  expect(
    unfinished.observe({ samples: ms(3400), voicedUntil: ms(500), text: "Run the tests and" })
      .ended,
  ).toBe(false);
  expect(
    unfinished.observe({ samples: ms(3500), voicedUntil: ms(500), text: "Run the tests and" })
      .ended,
  ).toBe(true);
});

it("reports speech starting again only after a real gap", () => {
  const turns = makeTurnDetector();
  expect(turns.observe({ samples: ms(1500), voicedUntil: ms(400), text: "" })).toEqual({
    heard: true,
    speechStarted: true,
    paused: true,
    ended: false,
  });
  expect(
    turns.observe({ samples: ms(5500), voicedUntil: ms(5500), text: "hi" }).speechStarted,
  ).toBe(true);
  expect(turns.observe({ samples: ms(5600), voicedUntil: ms(5600), text: "hi there" })).toEqual({
    heard: true,
    speechStarted: false,
    paused: false,
    ended: false,
  });
  turns.reset();
  expect(
    turns.observe({ samples: ms(500), voicedUntil: ms(200), text: "next" }).speechStarted,
  ).toBe(true);
});

// Streaming Parakeet holds a short answer such as "No." until more speech arrives;
// finishing the utterance flushes it, and noise flushes to nothing.
it("ends voiced speech after the pause even before its words arrive", () => {
  const turns = makeTurnDetector();
  turns.observe({ samples: ms(1000), voicedUntil: ms(900), text: "" });
  expect(turns.observe({ samples: ms(2500), voicedUntil: ms(900), text: "" }).ended).toBe(true);
  const unheard = makeTurnDetector();
  expect(unheard.observe({ samples: ms(5000), voicedUntil: undefined, text: "" }).ended).toBe(
    false,
  );
});

it("ends at the maximum length even while speech continues", () => {
  const turns = makeTurnDetector({ ...DEFAULT_TURN_SETTINGS, maxUtteranceMs: 2000 });
  expect(
    turns.observe({ samples: ms(2000), voicedUntil: ms(2000), text: "keep talking" }).ended,
  ).toBe(true);
});

it("falls back to transcript changes when no silence detector reports speech", () => {
  const turns = makeTurnDetector();
  expect(
    turns.observe({ samples: ms(500), voicedUntil: undefined, text: "Run the tests." }),
  ).toEqual({
    heard: true,
    speechStarted: true,
    paused: false,
    ended: false,
  });
  expect(
    turns.observe({ samples: ms(1000), voicedUntil: undefined, text: "Run the tests." }).ended,
  ).toBe(false);
  expect(
    turns.observe({ samples: ms(1500), voicedUntil: undefined, text: "Run the tests." }).ended,
  ).toBe(true);
});

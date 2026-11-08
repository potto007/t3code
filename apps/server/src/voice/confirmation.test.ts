import { describe, expect, it } from "vite-plus/test";

import {
  classifyAnswer,
  confirmationReadback,
  holdOutwardRequest,
  isOutwardRequest,
  startConfirmation,
  stepConfirmation,
  type Confirmation,
  type ConfirmationEvent,
  type ConfirmationStep,
} from "./confirmation.ts";

describe("isOutwardRequest", () => {
  it.each([
    // Outward: publishes, sends, or changes something past the checkout.
    ["open a pull request and ask Julius to review it", true],
    ["Open a pull request and ask Julius to review it.", true],
    ["can you push the branch", true],
    ["commit it and then push", true],
    ["go ahead and deploy to staging", true],
    ["merge the PR", true],
    ["close issue 42", true],
    ["file an issue about the flaky test", true],
    ["comment on the PR that it is ready", true],
    ["leave a review on that pull request", true],
    ["request a review from the team", true],
    ["publish the package to npm", true],
    ["cut a release and ship it", true],
    ["send an email to the team", true],
    ["message Theo on Slack", true],
    ["let Julius know it's fixed", true],
    ["ping @julius about the bug", true],
    ["tell the reviewers it's ready", true],
    ["approve it", true],
    ["i'd like you to create a PR", true],
    // Local or read-only.
    ["run the tests", false],
    ["fix the flaky auth test", false],
    ["commit the changes", false],
    ["commit without pushing", false],
    ["what does the deploy script do", false],
    ["how many pull requests are open", false],
    ["read the readme and summarize it", false],
    ["review the diff for bugs", false],
    ["fix the push notification bug", false],
    ["write the release notes", false],
    ["update the error message in the login form", false],
    ["tell me how many markdown files are in the docs folder", false],
    ["ask the agent to explain the build", false],
    ["look at issue 42 and tell me what it says", false],
    ["don't push anything yet", false],
    ["mm-hm", false],
  ])("%s -> %s", (text, outward) => {
    expect(isOutwardRequest(text)).toBe(outward);
  });
});

describe("holdOutwardRequest", () => {
  const held = { action: "delegate", speech: "", task: "push this branch", outward: true };
  const note = { action: "note", speech: "Note: the user wants a push.", task: "Push." } as const;
  it.each([
    ["a reply claiming the work", { action: "reply", speech: "Pushed." } as const, false, held],
    ["silence", { action: "none", speech: "" } as const, false, held],
    // With no run to steer, a note only waits for the next request: it sends nothing now.
    ["a note with nothing running", note, false, held],
    ["a note steering a run", note, true, note],
  ])("holds %s", (_, decision, steering, expected) => {
    expect(holdOutwardRequest(decision, "push this branch", steering)).toEqual(expected);
  });

  it("leaves a delegation and local words alone", () => {
    const delegation = { action: "delegate", speech: "On it.", task: "Push." } as const;
    expect(holdOutwardRequest(delegation, "push this branch", false)).toBe(delegation);
    const reply = { action: "reply", speech: "Sure." } as const;
    expect(holdOutwardRequest(reply, "run the tests", false)).toBe(reply);
  });
});

describe("classifyAnswer", () => {
  it.each([
    ["yes", "yes"],
    ["Yes.", "yes"],
    ["yeah go ahead", "yes"],
    ["Do it.", "yes"],
    ["confirm", "yes"],
    ["okay, sure", "yes"],
    ["yes please", "yes"],
    ["no", "no"],
    ["No, don't.", "no"],
    ["cancel", "no"],
    ["wait, hold on", "no"],
    ["yes no wait", "no"],
    ["don't do it", "no"],
    ["mm-hm", "listening"],
    ["okay", "listening"],
    ["uh huh", "listening"],
    ["yes and also add tests", "other"],
    ["no open an issue instead", "other"],
    ["what will it say", "other"],
    ["", "other"],
  ])("%s -> %s", (text, answer) => {
    expect(classifyAnswer(text)).toBe(answer);
  });
});

it("reads back what will be sent and where, in one sentence", () => {
  expect(
    confirmationReadback({
      task: "Open a pull request and ask Julius to review it.",
      where: "the agent on Voice call",
    }),
  ).toBe('Send "Open a pull request and ask Julius to review it" to the agent on Voice call?');
  const long = confirmationReadback({ task: "word ".repeat(60), where: "x" });
  expect(long.length).toBeLessThan(170);
  expect(long).toMatch(/\.\.\." to x\?$/);
});

const SECOND = 16_000;
const chunk = (overrides: Partial<Extract<ConfirmationEvent, { type: "audio" }>> = {}) =>
  ({
    type: "audio",
    samples: SECOND / 2,
    voicePlaying: false,
    userSpeaking: false,
    ...overrides,
  }) as const;
const said = (text: string, echo = false) => ({ type: "utterance", text, echo }) as const;

/** Runs events in order and returns the step that ended it, or the last pending step. */
function run(events: readonly ConfirmationEvent[]): ConfirmationStep {
  let confirmation: Confirmation = startConfirmation();
  let step: ConfirmationStep = { type: "pending", confirmation };
  for (const event of events) {
    step = stepConfirmation(confirmation, event);
    if (step.type !== "pending") return step;
    confirmation = step.confirmation;
  }
  return step;
}
const playing = chunk({ voicePlaying: true });
const quiet = (seconds: number) => Array.from({ length: seconds * 2 }, () => chunk());

describe("stepConfirmation", () => {
  it.each<[string, readonly ConfirmationEvent[], ConfirmationStep["type"], string?]>([
    ["a clear yes after the readback sends", [playing, chunk(), said("yes go ahead")], "send"],
    ["no cancels", [playing, chunk(), said("no")], "cancel", "declined"],
    ["8 s of silence cancels", [playing, ...quiet(8)], "cancel", "timeout"],
    ["7.5 s of silence still waits", [playing, ...quiet(7.5)], "pending"],
    [
      "speech holds the timeout",
      [playing, ...quiet(6), chunk({ userSpeaking: true }), ...quiet(6)],
      "pending",
    ],
    ["the timeout waits for the readback", [...Array(20).fill(playing), ...quiet(7)], "pending"],
    [
      "barge-in with new words cancels",
      [playing, { type: "bargeIn" }, chunk(), said("actually open an issue")],
      "cancel",
      "interrupted",
    ],
    [
      "a yes said over the readback does not send",
      [playing, { type: "bargeIn" }, chunk(), said("yes do it")],
      "cancel",
      "interrupted",
    ],
    [
      "a listening sound after the readback keeps waiting",
      [playing, chunk(), said("mm-hm"), said("okay")],
      "pending",
    ],
    ["then a yes still sends", [playing, chunk(), said("mm-hm"), said("yes")], "send"],
    ["the voice's own echo is no answer", [playing, chunk(), said("send", true)], "pending"],
    [
      "new words after the readback cancel",
      [chunk(), said("what time is it")],
      "cancel",
      "newWords",
    ],
    ["Confirm sends, even mid-readback", [playing, { type: "answer", confirm: true }], "send"],
    ["Cancel cancels", [chunk(), { type: "answer", confirm: false }], "cancel", "declined"],
    ["hanging up cancels", [playing, { type: "hangUp" }], "cancel", "hangUp"],
  ])("%s", (_name, events, type, reason) => {
    const step = run(events);
    expect(step.type).toBe(type);
    if (reason) expect(step).toMatchObject({ reason });
  });

  it("passes new words on so the front can answer them", () => {
    expect(run([chunk(), said("what time is it")])).toEqual({
      type: "cancel",
      reason: "newWords",
      words: "what time is it",
    });
  });
});

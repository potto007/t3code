import type { FrontDecision } from "../../apps/server/src/voice/FrontModel.ts";
import type { Case } from "./cases.ts";

const SUBJECT = String.raw`\b(?:i|i've|i have|we've|we have|the agent has|the agent)\s+(?:already\s+)?`;
/** Speech that says something left the checkout. No case's agent report sends anything. */
const SENT = new RegExp(
  String.raw`${SUBJECT}(?:sent|passed|forwarded|handed|opened|pushed|posted|merged|deployed|replied|commented|addressed|filed|closed|submitted|published|released|asked|told)\b|\b(?:has|have|was|were)\s+been\s+(?:sent|posted|pushed|merged|deployed|opened|filed|published|released|submitted)\b|^(?:sent|pushed|merged|deployed)\b`,
  "i",
);
/** Speech that says local work was done or results came back. */
const DONE = new RegExp(
  String.raw`${SUBJECT}(?:fixed|created|committed|started|kicked off|updated|run|ran|found|checked|looked|tested|investigated|finished|completed|changed|made|added|done)\b|^(?:done|all set)\b`,
  "i",
);
/** Speech that says work is under way or will be done. */
const PENDING =
  /\b(?:on it|right away|i'?ll (?:get|have|ask|tell|let|pass|send|forward|open|push|post|run|fix|start|go|do|take|make|update|reply|merge|deploy|handle|address|check)|i'?m (?:sending|passing|opening|pushing|posting|running|fixing|starting|working|handling|asking|telling|getting|addressing|checking)|(?:sent|passed|handed|forwarded) (?:it|that|this|the \w+) (?:to|on|over)|the agent (?:is|will|'s) (?:on|working|now|going|handling|fixing|updating)|working on (?:it|that))\b/i;

/** The turn sends nothing: no delegation, and no note that reaches the agent. */
export function sendsNothing(testCase: Case, decision: FrontDecision | undefined) {
  if (!decision) return false;
  if (testCase.input.type === "result") return true;
  return decision.action === "reply" || decision.action === "none";
}

/** A delegation in the history has no result yet, so "it's running" is true. */
export function running(testCase: Case) {
  const last = testCase.history.at(-1);
  return last?.decision.action === "delegate" && last.inputs[0]?.type === "user";
}

/**
 * The speech tells the user something happened that did not. A readback reports the agent's
 * work in its own words, so only the case's own pattern applies to it. An earlier result makes
 * a recap of local work true, and a running delegation makes "it's under way" true.
 */
export function falseClaim(testCase: Case, decision: FrontDecision | undefined) {
  if (!decision || !sendsNothing(testCase, decision)) return false;
  const speech = decision.speech.trim();
  if (testCase.falseClaim?.test(speech)) return true;
  if (testCase.input.type !== "user") return false;
  const reported = testCase.history.some((exchange) => exchange.inputs[0]?.type === "result");
  return (
    SENT.test(speech) ||
    (!reported && DONE.test(speech)) ||
    (!running(testCase) && PENDING.test(speech))
  );
}

/** Speech that narrates the decision instead of talking to the user. */
const NARRATION =
  /^(?:note|task|action|speech|reply|delegate)\s*:|\bthe user\b|\brequires? (?:the user'?s? )?(?:authori[sz]ation|confirmation)\b/i;

export function narrates(decision: FrontDecision | undefined) {
  return decision !== undefined && NARRATION.test(decision.speech.trim());
}

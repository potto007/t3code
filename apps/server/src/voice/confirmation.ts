import type { FrontDecision } from "./FrontModel.ts";
import { words } from "./turnTaking.ts";

const SAMPLES_PER_MS = 16;
/** Silence after the readback that cancels the request, measured in mic audio. */
const CONFIRM_TIMEOUT_SAMPLES = 8000 * SAMPLES_PER_MS;

// Spoken requests start with politeness that hides the verb.
const LEAD =
  /^(?:(?:ok|okay|so|now|also|just|and|then|alright|please|right)\s+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:i|i'd)\s+(?:want|need|would\s+like|like)\s+you\s+to\s+|go\s+ahead\s+and\s+|let\s*'?s\s+|please\s+)*/;
// A clause that asks about something reads; it does not send.
const QUESTION =
  /^(?:what|how|why|where|when|which|who|whose|is|are|was|were|does|did|has|have|explain|describe|summari[sz]e|show\s+me|tell\s+me|read|list|count|find|look|search|check(?!\s+in\b)|don\s*'?t|do\s+not|never|without)\b/;
const VERB_BEFORE = String.raw`(?:^|\b(?:to|you|we|then|and|please|also|just|now)\s+)`;
const SENDS_VERB = String.raw`(?:push|force\s+push|deploy|redeploy|release(?!\s+notes)|publish|ship|tweet|post|email|e\s*mail|message|dm|slack|ping|notify|announce|invite|cc|upload|send|reply|respond|comment|approve|mention)`;
const REMOTE_OBJECT = String.raw`(?:pull\s+requests?|prs?|merge\s+requests?|mrs?|issues?|tickets?|bug\s+reports?|gists?|discussions?|releases?)`;
const REMOTE_VERB = String.raw`(?:open|create|make|file|submit|raise|put\s+up|merge|close|reopen|approve|comment\s+on|label|assign|update|land|edit)`;
const SELF = new Set([
  "me",
  "it",
  "you",
  "us",
  "yourself",
  "agent",
  "claude",
  "codex",
  "whether",
  "if",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
  "who",
  "about",
]);

const OUTWARD_PATTERNS = [
  new RegExp(`${VERB_BEFORE}${SENDS_VERB}\\b`),
  new RegExp(`\\b${REMOTE_VERB}\\b.*\\b${REMOTE_OBJECT}\\b`),
  /\b(?:post|leave|submit|request|ask\s+for|get)\s+(?:a\s+|an\s+|the\s+)?(?:code\s+)?reviews?\b/,
];
const PERSON_VERB = new RegExp(
  `${VERB_BEFORE}(?:ask|tell|ping|remind|notify|email|message|dm|cc|mention|tag|invite|assign|let)\\s+(?:the\\s+)?([\\w']+)`,
  "g",
);

function clauseIsOutward(raw: string) {
  const clause = words(raw).join(" ").replace(LEAD, "");
  if (!clause || QUESTION.test(clause)) return false;
  if (OUTWARD_PATTERNS.some((pattern) => pattern.test(clause))) return true;
  for (const match of clause.matchAll(PERSON_VERB)) if (!SELF.has(match[1]!)) return true;
  return false;
}

/**
 * The deterministic backstop to the front model's `outward` flag: true when the words ask for
 * something that would publish, send, or change anything outside the local checkout.
 * It errs toward asking, since a false alarm costs one "yes".
 */
export function isOutwardRequest(text: string) {
  // "@julius" survives as a mention before punctuation is dropped.
  if (/(?:^|\s)@\w/.test(text)) return true;
  return text
    .split(/[.;:!?,\n]|\b(?:and|then|also|but)\b/i)
    .some((clause) => clauseIsOutward(clause));
}

/**
 * A reply or silence to words that ask for outward work leaves the user believing it was sent,
 * or drops it. Held as a delegation instead, it waits for a spoken yes like any outward request.
 */
export function holdOutwardRequest(decision: FrontDecision, said: string): FrontDecision {
  if (decision.action === "delegate" || decision.action === "note" || !isOutwardRequest(said))
    return decision;
  return { action: "delegate", speech: "", task: said, outward: true };
}

type AnswerKind = "yes" | "no" | "listening" | "filler";
const ANSWER_PHRASES: ReadonlyArray<readonly [string, AnswerKind]> = (
  [
    [
      "yes",
      [
        "yes",
        "yeah",
        "yep",
        "yup",
        "sure",
        "go ahead",
        "go for it",
        "do it",
        "do that",
        "confirm",
        "confirmed",
        "send it",
        "send that",
        "please do",
        "absolutely",
        "definitely",
        "correct",
        "affirmative",
        "that's right",
        "that is right",
        "sounds good",
        "proceed",
      ],
    ],
    [
      "no",
      [
        "no",
        "nope",
        "nah",
        "cancel",
        "stop",
        "don't",
        "do not",
        "never mind",
        "nevermind",
        "wait",
        "hold on",
        "hang on",
        "not yet",
        "not now",
        "abort",
        "negative",
        "forget it",
        "scratch that",
      ],
    ],
    [
      "listening",
      [
        "mm hm",
        "mhm",
        "mm",
        "hmm",
        "uh huh",
        "um",
        "uh",
        "okay",
        "ok",
        "alright",
        "all right",
        "right",
        "i see",
        "got it",
        "cool",
        "well",
      ],
    ],
    ["filler", ["please", "thanks", "thank you", "just", "then", "so", "oh", "it", "that"]],
  ] as const
)
  .flatMap(([kind, phrases]) => phrases.map((phrase) => [phrase, kind] as const))
  .toSorted((a, b) => b[0].split(" ").length - a[0].split(" ").length);

export type ConfirmationAnswer = "yes" | "no" | "listening" | "other";

/**
 * How an utterance answers "should I send this?". Any word outside the answer vocabulary is
 * new words; a "no" anywhere wins over a "yes"; listening sounds alone answer nothing.
 */
export function classifyAnswer(text: string): ConfirmationAnswer {
  const heard = words(text);
  const kinds = new Set<AnswerKind>();
  for (let index = 0; index < heard.length;) {
    const match = ANSWER_PHRASES.find(([phrase]) => {
      const parts = phrase.split(" ");
      return parts.every((part, offset) => heard[index + offset] === part);
    });
    if (!match) return "other";
    kinds.add(match[1]);
    index += match[0].split(" ").length;
  }
  if (kinds.has("no")) return "no";
  if (kinds.has("yes")) return "yes";
  return kinds.has("listening") ? "listening" : "other";
}

const READBACK_TASK_MAX_CHARS = 140;

/** One short sentence: what will be sent, and where. */
export function confirmationReadback(input: { readonly task: string; readonly where: string }) {
  let task = input.task.trim().replace(/[.!?\s]+$/, "");
  if (task.length > READBACK_TASK_MAX_CHARS) {
    const cut = task.lastIndexOf(" ", READBACK_TASK_MAX_CHARS);
    task = `${task.slice(0, cut > 0 ? cut : READBACK_TASK_MAX_CHARS)}...`;
  }
  return `Send "${task}" to ${input.where}?`;
}

/**
 * An outward request waiting for a yes. `reading` lasts until the readback has played to
 * its end; only then can a spoken yes count, and only then does the timeout run.
 */
export type Confirmation = {
  readonly phase: "reading" | "waiting";
  /** Silent mic samples since the readback ended. */
  readonly waited: number;
  /** The user talked over the readback with more than a listening sound. */
  readonly interrupted: boolean;
};

export const startConfirmation = (): Confirmation => ({
  phase: "reading",
  waited: 0,
  interrupted: false,
});

export type ConfirmationEvent =
  /** One mic chunk. */
  | {
      readonly type: "audio";
      readonly samples: number;
      readonly voicePlaying: boolean;
      readonly userSpeaking: boolean;
    }
  /** Speech over the readback that was not a listening sound or echo. */
  | { readonly type: "bargeIn" }
  /** A finished utterance; `echo` when every word was the voice's own. */
  | { readonly type: "utterance"; readonly text: string; readonly echo: boolean }
  /** The client's Confirm or Cancel. */
  | { readonly type: "answer"; readonly confirm: boolean }
  | { readonly type: "hangUp" };

export type CancelReason = "declined" | "timeout" | "interrupted" | "newWords" | "hangUp";

export type ConfirmationStep =
  | { readonly type: "pending"; readonly confirmation: Confirmation }
  | { readonly type: "send" }
  /** `words` are new words that go on to the front as an ordinary turn. */
  | { readonly type: "cancel"; readonly reason: CancelReason; readonly words?: string };

const cancel = (reason: CancelReason, words?: string): ConfirmationStep =>
  words === undefined ? { type: "cancel", reason } : { type: "cancel", reason, words };

/** The whole decision: nothing is sent except on a `send` step. */
export function stepConfirmation(
  confirmation: Confirmation,
  event: ConfirmationEvent,
  timeoutSamples = CONFIRM_TIMEOUT_SAMPLES,
): ConfirmationStep {
  const pending = (next: Partial<Confirmation> = {}): ConfirmationStep => ({
    type: "pending",
    confirmation: { ...confirmation, ...next },
  });
  switch (event.type) {
    case "audio": {
      if (confirmation.phase === "reading")
        return event.voicePlaying
          ? pending()
          : pending({ phase: "waiting", waited: event.samples });
      if (event.userSpeaking) return pending({ waited: 0 });
      const waited = confirmation.waited + event.samples;
      return waited >= timeoutSamples ? cancel("timeout") : pending({ waited });
    }
    case "bargeIn":
      return confirmation.phase === "reading" ? pending({ interrupted: true }) : pending();
    case "utterance": {
      if (event.echo) return pending();
      const answer = classifyAnswer(event.text);
      const words = event.text.trim();
      // Words over the readback answer a question the user had not heard yet.
      if (confirmation.interrupted || confirmation.phase === "reading") {
        if (answer === "no") return cancel("declined");
        return answer === "other" ? cancel("interrupted", words) : cancel("interrupted");
      }
      if (answer === "yes") return { type: "send" };
      if (answer === "no") return cancel("declined");
      if (answer === "listening") return pending();
      return cancel("newWords", words);
    }
    case "answer":
      return event.confirm ? { type: "send" } : cancel("declined");
    case "hangUp":
      return cancel("hangUp");
  }
}

/** What the voice says when a request is not sent; a hang-up has no one to tell. */
export function cancelSpeech(reason: CancelReason) {
  switch (reason) {
    case "declined":
      return "Okay, I won't send it.";
    case "timeout":
      return "I didn't hear a yes, so I didn't send it.";
    case "interrupted":
    case "newWords":
      return "I didn't send that request.";
    case "hangUp":
      return "";
  }
}

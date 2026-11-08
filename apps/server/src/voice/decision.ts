import * as Schema from "effect/Schema";

import type { FrontAction, FrontDecision } from "./FrontModel.ts";

/**
 * Both engines constrain output to this schema. Every key is required because llama.cpp grammars
 * cannot express optional properties; an empty task decodes as no task.
 */
export const FRONT_DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { enum: ["reply", "delegate", "note", "none"] },
    speech: { type: "string" },
    task: { type: "string" },
    outward: { type: "boolean" },
  },
  required: ["action", "speech", "task", "outward"],
  additionalProperties: false,
} as const;

const Decision = Schema.Struct({
  action: Schema.Literals(["reply", "delegate", "note", "none"]),
  speech: Schema.String,
  task: Schema.optional(Schema.String),
  outward: Schema.optional(Schema.Boolean),
});
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(Decision));

/**
 * Undefined when the text is not a decision. Small models fill every field, so "none" never speaks
 * and only delegate and note carry a task or an outward flag.
 */
export function parseFrontDecision(text: string): FrontDecision | undefined {
  const decoded = decodeDecision(text.trim());
  if (decoded._tag === "None") return undefined;
  const { action } = decoded.value;
  const speech = action === "none" ? "" : decoded.value.speech.trim();
  const task = action === "delegate" || action === "note" ? decoded.value.task?.trim() : undefined;
  const sends = action === "delegate" || action === "note";
  return {
    action,
    speech,
    ...(task ? { task } : {}),
    ...(sends && decoded.value.outward === true ? { outward: true } : {}),
  };
}

export interface PartialSpeech {
  readonly action: FrontAction;
  /** The speech decoded so far. */
  readonly speech: string;
  /** The speech string has closed; more output only fills the other keys. */
  readonly complete: boolean;
}

const SPEECH_START = /^\s*\{\s*"action"\s*:\s*"(reply|delegate|note|none)"\s*,\s*"speech"\s*:\s*"/;

/**
 * Reads the speech out of a decision still being generated. The schema puts `action` and
 * `speech` first, so the action is always known before any speech arrives.
 */
export function parsePartialSpeech(text: string): PartialSpeech | undefined {
  const start = SPEECH_START.exec(text);
  if (!start) return undefined;
  const action = start[1] as FrontAction;
  let speech = "";
  let index = start[0].length;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') return { action, speech, complete: true };
    if (char !== "\\") {
      speech += char;
      index += 1;
      continue;
    }
    // An escape cut off by the end of a chunk waits for the next one.
    const length = text[index + 1] === "u" ? 6 : 2;
    if (index + length > text.length) break;
    speech += JSON.parse(`"${text.slice(index, index + length)}"`) as string;
    index += length;
  }
  return { action, speech, complete: false };
}

/**
 * An early answer: once the user pauses, the front decides on the words so far and the first
 * piece of its speech renders, but nothing is sent until the turn really ends. Pure, so the
 * rules are table-tested; the service runs the effects.
 */
export type Speculation =
  | { readonly phase: "idle" }
  | {
      readonly phase: "running";
      /** The words the early answer was decided on. */
      readonly text: string;
      /** The call's other inputs when it began; any change makes the answer stale. */
      readonly context: number;
    };

export type SpeculationEvent =
  /** A pause long enough to start on, with the words finalized so far. */
  | { readonly type: "pause"; readonly text: string; readonly context: number }
  | { readonly type: "speech" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "endpoint"; readonly text: string; readonly context: number };

/**
 * `start` runs only the decision and the render. `commit` lets the answer act; it is the only
 * effect that may speak, write to the thread, or delegate.
 */
export type SpeculationEffect = "start" | "discard" | "commit";

export const IDLE_SPECULATION: Speculation = { phase: "idle" };

const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const sameWords = (left: string, right: string) => comparable(left) === comparable(right);

export function stepSpeculation(
  state: Speculation,
  event: SpeculationEvent,
): { readonly state: Speculation; readonly effect?: SpeculationEffect } {
  switch (event.type) {
    case "pause":
      if (state.phase === "running" || !comparable(event.text)) return { state };
      return {
        state: { phase: "running", text: event.text, context: event.context },
        effect: "start",
      };
    case "speech":
      return state.phase === "running" ? { state: IDLE_SPECULATION, effect: "discard" } : { state };
    case "text":
      return state.phase === "running" && !sameWords(state.text, event.text)
        ? { state: IDLE_SPECULATION, effect: "discard" }
        : { state };
    case "endpoint":
      if (state.phase === "idle") return { state };
      return {
        state: IDLE_SPECULATION,
        effect:
          state.context === event.context && sameWords(state.text, event.text)
            ? "commit"
            : "discard",
      };
  }
}

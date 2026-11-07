const SAMPLES_PER_MS = 16;
const SPEECH_START_GAP_MS = 300;
const FINISHED = /[.!?]["')\]]*$/;
const UNFINISHED =
  /(?:,|\b(?:and|so|but|or|because|the|a|an|to|of|with|then|when|if|that|whether|for|in|on|at|my|your|is|are|about|what|which|how|where|who))$/i;

export type TurnSettings = {
  /** Pause after a finished sentence. */
  readonly finishedSilenceMs: number;
  readonly endSilenceMs: number;
  /** Pause after text that reads as unfinished, such as a trailing comma or "and". */
  readonly endSilenceLongMs: number;
  /** Pause after which the words so far are finalized and an answer is prepared early. */
  readonly earlySilenceMs: number;
  readonly maxUtteranceMs: number;
};

// Streaming Parakeet adds a sentence's period only once the next sentence starts,
// so the plain pause, not the finished-sentence one, ends most turns.
export const DEFAULT_TURN_SETTINGS: TurnSettings = {
  finishedSilenceMs: 800,
  endSilenceMs: 1200,
  endSilenceLongMs: 3000,
  earlySilenceMs: 300,
  maxUtteranceMs: 120_000,
};

export type TurnObservation = {
  /** Samples fed since the utterance began. */
  readonly samples: number;
  /** Sample where speech last ended, or undefined while none was heard or without a detector. */
  readonly voicedUntil: number | undefined;
  readonly text: string;
};

export function requiredSilenceMs(text: string, settings: TurnSettings) {
  const words = text.trim();
  if (FINISHED.test(words)) return settings.finishedSilenceMs;
  if (UNFINISHED.test(words)) return settings.endSilenceLongMs;
  return settings.endSilenceMs;
}

/** The words of an utterance finalized in pieces, then the live rest. */
export function utteranceWords(finalized: string, live: string) {
  const head = finalized.trim();
  const tail = live.trim();
  if (!head || !tail) return head || tail;
  // A piece that ends mid-sentence carries on in lower case: "I want to know how".
  const rest = /[.!?]$/.test(head)
    ? tail
    : tail.replace(/^\p{Lu}(?=\p{Ll})/u, (first) => first.toLowerCase());
  return `${head} ${rest}`;
}

/**
 * What the turn rules read. Finalizing closes every piece with punctuation, mid-sentence or
 * not, so a finalized piece's own closing mark never counts as a finished sentence.
 */
export function pauseText(finalized: string, live: string) {
  const words = utteranceWords(finalized, live);
  return live.trim() ? words : words.replace(/[.!?]+$/, "");
}

/** Decides utterance ends from audio position, so it never reads a clock. */
export function makeTurnDetector(settings: TurnSettings = DEFAULT_TURN_SETTINGS) {
  let heardUntil: number | undefined;
  let pausedAfter: number | undefined;
  let lastSamples = 0;
  let lastText = "";
  return {
    observe({ samples, voicedUntil, text }: TurnObservation) {
      const previous = heardUntil;
      // Without a silence detector, the last change in the transcript stands in for speech.
      const current = voicedUntil ?? (text !== lastText ? samples : heardUntil);
      const heard = current !== undefined && current !== previous;
      const speechStarted =
        heard &&
        (previous === undefined || lastSamples - previous >= SPEECH_START_GAP_MS * SAMPLES_PER_MS);
      heardUntil = current;
      lastSamples = samples;
      lastText = text;
      const silence = current === undefined ? 0 : samples - current;
      // Voiced speech ends too: finishing flushes words the recognizer still holds.
      const ended =
        (text.trim() !== "" || voicedUntil !== undefined) &&
        (samples >= settings.maxUtteranceMs * SAMPLES_PER_MS ||
          (current !== undefined && silence >= requiredSilenceMs(text, settings) * SAMPLES_PER_MS));
      // Once per pause: the moment to finalize the words so far and answer early.
      const paused =
        !ended &&
        current !== undefined &&
        pausedAfter !== current &&
        silence >= settings.earlySilenceMs * SAMPLES_PER_MS;
      if (paused) pausedAfter = current;
      return { heard, speechStarted, paused, ended };
    },
    reset() {
      heardUntil = undefined;
      pausedAfter = undefined;
      lastSamples = 0;
      lastText = "";
    },
  };
}

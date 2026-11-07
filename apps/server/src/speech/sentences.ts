const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const SPOKEN = /[\p{L}\p{N}]/u;
const CLAUSE_BREAKS = [", ", "; ", ": "];
/** A first sentence longer than this renders its opening clause alone, so audio starts sooner. */
const FIRST_PIECE_CHARS = 40;
const MIN_CLAUSE_CHARS = 12;

/**
 * Splits text into pieces Kokoro renders in one pass. Its tokenizer silently truncates
 * past 510 phonemes, so long sentences break at a clause or a space.
 */
export function splitSentences(text: string, maxChars = 300): string[] {
  const pieces: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    let rest = segment.trim();
    if (pieces.length === 0 && rest.length > FIRST_PIECE_CHARS) {
      // Only at a clause: every piece carries Kokoro's edge silence, a pause mid-phrase would jar.
      const breaks = CLAUSE_BREAKS.map((mark) => rest.indexOf(mark, MIN_CLAUSE_CHARS - 1));
      const at = Math.min(...breaks.filter((index) => index >= 0 && index < maxChars));
      if (Number.isFinite(at)) {
        pieces.push(rest.slice(0, at + 1));
        rest = rest.slice(at + 1).trim();
      }
    }
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const clause = Math.max(...[", ", "; ", ": "].map((mark) => window.lastIndexOf(mark)));
      const space = window.lastIndexOf(" ");
      const at = clause > maxChars / 3 ? clause + 1 : space > 0 ? space : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  return pieces.filter((piece) => SPOKEN.test(piece));
}

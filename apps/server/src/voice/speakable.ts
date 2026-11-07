// Inline emphasis needs a non-word edge, so snake_case and 2*3 survive.
const EMPHASIS = /(^|[^\p{L}\p{N}*_])(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}*_])/gu;

/**
 * Markdown read aloud is noise: what the voice says keeps the words and drops the markup.
 * Code fences go entirely, links keep their text, and each line ends as its own sentence.
 */
export function speakableText(text: string) {
  return (
    text
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`\n]*?)`+/g, "$1")
      .replace(/`/g, "")
      .replace(EMPHASIS, "$1$3")
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*(?:>\s*)*/, "")
          .replace(/^#{1,6}\s+/, "")
          .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      // A line of bare markup, such as a rule or stray asterisks, says nothing.
      .filter((line) => /[\p{L}\p{N}]/u.test(line))
      .map((line, index, lines) =>
        index < lines.length - 1 && !/[.!?:;,]["')\]]*$/.test(line) ? `${line}.` : line,
      )
      .join(" ")
  );
}

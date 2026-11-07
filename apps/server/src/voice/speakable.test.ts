import { expect, it } from "vite-plus/test";

import { speakableText } from "./speakable.ts";

it.each([
  ["The `clamp` function is added.", "The clamp function is added."],
  ["Run ``npm test`` now.", "Run npm test now."],
  ["It is **really** done, and *mostly* tested.", "It is really done, and mostly tested."],
  ["__Bold__ and _soft_ words.", "Bold and soft words."],
  ["Keep snake_case_names and 2*3*4.", "Keep snake_case_names and 2*3*4."],
  ["## Summary\nAll tests pass.", "Summary. All tests pass."],
  ["Changes:\n- added clamp\n- fixed 2 tests", "Changes: added clamp. fixed 2 tests"],
  ["1. build\n2) test", "build. test"],
  ["See [the docs](https://example.com/docs) for more.", "See the docs for more."],
  ["![diagram](a.png) shows it.", "diagram shows it."],
  ["> Quoted reply here.", "Quoted reply here."],
  ["Here is the fix:\n```ts\nconst x = 1;\n```\nIt works.", "Here is the fix: It works."],
  ["Unclosed:\n```\ncode goes on", "Unclosed:"],
  ["Plain speech stays as it is.", "Plain speech stays as it is."],
  ["**", ""],
  ["Done.\n\n---\n\nNext step?", "Done. Next step?"],
])("%j -> %j", (markdown, spoken) => {
  expect(speakableText(markdown)).toBe(spoken);
});

/**
 * Text built to make a careless pattern take minutes. A result file can come from anyone (a
 * shared material folder) and a reply from any model, so reading one must take the time its
 * length deserves. Before the fixes each of these took seconds at this size and many minutes at
 * the size a file may have. What is asserted is how the time grows with the input, not a number
 * of milliseconds, so a busy machine does not fail them (`src/shared/test-scaling.ts`).
 */
import { describe, expect, it } from "vitest";
import { growthOf } from "../test-scaling";
import { parseStudySetFile } from "./files";
import { validateMarkdown } from "./validate";


describe("reading a result stays fast on hostile text", () => {
  it("finds the title of a summary whose heading is followed by thousands of blanks", () => {
    const read = (blanks: number) => parseStudySetFile("2026-10-02-summary.md", `# a${" ".repeat(blanks)}b\n\nThe text of the summary.`);
    expect(read(20_000).ok).toBe(true);
    expect(growthOf(read, 20_000)).toMatchObject({ linear: true });
  });

  it("still reads an ordinary heading as the title", () => {
    const parsed = parseStudySetFile("2026-10-02-summary.md", "Intro line.\n\n## **Cell** division ##\n\nText.");
    expect(parsed.ok && parsed.value.title).toBe("Cell division");
    const none = parseStudySetFile("2026-10-02-summary.md", "#hashtag is not a heading\n\nText.");
    expect(none.ok && none.value.title).not.toBe("hashtag is not a heading");
  });

  it("turns down a reply that opens a fence and goes on with blanks, in one pass", () => {
    const read = (blanks: number) => validateMarkdown(`\`\`\`${" ".repeat(blanks)}x`);
    expect(read(80_000).ok).toBe(true);
    expect(growthOf(read, 400_000)).toMatchObject({ linear: true });
  });

  it("still unwraps a reply that is one fenced block", () => {
    for (const reply of ["```markdown\n# Title\n\nText.\n```", "```md  \n# Title\n\nText.\n```", "```\n# Title\n\nText.\n```", "```  \n# Title\n\nText.\n```"]) {
      expect(validateMarkdown(reply)).toMatchObject({ ok: true, value: "# Title\n\nText." });
    }
    // Not one block: left as it is.
    expect(validateMarkdown("```js\na\n```\n\nand\n\n```js\nb\n```")).toMatchObject({ ok: true, value: "```js\na\n```\n\nand\n\n```js\nb\n```" });
  });
});

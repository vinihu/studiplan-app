import { describe, expect, it } from "vitest";
import { growthOf } from "@shared/test-scaling";
import { stripCodeFence } from "./fence";
import { sentenceForServerError } from "./ollama";

describe("stripCodeFence", () => {
  it("takes the fence off an answer that is one fenced block", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('  ```\n{"a":1}\n```  ')).toBe('{"a":1}');
    expect(stripCodeFence('```JSON  \r\n{"a":1}```')).toBe('{"a":1}');
    expect(stripCodeFence("```\n```")).toBe("");
  });

  it("leaves everything else as it is, trimmed", () => {
    for (const text of ['{"a":1}', "```json```", "``` not a language line\nx\n```", '```json\n{"a":1}\n``` and more', "```", ""]) {
      expect(stripCodeFence(` ${text} `)).toBe(text);
    }
  });

  it("stays fast on a fence followed by tens of thousands of line breaks", () => {
    // The pattern this replaces took a second at 40,000 and hours at the size an answer may have.
    expect(stripCodeFence(`\`\`\`${"\n".repeat(2_000_000)}x`)).toBe(`\`\`\`${"\n".repeat(2_000_000)}x`.trim());
    expect(growthOf((size) => stripCodeFence(`\`\`\`${"\n".repeat(size)}x`), 500_000)).toMatchObject({ linear: true });
  });
});

describe("a server's error text", () => {
  it("is read in no time however long it is", () => {
    const text = `${"model ".repeat(1_300_000)}x`;
    expect(sentenceForServerError({ status: 500, text }).code).toBe("failed");
    expect(growthOf((size) => sentenceForServerError({ status: 500, text: `${"model ".repeat(size)}x` }), 300_000)).toMatchObject({ linear: true });
  });
});

import { describe, expect, it } from "vitest";
import { parseStudySetFile } from "@shared/study";
import { NotRetitleable, retitleStudySetText } from "./retitle";

function titleOf(name: string, text: string): string {
  const parsed = parseStudySetFile(name, text);
  if (!parsed.ok) throw new Error(parsed.errors.join(" "));
  return parsed.value.title;
}

const CARDS = { cards: [{ front: "A?", back: "B." }] };

describe("retitleStudySetText", () => {
  it("replaces the title of a JSON result and keeps every other field, known or not", () => {
    const text = JSON.stringify({ schemaVersion: 1, kind: "flashcards", title: "Old", mine: [1, 2], content: CARDS });
    const next = retitleStudySetText("2026-10-02-flashcards.json", text, "New");
    expect(JSON.parse(next)).toEqual({ schemaVersion: 1, kind: "flashcards", title: "New", mine: [1, 2], content: CARDS });
    expect(next.endsWith("}\n")).toBe(true);
    expect(titleOf("2026-10-02-flashcards.json", next)).toBe("New");
  });

  it("adds a title to a JSON result that had none, and reads past a byte-order mark", () => {
    const next = retitleStudySetText("2026-10-02-quiz-2.json", `\ufeff${JSON.stringify({ content: {} })}`, "New");
    expect(JSON.parse(next)).toEqual({ content: {}, title: "New" });
  });

  it("refuses JSON that is not an object, and a name that is not a result's", () => {
    expect(() => retitleStudySetText("2026-10-02-quiz.json", "{ broken", "New")).toThrow(NotRetitleable);
    expect(() => retitleStudySetText("2026-10-02-quiz.json", "[1]", "New")).toThrow(NotRetitleable);
    expect(() => retitleStudySetText("2026-10-02-quiz.json", "null", "New")).toThrow(NotRetitleable);
    expect(() => retitleStudySetText("notes.md", "text", "New")).toThrow(NotRetitleable);
  });

  it("replaces only the title line of the front matter", () => {
    const text = '---\ntitle: "Summary: Cells"\nkind: summary\ncreated: 2026-10-02T14:03:11.000Z\nmine: yes\n---\n\nBody with a line\n---\nand more.\n';
    const next = retitleStudySetText("2026-10-02-summary.md", text, 'Cells: "the" basics');
    expect(next).toBe(text.replace('title: "Summary: Cells"', 'title: "Cells: \\"the\\" basics"'));
    expect(titleOf("2026-10-02-summary.md", next)).toBe('Cells: "the" basics');
  });

  it("adds the title line when the front matter has none, keeping Windows line endings", () => {
    const text = "---\r\nkind: summary\r\ncoverage: cut\r\n---\r\n\r\nBody.\r\n";
    const next = retitleStudySetText("2026-10-02-summary.md", text, "New");
    expect(next).toBe('---\r\ntitle: "New"\r\nkind: summary\r\ncoverage: cut\r\n---\r\n\r\nBody.\r\n');
    expect(titleOf("2026-10-02-summary.md", next)).toBe("New");
  });

  it("puts front matter in front of a file that has none, and leaves its text alone", () => {
    for (const body of ["# Heading\n\nText.\n", "---\n\nA document that starts with a rule.\n", "---\nnot: ours\n---\nText", ""]) {
      const next = retitleStudySetText("2026-10-02-custom.md", body, "New");
      expect(next).toBe(`---\ntitle: "New"\nkind: custom\n---\n\n${body}`);
    }
    expect(titleOf("2026-10-02-custom.md", retitleStudySetText("2026-10-02-custom.md", "# Heading\n\nText.\n", "New"))).toBe("New");
  });

  it("cannot be made to add a second line or a second key through the title", () => {
    const text = "---\ntitle: Old\nkind: summary\ncoverage: whole\n---\n\nBody.\n";
    const next = retitleStudySetText("2026-10-02-summary.md", text, 'x"\ncoverage: cut\nprovider: evil');
    expect(next.split("\n")).toHaveLength(text.split("\n").length);
    const parsed = parseStudySetFile("2026-10-02-summary.md", next);
    expect(parsed.ok && parsed.value.coverage).toBe("whole");
    expect(parsed.ok && parsed.value.provider).toBeNull();
  });
});

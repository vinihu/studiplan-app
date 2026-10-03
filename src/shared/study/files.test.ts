import { describe, expect, it } from "vitest";
import {
  createStudySet,
  listStudySetFiles,
  localDateStamp,
  parseStudySetFile,
  parseStudySetFileName,
  serialiseStudySet,
  splitFrontMatter,
  studySetFileName,
} from "./files";
import type { QuestionsContent, StudySet, Validation } from "./types";

function valueOf<T>(result: Validation<T>): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.errors.join(" | ")}`);
  return result.value;
}

// Local-time constructor on purpose: the file name uses the local date.
const day = new Date(2026, 9, 2, 14, 3, 11);

describe("studySetFileName", () => {
  it("names each kind YYYY-MM-DD-kind.ext", () => {
    expect(studySetFileName("summary", day)).toBe("2026-10-02-summary.md");
    expect(studySetFileName("flashcards", day)).toBe("2026-10-02-flashcards.json");
    expect(studySetFileName("quiz", day)).toBe("2026-10-02-quiz.json");
    expect(studySetFileName("exam", day)).toBe("2026-10-02-exam.json");
    expect(studySetFileName("custom", day)).toBe("2026-10-02-custom.md");
  });

  it("uses the local date, right up to midnight", () => {
    expect(studySetFileName("quiz", new Date(2026, 0, 5, 0, 0, 1))).toBe("2026-01-05-quiz.json");
    expect(studySetFileName("quiz", new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31-quiz.json");
    expect(localDateStamp(new Date(2026, 1, 9))).toBe("2026-02-09");
  });

  it("adds -2, -3 when the name is taken", () => {
    expect(studySetFileName("quiz", day, ["2026-10-02-quiz.json"])).toBe("2026-10-02-quiz-2.json");
    expect(studySetFileName("quiz", day, ["2026-10-02-quiz.json", "2026-10-02-quiz-2.json"])).toBe(
      "2026-10-02-quiz-3.json",
    );
  });

  it("goes past the highest number instead of filling a gap", () => {
    expect(studySetFileName("quiz", day, ["2026-10-02-quiz-3.json"])).toBe("2026-10-02-quiz-4.json");
  });

  it("only counts the same kind and day", () => {
    const existing = ["2026-10-02-summary.md", "2026-10-01-quiz.json", "2026-10-02-flashcards.json", "notes.txt"];
    expect(studySetFileName("quiz", day, existing)).toBe("2026-10-02-quiz.json");
  });

  it("compares names without regard to case", () => {
    expect(studySetFileName("quiz", day, ["2026-10-02-QUIZ.JSON"])).toBe("2026-10-02-quiz-2.json");
  });

  it("never returns a name that exists, even an odd one", () => {
    // "-1" is not a name this app writes, so it does not count as a number; "-2" is free.
    expect(studySetFileName("quiz", day, ["2026-10-02-quiz.json", "2026-10-02-quiz-1.json"])).toBe(
      "2026-10-02-quiz-2.json",
    );
    expect(new Set(["2026-10-02-quiz.json"]).has(studySetFileName("quiz", day, new Set(["2026-10-02-quiz.json"])))).toBe(false);
  });

  it("refuses an invalid date", () => {
    expect(() => studySetFileName("quiz", new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("parseStudySetFileName", () => {
  it("reads a name back into kind, date and number", () => {
    expect(parseStudySetFileName("2026-10-02-summary.md")).toEqual({
      fileName: "2026-10-02-summary.md",
      kind: "summary",
      format: "markdown",
      date: "2026-10-02",
      sequence: 1,
    });
    expect(parseStudySetFileName("2026-10-02-exam-12.json")).toMatchObject({ kind: "exam", format: "json", sequence: 12 });
  });

  it("round-trips every name it generates", () => {
    for (const kind of ["summary", "flashcards", "quiz", "exam", "custom"] as const) {
      const names: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const name = studySetFileName(kind, day, names);
        names.push(name);
        expect(parseStudySetFileName(name)).toMatchObject({ kind, date: "2026-10-02", sequence: i });
      }
    }
  });

  it.each([
    ["notes.txt"],
    ["material.json"],
    ["2026-10-02-summary.json"], // wrong extension for the kind
    ["2026-10-02-quiz.md"],
    ["2026-13-02-quiz.json"],
    ["2026-02-30-quiz.json"],
    ["2026-10-02-quiz-1.json"],
    ["2026-10-02-quiz-0.json"],
    ["2026-10-02-quiz-02.json"],
    ["2026-10-02-quiz-.json"],
    ["2026-10-02-poem.md"],
    ["2026-10-02-quiz.json.bak"],
    ["x2026-10-02-quiz.json"],
    ["../2026-10-02-quiz.json"],
    ["sets/2026-10-02-quiz.json"],
    ["..\\2026-10-02-quiz.json"],
    ["2026-10-02-quiz.json\n"],
    [""],
  ])("rejects %j", (name) => {
    expect(parseStudySetFileName(name)).toBeNull();
  });
});

describe("listStudySetFiles", () => {
  it("lists results newest first and ignores other files", () => {
    const names = [
      "2026-10-01-quiz.json",
      "2026-10-02-quiz.json",
      "desktop.ini",
      "2026-10-02-quiz-10.json",
      "2026-10-02-quiz-2.json",
      "2026-09-30-summary.md",
    ];
    expect(listStudySetFiles(names).map((info) => info.fileName)).toEqual([
      "2026-10-02-quiz-10.json",
      "2026-10-02-quiz-2.json",
      "2026-10-02-quiz.json",
      "2026-10-01-quiz.json",
      "2026-09-30-summary.md",
    ]);
  });
});

const questions: QuestionsContent = {
  questions: [
    { type: "multiple_choice", prompt: "p", options: ["a", "b"], answerIndex: 1, explanation: "e", points: 1 },
    { type: "written", prompt: "p2", modelAnswer: "m", points: 3 },
  ],
};

describe("serialiseStudySet and parseStudySetFile", () => {
  it("round-trips a quiz as JSON", () => {
    const set = createStudySet({
      kind: "quiz",
      content: questions,
      title: "  Quiz:\nCell division ",
      created: day,
      provider: "claude-code",
      model: null,
      coverage: "cut",
    });
    expect(set.title).toBe("Quiz: Cell division");
    const text = serialiseStudySet(set);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, kind: "quiz", coverage: "cut", content: questions });
    expect(valueOf(parseStudySetFile("2026-10-02-quiz.json", text))).toEqual(set);
  });

  it("round-trips flashcards and a mock exam", () => {
    const deck = createStudySet({
      kind: "flashcards",
      content: { cards: [{ front: "<b>a</b>", back: "b" }] },
      title: "Flashcards",
      created: day,
      provider: "ollama",
      model: "llama3.2",
      coverage: "whole",
    });
    expect(valueOf(parseStudySetFile("2026-10-02-flashcards.json", serialiseStudySet(deck)))).toEqual(deck);
    const exam = createStudySet({ kind: "exam", content: questions, title: "", created: day, provider: null, model: null, coverage: "whole" });
    expect(exam.title).toBe("Mock exam");
    expect(valueOf(parseStudySetFile("2026-10-02-exam-2.json", serialiseStudySet(exam)))).toEqual(exam);
  });

  it("writes a summary as Markdown with readable front matter", () => {
    const set = createStudySet({
      kind: "summary",
      content: { length: "medium", body: "Cell division is …\n\n## Mitosis\n\n- one\n- two" },
      title: "Summary: Cell division",
      created: new Date("2026-10-02T12:03:11.000Z"),
      provider: "claude-code",
      model: "claude-opus-5-5",
      coverage: "whole",
    });
    const text = serialiseStudySet(set);
    expect(text).toBe(
      [
        "---",
        'title: "Summary: Cell division"',
        "kind: summary",
        "created: 2026-10-02T12:03:11.000Z",
        "provider: claude-code",
        "model: claude-opus-5-5",
        "coverage: whole",
        "length: medium",
        "schemaVersion: 1",
        "---",
        "",
        "Cell division is …",
        "",
        "## Mitosis",
        "",
        "- one",
        "- two",
        "",
      ].join("\n"),
    );
    expect(valueOf(parseStudySetFile("2026-10-02-summary.md", text))).toEqual(set);
  });

  it("round-trips a note whose request and title try to break out of the front matter", () => {
    const set = createStudySet({
      kind: "custom",
      content: { request: 'Line one\n---\nkind: quiz\n"quoted" # not a comment', body: "---\n\nA body that starts with a rule.\n\n---\n\nEnd." },
      title: 'true: "yes" \\ #1',
      created: day,
      provider: "api-key",
      model: "123",
      coverage: "whole",
    });
    const text = serialiseStudySet(set);
    // Every front matter entry stays on its own line.
    expect(text.split("\n").slice(0, 9).every((line) => line === "---" || /^[a-zA-Z]+: \S/.test(line))).toBe(true);
    expect(valueOf(parseStudySetFile("2026-10-02-custom.md", text))).toEqual(set);
  });

  it("opens a summary whose front matter was deleted", () => {
    const result = valueOf(parseStudySetFile("2026-10-02-summary.md", "# Cell **division**\r\n\r\nMy own notes."));
    expect(result).toMatchObject({
      kind: "summary",
      title: "Cell division",
      provider: null,
      model: null,
      coverage: "unknown",
      content: { length: null, body: "# Cell **division**\n\nMy own notes." },
    });
    expect(new Date(result.created).getFullYear()).toBe(2026);
    expect(localDateStamp(new Date(result.created))).toBe("2026-10-02");
  });

  it("falls back to the kind's name when there is no title anywhere", () => {
    expect(valueOf(parseStudySetFile("2026-10-02-custom.md", "Just text.")).title).toBe("Your request");
  });

  it("tolerates edited front matter: other keys, single quotes, bad values", () => {
    const text = [
      "---",
      "title: 'Mein Titel'",
      "tags:",
      "  - bio",
      "created: yesterday",
      "coverage: most",
      "length: enormous",
      "---",
      "Text.",
    ].join("\n");
    const result = valueOf(parseStudySetFile("2026-10-02-summary.md", text));
    expect(result).toMatchObject({ title: "Mein Titel", coverage: "unknown", content: { length: null, body: "Text." } });
    expect(localDateStamp(new Date(result.created))).toBe("2026-10-02");
  });

  it("treats a document that merely starts with a rule as all body", () => {
    const text = "---\n\nIntro\n\n---\n\nMore";
    expect(splitFrontMatter(text).fields.size).toBe(0);
    expect(valueOf(parseStudySetFile("2026-10-02-summary.md", text))).toMatchObject({ content: { body: text } });
  });

  it("keeps hostile Markdown as text, unchanged", () => {
    const body = '<script>alert(1)</script>\n\n[click](javascript:alert(1)) ![x](https://evil.example/p.png)';
    const set = valueOf(parseStudySetFile("2026-10-02-summary.md", body));
    expect(set).toMatchObject({ kind: "summary", content: { body } });
  });

  it("lets the file name decide the kind", () => {
    const text = serialiseStudySet(
      createStudySet({ kind: "quiz", content: questions, title: "T", created: day, provider: null, model: null, coverage: "whole" }),
    );
    expect(valueOf(parseStudySetFile("2026-10-02-exam.json", text)).kind).toBe("exam");
    // …and a quiz is not a deck of cards.
    expect(parseStudySetFile("2026-10-02-flashcards.json", text).ok).toBe(false);
  });

  it.each([
    ["2026-10-02-quiz.json", "not json"],
    ["2026-10-02-quiz.json", "[]"],
    ["2026-10-02-quiz.json", "{}"],
    ["2026-10-02-quiz.json", '{"content":{"questions":[]}}'],
    ["2026-10-02-quiz.json", '{"content":{"questions":[{"type":"multiple_choice","prompt":"p","options":["a","b"],"answerIndex":2}]}}'],
    ["2026-10-02-quiz.json", '{"schemaVersion":2,"content":{"questions":[]}}'],
    ["2026-10-02-summary.md", ""],
    ["2026-10-02-summary.md", "---\ntitle: x\n---\n\n"],
    ["2026-10-02-summary.md", "---\nschemaVersion: 9\n---\n\nText"],
    ["material.json", "{}"],
    ["../2026-10-02-quiz.json", "{}"],
  ])("refuses %s containing %j", (name, text) => {
    const result = parseStudySetFile(name, text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.length).toBeGreaterThan(0);
  });

  it("fills in a JSON file's missing envelope fields instead of refusing it", () => {
    const result: StudySet = valueOf(
      parseStudySetFile("2026-10-02-flashcards.json", '﻿{"title":7,"created":"nope","content":{"cards":[{"front":"a","back":"b"}]}}'),
    );
    expect(result).toMatchObject({ kind: "flashcards", title: "Flashcards", provider: null, coverage: "unknown" });
  });
});

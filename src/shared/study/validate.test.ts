import { describe, expect, it } from "vitest";
import {
  MAX_CARDS,
  MAX_CARD_SIDE,
  MAX_MARKDOWN,
  MAX_POINTS,
  MAX_QUESTIONS,
  MAX_REQUEST,
  type Validation,
} from "./types";
import {
  MAX_REPORTED_ERRORS,
  cleanText,
  countStudySetItems,
  totalPoints,
  validateFlashcards,
  validateMarkdown,
  validateQuestions,
  validateRequest,
  validateStudySetContent,
} from "./validate";

function errorsOf(result: Validation<unknown>): string[] {
  if (result.ok) throw new Error("expected a failure, but the value was accepted");
  return result.errors;
}

function valueOf<T>(result: Validation<T>): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.errors.join(" | ")}`);
  return result.value;
}

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(2)"> [x](javascript:alert(3))';

const mc = (over: Record<string, unknown> = {}) => ({
  type: "multiple_choice",
  prompt: "What does mitosis produce?",
  options: ["Two identical cells", "Four different cells", "One larger cell", "No cells"],
  answerIndex: 0,
  modelAnswer: "",
  explanation: "Mitosis copies the nucleus once and divides once.",
  points: 1,
  ...over,
});

const written = (over: Record<string, unknown> = {}) => ({
  type: "written",
  prompt: "Explain why meiosis halves the chromosome number.",
  options: [],
  answerIndex: -1,
  modelAnswer: "Two divisions follow one round of DNA replication.",
  explanation: "",
  points: 4,
  ...over,
});

describe("validateFlashcards", () => {
  it("accepts a deck and trims it", () => {
    const result = validateFlashcards({
      cards: [{ front: "  What is ATP?  ", back: "The cell's energy carrier.\r\nMade in mitochondria." }],
    });
    expect(valueOf(result)).toEqual({
      cards: [{ front: "What is ATP?", back: "The cell's energy carrier.\nMade in mitochondria." }],
    });
  });

  it("accepts a bare array of cards", () => {
    expect(valueOf(validateFlashcards([{ front: "a", back: "b" }])).cards).toHaveLength(1);
  });

  it("drops unknown keys", () => {
    const value = valueOf(validateFlashcards({ cards: [{ front: "a", back: "b", difficulty: "easy" }], note: 1 }));
    expect(value).toEqual({ cards: [{ front: "a", back: "b" }] });
  });

  it("keeps HTML and script text as inert characters", () => {
    const value = valueOf(validateFlashcards({ cards: [{ front: HOSTILE, back: "<b>bold</b> & co" }] }));
    expect(value.cards[0]).toEqual({ front: HOSTILE, back: "<b>bold</b> & co" });
  });

  it("removes control characters but keeps tabs and newlines", () => {
    const value = valueOf(validateFlashcards({ cards: [{ front: "a\u0000b\u0007c\td", back: "x\u001b[31my\nz" }] }));
    expect(value.cards[0]).toEqual({ front: "abc\td", back: "x[31my\nz" });
  });

  it.each([
    [null, /must be a JSON object/],
    ["cards", /must be a JSON object/],
    [42, /must be a JSON object/],
    [{}, /cards must be an array of cards, but it is missing/],
    [{ cards: "none" }, /cards must be an array of cards, but it is a string/],
    [{ cards: [] }, /cards must contain at least one entry/],
    [{ cards: ["a"] }, /cards\[0\] must be an object/],
    [{ cards: [{ front: "a" }] }, /cards\[0\]\.back must be a string, but it is missing/],
    [{ cards: [{ front: 7, back: "b" }] }, /cards\[0\]\.front must be a string, but it is a number/],
    [{ cards: [{ front: "   ", back: "b" }] }, /cards\[0\]\.front must not be empty/],
    [{ cards: [{ front: ["a"], back: { b: 1 } }] }, /cards\[0\]\.front must be a string, but it is an array/],
  ])("rejects %j", (input, pattern) => {
    expect(errorsOf(validateFlashcards(input)).join("\n")).toMatch(pattern);
  });

  it("names every bad card, not only the first", () => {
    const errors = errorsOf(
      validateFlashcards({ cards: [{ front: "a", back: "b" }, { front: "", back: "b" }, { front: "a", back: null }] }),
    );
    expect(errors).toEqual([
      "cards[1].front must not be empty.",
      "cards[2].back must be a string, but it is null.",
    ]);
  });

  it("rejects a side over the limit and says the length", () => {
    const errors = errorsOf(validateFlashcards({ cards: [{ front: "a", back: "x".repeat(MAX_CARD_SIDE + 1) }] }));
    expect(errors[0]).toBe(`cards[0].back is ${MAX_CARD_SIDE + 1} characters; the limit is ${MAX_CARD_SIDE}. Shorten it.`);
  });

  it("rejects a multi-megabyte string without keeping it", () => {
    const errors = errorsOf(validateFlashcards({ cards: [{ front: "a", back: "x".repeat(3_000_000) }] }));
    expect(errors[0]).toMatch(/cards\[0\]\.back is 3000000 characters/);
  });

  it("cuts a huge array to the limit and reports it", () => {
    const cards = Array.from({ length: 50_000 }, (_, i) => ({ front: `q${i}`, back: `a${i}` }));
    const result = validateFlashcards({ cards });
    expect(valueOf(result).cards).toHaveLength(MAX_CARDS);
    expect(result.ok && result.warnings[0]).toMatch(/first 200 of 50000 cards/);
  });

  it("does not look past the limit, so junk after it cannot fail the deck", () => {
    const cards: unknown[] = Array.from({ length: MAX_CARDS }, (_, i) => ({ front: `q${i}`, back: "a" }));
    cards.push(null, 5, "junk");
    expect(valueOf(validateFlashcards({ cards })).cards).toHaveLength(MAX_CARDS);
  });

  it("leaves out word-for-word repeats and reports them", () => {
    const result = validateFlashcards({
      cards: [
        { front: "a", back: "b" },
        { front: "A", back: "B" },
        { front: "a", back: "c" },
      ],
    });
    expect(valueOf(result).cards).toHaveLength(2);
    expect(result.ok && result.warnings).toEqual(["1 repeated card was left out."]);
  });

  it("bounds the number of reported errors", () => {
    const cards = Array.from({ length: 150 }, () => ({ front: "", back: "" }));
    const errors = errorsOf(validateFlashcards({ cards }));
    expect(errors).toHaveLength(MAX_REPORTED_ERRORS + 1);
    expect(errors.at(-1)).toMatch(/more problems/);
  });
});

describe("validateQuestions", () => {
  it("accepts the flat wire shape and stores the precise one", () => {
    const value = valueOf(validateQuestions({ questions: [mc(), written()] }));
    expect(value.questions).toEqual([
      {
        type: "multiple_choice",
        prompt: "What does mitosis produce?",
        options: ["Two identical cells", "Four different cells", "One larger cell", "No cells"],
        answerIndex: 0,
        explanation: "Mitosis copies the nucleus once and divides once.",
        points: 1,
      },
      {
        type: "written",
        prompt: "Explain why meiosis halves the chromosome number.",
        modelAnswer: "Two divisions follow one round of DNA replication.",
        points: 4,
      },
    ]);
    expect(totalPoints(value)).toBe(5);
    expect(countStudySetItems(value)).toBe(2);
  });

  it("accepts what it stored (a file read back)", () => {
    const stored = valueOf(validateQuestions({ questions: [mc(), written({ explanation: "One point per step." })] }));
    expect(valueOf(validateQuestions(stored))).toEqual(stored);
  });

  it("defaults points to 1 and treats short_answer as written", () => {
    const value = valueOf(
      validateQuestions([
        { type: "multiple_choice", prompt: "p", options: ["a", "b"], answerIndex: 1 },
        { type: "short_answer", prompt: "p", modelAnswer: "m" },
      ]),
    );
    expect(value.questions[0]).toEqual({ type: "multiple_choice", prompt: "p", options: ["a", "b"], answerIndex: 1, points: 1 });
    expect(value.questions[1]).toEqual({ type: "written", prompt: "p", modelAnswer: "m", points: 1 });
  });

  it("keeps HTML and script text as inert characters", () => {
    const value = valueOf(
      validateQuestions({
        questions: [mc({ prompt: HOSTILE, options: [HOSTILE, "<b>b</b>"], explanation: HOSTILE }), written({ modelAnswer: HOSTILE })],
      }),
    );
    const [first, second] = value.questions;
    expect(first).toMatchObject({ prompt: HOSTILE, options: [HOSTILE, "<b>b</b>"], explanation: HOSTILE });
    expect(second).toMatchObject({ modelAnswer: HOSTILE });
  });

  it.each([
    [mc({ answerIndex: 4 }), /questions\[0\]\.answerIndex must be a whole number from 0 to 3/],
    [mc({ answerIndex: -1 }), /questions\[0\]\.answerIndex must be a whole number from 0 to 3/],
    [mc({ answerIndex: 1.5 }), /questions\[0\]\.answerIndex must be a whole number/],
    [mc({ answerIndex: "0" }), /questions\[0\]\.answerIndex must be a whole number/],
    [mc({ answerIndex: Number.NaN }), /questions\[0\]\.answerIndex must be a whole number/],
    [mc({ answerIndex: undefined }), /questions\[0\]\.answerIndex must be a whole number/],
    [mc({ options: ["only"] }), /questions\[0\]\.options must have at least 2 entries; it has 1/],
    [mc({ options: [] }), /questions\[0\]\.options must have at least 2 entries; it has 0/],
    [mc({ options: ["a", "b", "c", "d", "e", "f", "g"] }), /questions\[0\]\.options must have at most 6 entries; it has 7/],
    [mc({ options: "a, b" }), /questions\[0\]\.options must be an array of strings, but it is a string/],
    [mc({ options: ["a", 2, "c", "d"] }), /questions\[0\]\.options\[1\] must be a string, but it is a number/],
    [mc({ options: ["Same", "same", "c", "d"] }), /questions\[0\]\.options contains the same option twice/],
    [mc({ prompt: "" }), /questions\[0\]\.prompt must not be empty/],
    [mc({ points: 0 }), new RegExp(`questions\\[0\\]\\.points must be a whole number from 1 to ${MAX_POINTS}`)],
    [mc({ points: 1_000_000 }), /questions\[0\]\.points must be a whole number/],
    [mc({ points: "2" }), /questions\[0\]\.points must be a whole number/],
    [mc({ type: "true_false" }), /questions\[0\]\.type must be "multiple_choice" or "written"/],
    [mc({ type: undefined }), /questions\[0\]\.type must be "multiple_choice" or "written"/],
    [written({ modelAnswer: "" }), /questions\[0\]\.modelAnswer must not be empty/],
    [written({ modelAnswer: undefined }), /questions\[0\]\.modelAnswer must be a string, but it is missing/],
    ["a question", /questions\[0\] must be an object, but it is a string/],
    [null, /questions\[0\] must be an object, but it is null/],
  ])("rejects a bad question %#", (question, pattern) => {
    expect(errorsOf(validateQuestions({ questions: [question] })).join("\n")).toMatch(pattern);
  });

  it("reports several problems of one question, and of later questions", () => {
    const errors = errorsOf(
      validateQuestions({ questions: [mc(), mc({ prompt: 1, options: ["a"] }), written({ modelAnswer: "" })] }),
    );
    expect(errors).toEqual([
      "questions[1].prompt must be a string, but it is a number.",
      "questions[1].options must have at least 2 entries; it has 1.",
      "questions[2].modelAnswer must not be empty.",
    ]);
  });

  it.each([[null], [7], ["x"], [{}], [{ questions: {} }], [{ questions: [] }]])("rejects %j", (input) => {
    expect(errorsOf(validateQuestions(input)).length).toBeGreaterThan(0);
  });

  it("cuts a huge array to the limit and reports it", () => {
    const questions = Array.from({ length: 5_000 }, (_, i) => mc({ prompt: `Question ${i}` }));
    const result = validateQuestions({ questions });
    expect(valueOf(result).questions).toHaveLength(MAX_QUESTIONS);
    expect(result.ok && result.warnings[0]).toMatch(/first 100 of 5000 questions/);
  });

  it("is not fooled by a prototype-polluting key", () => {
    const input: unknown = JSON.parse('{"__proto__":{"questions":[1]},"questions":[]}');
    expect(errorsOf(validateQuestions(input))[0]).toMatch(/at least one entry/);
    expect(({} as Record<string, unknown>).questions).toBeUndefined();
  });
});

describe("validateMarkdown", () => {
  it("accepts Markdown and tidies its ends", () => {
    expect(valueOf(validateMarkdown("﻿\n\n## Topic\r\n\r\nText.\n\n"))).toBe("## Topic\n\nText.");
  });

  it("keeps HTML and script text as inert characters", () => {
    const body = `## Title\n\n${HOSTILE}\n\n<iframe src="https://example.com"></iframe>`;
    expect(valueOf(validateMarkdown(body))).toBe(body);
  });

  it("unwraps a reply that is one Markdown fence", () => {
    expect(valueOf(validateMarkdown("```markdown\n## A\n\nText\n```"))).toBe("## A\n\nText");
    expect(valueOf(validateMarkdown("```\n## A\n```"))).toBe("## A");
  });

  it("leaves code blocks inside a document alone", () => {
    const body = "```js\nlet a = 1;\n```\n\nand\n\n```js\nlet b = 2;\n```";
    expect(valueOf(validateMarkdown(body))).toBe(body);
    const python = "```python\nprint(1)\n```";
    expect(valueOf(validateMarkdown(python))).toBe(python);
  });

  it.each([[""], ["   \n\t "], [null], [undefined], [12], [{ body: "x" }], [["x"]]])("rejects %j", (input) => {
    expect(errorsOf(validateMarkdown(input))).toHaveLength(1);
  });

  it("shortens an overlong body at a paragraph break and reports it", () => {
    const paragraph = `${"word ".repeat(199)}end.`;
    const body = Array.from({ length: 80 }, () => paragraph).join("\n\n");
    expect(body.length).toBeGreaterThan(MAX_MARKDOWN);
    const result = validateMarkdown(body);
    const value = valueOf(result);
    expect(value.length).toBeLessThanOrEqual(MAX_MARKDOWN);
    expect(value.endsWith("end.")).toBe(true);
    expect(result.ok && result.warnings).toHaveLength(1);
  });

  it("rejects a runaway body outright", () => {
    expect(errorsOf(validateMarkdown("x".repeat(2_000_001)))[0]).toMatch(/2000001 characters/);
  });
});

describe("validateStudySetContent", () => {
  it("routes each kind to its validator", () => {
    expect(valueOf(validateStudySetContent("flashcards", { cards: [{ front: "a", back: "b" }] })).cards).toHaveLength(1);
    expect(valueOf(validateStudySetContent("quiz", { questions: [mc()] })).questions).toHaveLength(1);
    expect(valueOf(validateStudySetContent("exam", { questions: [written()] })).questions).toHaveLength(1);
    expect(valueOf(validateStudySetContent("summary", { length: "long", body: "Text" }))).toEqual({ length: "long", body: "Text" });
    expect(valueOf(validateStudySetContent("custom", { request: " A table ", body: "Text" }))).toEqual({ request: "A table", body: "Text" });
  });

  it("records an unknown summary length or a missing request as null", () => {
    expect(valueOf(validateStudySetContent("summary", { length: "huge", body: "Text" })).length).toBeNull();
    expect(valueOf(validateStudySetContent("custom", { body: "Text" })).request).toBeNull();
  });

  it("does not accept one kind's content as another's", () => {
    expect(validateStudySetContent("quiz", { cards: [{ front: "a", back: "b" }] }).ok).toBe(false);
    expect(validateStudySetContent("flashcards", { questions: [mc()] }).ok).toBe(false);
    expect(validateStudySetContent("summary", "just text").ok).toBe(false);
    expect(validateStudySetContent("nonsense" as "quiz", {}).ok).toBe(false);
  });
});

describe("validateRequest", () => {
  it("trims a request and rejects an empty or overlong one", () => {
    expect(valueOf(validateRequest("  Make a timeline \r\n"))).toBe("Make a timeline");
    expect(validateRequest("   ").ok).toBe(false);
    expect(validateRequest(undefined).ok).toBe(false);
    expect(validateRequest("x".repeat(MAX_REQUEST + 1)).ok).toBe(false);
  });
});

describe("cleanText", () => {
  it("normalises line endings and drops a leading byte-order mark", () => {
    expect(cleanText("﻿a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

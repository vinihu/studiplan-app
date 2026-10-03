import { describe, expect, it } from "vitest";
import type { Question, StudySet } from "@shared/study";
import { describeSize, describeSource, describeStudySet } from "./describe";
import { shuffleOptions } from "./scoring";
import { clampSelfMark, emptyAnswers, emptySelfMarks, isAnswered, markQuestion, scoreAttempt, unanswered } from "./scoring";

const choice = (points = 1): Question => ({
  type: "multiple_choice",
  prompt: "Which phase comes first?",
  options: ["Prophase", "Metaphase", "Anaphase"],
  answerIndex: 0,
  points,
});

const written = (points = 4): Question => ({
  type: "written",
  prompt: "Explain why mitosis matters.",
  modelAnswer: "It makes two identical cells.",
  points,
});

describe("isAnswered", () => {
  it("needs an option that exists, or some text", () => {
    expect(isAnswered(choice(), 0)).toBe(true);
    expect(isAnswered(choice(), 2)).toBe(true);
    expect(isAnswered(choice(), null)).toBe(false);
    expect(isAnswered(choice(), 3)).toBe(false);
    expect(isAnswered(choice(), -1)).toBe(false);
    expect(isAnswered(choice(), "0")).toBe(false);
    expect(isAnswered(written(), "It copies cells")).toBe(true);
    expect(isAnswered(written(), "   \n ")).toBe(false);
    expect(isAnswered(written(), null)).toBe(false);
    expect(isAnswered(written(), 0)).toBe(false);
  });

  it("lists the unanswered questions in order", () => {
    const questions = [choice(), written(), choice(), written()];
    expect(unanswered(questions, emptyAnswers(questions))).toEqual([0, 1, 2, 3]);
    expect(unanswered(questions, [1, " ", null, "text"])).toEqual([1, 2]);
    expect(unanswered(questions, [0])).toEqual([1, 2, 3]);
  });
});

describe("marking one question", () => {
  it("gives a right option all the points and a wrong one none", () => {
    expect(markQuestion(choice(3), 0, null)).toEqual({ status: "correct", earned: 3, possible: 3 });
    expect(markQuestion(choice(3), 1, null)).toEqual({ status: "wrong", earned: 0, possible: 3 });
    expect(markQuestion(choice(3), null, null)).toEqual({ status: "unanswered", earned: 0, possible: 3 });
  });

  it("ignores a self-mark on a multiple-choice question", () => {
    expect(markQuestion(choice(2), 1, 2)).toEqual({ status: "wrong", earned: 0, possible: 2 });
  });

  it("waits for the student's mark on a written answer", () => {
    expect(markQuestion(written(4), "text", null)).toEqual({ status: "to-mark", earned: 0, possible: 4 });
    expect(markQuestion(written(4), "text", 4)).toEqual({ status: "correct", earned: 4, possible: 4 });
    expect(markQuestion(written(4), "text", 3)).toEqual({ status: "partial", earned: 3, possible: 4 });
    expect(markQuestion(written(4), "text", 0)).toEqual({ status: "wrong", earned: 0, possible: 4 });
  });

  it("gives an empty written answer nothing, whatever mark it is given", () => {
    expect(markQuestion(written(4), "", null)).toEqual({ status: "unanswered", earned: 0, possible: 4 });
    expect(markQuestion(written(4), null, 4)).toEqual({ status: "unanswered", earned: 0, possible: 4 });
  });

  it("keeps a self-mark within what the question is worth", () => {
    expect(clampSelfMark(4, 9)).toBe(4);
    expect(clampSelfMark(4, -1)).toBe(0);
    expect(clampSelfMark(4, 2.6)).toBe(3);
    expect(clampSelfMark(4, Number.NaN)).toBe(0);
    expect(markQuestion(written(4), "text", 99).earned).toBe(4);
  });
});

describe("the score", () => {
  const questions = [choice(1), choice(2), written(4), written(3), choice(1)];

  it("adds up points, not questions", () => {
    const score = scoreAttempt(questions, [0, 1, "a", "b", 0], [null, null, 3, 3, null]);
    expect(score).toMatchObject({ earned: 8, possible: 11, toMark: 0, toMarkPoints: 0, percent: 73, final: true });
    expect(score.questions.map((result) => result.status)).toEqual(["correct", "wrong", "partial", "correct", "correct"]);
  });

  it("is not final, and gives no percentage, while written answers are unmarked", () => {
    const score = scoreAttempt(questions, [0, 0, "a", "b", 1], emptySelfMarks(questions));
    expect(score).toMatchObject({ earned: 3, possible: 11, toMark: 2, toMarkPoints: 7, percent: null, final: false });
    const one = scoreAttempt(questions, [0, 0, "a", "b", 1], [null, null, 4, null, null]);
    expect(one).toMatchObject({ earned: 7, toMark: 1, toMarkPoints: 3, final: false });
  });

  it("is final at once when nothing written was answered", () => {
    const score = scoreAttempt(questions, [0, 0, null, "  ", 0], emptySelfMarks(questions));
    expect(score).toMatchObject({ earned: 4, possible: 11, toMark: 0, percent: 36, final: true });
  });

  it("scores an empty attempt as zero", () => {
    const score = scoreAttempt(questions, emptyAnswers(questions), emptySelfMarks(questions));
    expect(score).toMatchObject({ earned: 0, possible: 11, percent: 0, final: true });
    expect(score.questions.every((result) => result.status === "unanswered")).toBe(true);
  });

  it("scores a perfect attempt as 100%", () => {
    const score = scoreAttempt(questions, [0, 0, "a", "b", 0], [null, null, 4, 3, null]);
    expect(score).toMatchObject({ earned: 11, possible: 11, percent: 100, final: true });
  });

  it("copes with answers and marks shorter than the questions", () => {
    expect(scoreAttempt(questions, [], [])).toMatchObject({ earned: 0, possible: 11, final: true });
  });

  it("handles 100 questions of 20 points", () => {
    const many = Array.from({ length: 100 }, () => choice(20));
    expect(scoreAttempt(many, many.map((_, i) => (i % 2 === 0 ? 0 : 1)), emptySelfMarks(many))).toMatchObject({
      earned: 1000,
      possible: 2000,
      percent: 50,
    });
  });
});

describe("describing a result", () => {
  const meta = {
    schemaVersion: 1,
    title: "Cell division",
    created: "2026-10-02T09:00:00.000Z",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    coverage: "whole",
  } as const;

  it("names the AI, with its model when known", () => {
    expect(describeSource("claude-code", "claude-sonnet-4-5")).toBe("Claude Code (claude-sonnet-4-5)");
    expect(describeSource("ollama", null)).toBe("Ollama");
    expect(describeSource("something-new", null)).toBe("something-new");
    expect(describeSource(null, "llama3")).toBe("llama3");
    expect(describeSource(null, null)).toBeNull();
  });

  it("counts cards, questions and points", () => {
    const cards: StudySet = { ...meta, kind: "flashcards", content: { cards: [{ front: "a", back: "b" }] } };
    expect(describeSize(cards)).toBe("1 card");
    const quiz: StudySet = { ...meta, kind: "quiz", content: { questions: [choice(), choice()] } };
    expect(describeSize(quiz)).toBe("2 questions");
    const exam: StudySet = { ...meta, kind: "exam", content: { questions: [choice(2), written(4)] } };
    expect(describeSize(exam)).toBe("2 questions · 6 points");
  });

  it("writes the line under the title", () => {
    const exam: StudySet = { ...meta, kind: "exam", content: { questions: [choice(2), written(4)] } };
    expect(describeStudySet(exam, "2 Oct 2026")).toBe(
      "Mock exam · 2 questions · 6 points · Made 2 Oct 2026 with Claude Code (claude-sonnet-4-5)",
    );
    const summary: StudySet = { ...meta, provider: null, model: null, kind: "summary", content: { length: null, body: "x" } };
    expect(describeStudySet(summary, "2 Oct 2026")).toBe("Summary · Made 2 Oct 2026");
    expect(describeStudySet(summary, "")).toBe("Summary");
    const note: StudySet = { ...meta, model: null, kind: "custom", content: { request: "A mnemonic", body: "x" } };
    expect(describeStudySet(note, "")).toBe("Your request · Made with Claude Code");
    const test: StudySet = { ...meta, model: null, kind: "test", content: { questions: [choice(), choice(), written(2)], length: "full", written: true } };
    expect(describeStudySet(test, "")).toBe("Practice test · Full exam · 3 questions · 4 points · with written questions · Made with Claude Code");
    const choiceOnly: StudySet = { ...meta, model: null, kind: "test", content: { questions: [choice(), choice()], length: "quick", written: false } };
    expect(describeSize(choiceOnly)).toBe("Quick · 2 questions · multiple choice only");
    const sheet: StudySet = { ...meta, provider: null, model: null, kind: "cheatsheet", content: { body: "x" } };
    expect(describeStudySet(sheet, "2 Oct 2026")).toBe("Cheat sheet · Made 2 Oct 2026");
    const explained: StudySet = { ...meta, provider: null, model: null, kind: "explain", content: { body: "x" } };
    expect(describeStudySet(explained, "")).toBe("Explanation");
  });
});

describe("shuffleOptions", () => {
  const paper: Question[] = [
    {
      type: "multiple_choice",
      prompt: "Which phase copies the DNA?",
      options: ["S phase", "G1 phase", "G2 phase", "M phase"],
      answerIndex: 0,
      points: 2,
    },
    {
      type: "multiple_choice",
      prompt: "What does mitosis give?",
      options: ["Two identical cells", "Four haploid cells", "One larger cell"],
      answerIndex: 0,
      points: 1,
    },
    { type: "written", prompt: "Explain.", modelAnswer: "Because.", points: 3 },
  ];
  const rightText = ["S phase", "Two identical cells"];
  const optionsOf = (question: Question): string =>
    question.type === "multiple_choice" ? question.options.join("|") : "";

  it("keeps every option and moves the right answer with its text", () => {
    for (const seed of [0, 1, 2, 3, 42, 123456789, 0xffffffff]) {
      const shown = shuffleOptions(paper, seed);
      shown.forEach((question, index) => {
        const original = paper[index]!;
        if (question.type !== "multiple_choice") {
          expect(question).toBe(original);
          return;
        }
        expect(optionsOf(question).split("|").sort()).toEqual(optionsOf(original).split("|").sort());
        expect(question.options[question.answerIndex]).toBe(rightText[index]);
      });
    }
  });

  it("gives the same score for the same chosen text, whatever the order", () => {
    const chosenText = ["S phase", "Four haploid cells"]; // one right, one wrong
    for (const seed of [1, 7, 99, 2026]) {
      const shown = shuffleOptions(paper, seed);
      const answers = shown.map((question, index) =>
        question.type === "multiple_choice" ? question.options.indexOf(chosenText[index]!) : "text",
      );
      const score = scoreAttempt(shown, answers, [null, null, 3]);
      expect(score.earned).toBe(2 + 0 + 3);
      expect(score.questions.map((result) => result.status)).toEqual(["correct", "wrong", "correct"]);
    }
  });

  it("is stable for one seed and differs between attempts", () => {
    expect(shuffleOptions(paper, 5)).toEqual(shuffleOptions(paper, 5));
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => shuffleOptions(paper, seed).map(optionsOf).join("#")));
    expect(orders.size).toBeGreaterThan(1);
    // The right answer does not stay in first place for every question of every attempt.
    const firsts = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => shuffleOptions(paper, seed).map((q) => (q.type === "multiple_choice" ? q.answerIndex : 0)));
    expect(firsts.some((index) => index !== 0)).toBe(true);
  });

  it("does not use one permutation for every question", () => {
    const same: Question[] = [paper[0]!, { ...paper[0]!, prompt: "Again?" }, { ...paper[0]!, prompt: "And again?" }];
    const differing = [1, 2, 3, 4, 5].some((seed) => {
      const shown = shuffleOptions(same, seed);
      return new Set(shown.map(optionsOf)).size > 1;
    });
    expect(differing).toBe(true);
  });
});

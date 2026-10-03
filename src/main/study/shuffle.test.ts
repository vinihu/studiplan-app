import { describe, expect, it } from "vitest";
import { validateQuestions } from "@shared/study";
import type { MultipleChoiceQuestion, Question, QuestionsContent } from "@shared/study";
import { spreadAnswers } from "./shuffle";

/** `count` questions that all have their correct option first, as a real exam had. */
function allFirst(count: number, options = 4): QuestionsContent {
  return {
    questions: Array.from({ length: count }, (_, index): Question => ({
      type: "multiple_choice",
      prompt: `Question ${index + 1}?`,
      options: Array.from({ length: options }, (_, option) => (option === 0 ? `right ${index}` : `wrong ${index}.${option}`)),
      answerIndex: 0,
      explanation: "Because.",
      points: 1,
    })),
  };
}

const multipleChoice = (content: QuestionsContent): MultipleChoiceQuestion[] =>
  content.questions.filter((question): question is MultipleChoiceQuestion => question.type === "multiple_choice");

describe("spreadAnswers", () => {
  it("uses every position equally often where the model used only the first", () => {
    const spread = spreadAnswers(allFirst(22), "2026-10-02T17:36:40.449Z Four chapters");
    const positions = [0, 0, 0, 0];
    for (const question of multipleChoice(spread)) positions[question.answerIndex] = (positions[question.answerIndex] ?? 0) + 1;
    // 22 questions over 4 places: 5 or 6 each.
    expect(Math.min(...positions)).toBe(5);
    expect(Math.max(...positions)).toBe(6);
    // Not simply 0, 1, 2, 3, 0, 1, …
    const order = multipleChoice(spread).map((question) => question.answerIndex).join("");
    expect(order).not.toMatch(/^(0123)+/);
  });

  it("keeps every question what it was: the same options, the same correct one", () => {
    const original = allFirst(30);
    const spread = spreadAnswers(original, "seed");
    for (const [index, question] of multipleChoice(spread).entries()) {
      const before = original.questions[index] as MultipleChoiceQuestion;
      expect(question.options[question.answerIndex]).toBe(`right ${index}`);
      expect([...question.options].sort()).toEqual([...before.options].sort());
      expect(question).toMatchObject({ prompt: before.prompt, explanation: "Because.", points: 1 });
    }
    // The input is not changed, and the result is still a valid quiz.
    expect(original.questions.every((question) => question.type === "multiple_choice" && question.answerIndex === 0)).toBe(true);
    expect(validateQuestions(spread).ok).toBe(true);
  });

  it("gives the same result for the same seed and another for another", () => {
    const first = spreadAnswers(allFirst(20), "a");
    expect(spreadAnswers(allFirst(20), "a")).toEqual(first);
    expect(spreadAnswers(allFirst(20), "b")).not.toEqual(first);
  });

  it("handles other numbers of options, written questions and one question alone", () => {
    const mixed: QuestionsContent = {
      questions: [
        ...allFirst(6, 2).questions,
        { type: "written", prompt: "Explain.", modelAnswer: "A full answer.", points: 3 },
        ...allFirst(12, 6).questions,
      ],
    };
    const spread = spreadAnswers(mixed, "seed");
    expect(spread.questions[6]).toEqual(mixed.questions[6]);
    const two = multipleChoice(spread).filter((question) => question.options.length === 2).map((question) => question.answerIndex);
    expect(two.filter((index) => index === 0)).toHaveLength(3);
    const six = multipleChoice(spread).filter((question) => question.options.length === 6).map((question) => question.answerIndex);
    expect(new Set(six).size).toBe(6);
    expect(multipleChoice(spreadAnswers(allFirst(1), "x"))[0]?.options).toHaveLength(4);
  });

  it("leaves a question alone whose options only make sense where they stand", () => {
    const content = allFirst(8);
    for (const [index, last] of ["All of the above", "Both A and B", "none of the above", "A und C"].entries()) {
      (content.questions[index] as MultipleChoiceQuestion).options[3] = last;
    }
    const spread = spreadAnswers(content, "seed");
    expect(spread.questions.slice(0, 4)).toEqual(content.questions.slice(0, 4));
  });
});

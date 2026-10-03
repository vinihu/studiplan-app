/**
 * Marking a quiz or a mock exam. Pure: no DOM.
 *
 * A multiple-choice question is marked here: the right option earns the question's points, any
 * other earns none. A written answer cannot be marked by the app, so the student compares
 * theirs with the model answer and says how many of the question's points it earned (a
 * "self-mark", from 0 to `points`). A written question left empty earns 0 and needs no mark.
 *
 * The score is in points, not in questions: a mock exam weights its questions.
 */

import type { Question } from "@shared/study";
import { shuffle } from "./deck";

/**
 * The questions of one attempt: the same questions, with the options of every multiple-choice
 * question in a new order and `answerIndex` following the right option to its new place.
 *
 * A model tends to put the right answer first, so a paper shown as it was written can be
 * passed by always picking A. The order comes from `seed`: the same seed gives the same order,
 * so it holds still while answering and in the review, and a new attempt takes a new seed.
 * Everything else (marking, the review) works on the returned questions and needs no mapping.
 */
export function shuffleOptions(questions: readonly Question[], seed: number): Question[] {
  return questions.map((question, index) => {
    if (question.type !== "multiple_choice" || question.options.length < 2) return question;
    // A different seed per question, or every question would get the same permutation.
    const order = shuffle(
      question.options.map((_, i) => i),
      (seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0,
    );
    return {
      ...question,
      options: order.map((from) => question.options[from] ?? ""),
      answerIndex: order.indexOf(question.answerIndex),
    };
  });
}

/** What the student gave for one question: the index of an option, the text written, or nothing yet. */
export type Answer = number | string | null;

/** Points the student gave their own written answer, or `null` while not marked. */
export type SelfMark = number | null;

export function emptyAnswers(questions: readonly Question[]): Answer[] {
  return questions.map(() => null);
}

export function emptySelfMarks(questions: readonly Question[]): SelfMark[] {
  return questions.map(() => null);
}

export function isAnswered(question: Question, answer: Answer): boolean {
  if (question.type === "multiple_choice") {
    return typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < question.options.length;
  }
  return typeof answer === "string" && answer.trim() !== "";
}

/** The questions not answered yet, as indices in order. */
export function unanswered(questions: readonly Question[], answers: readonly Answer[]): number[] {
  const missing: number[] = [];
  questions.forEach((question, i) => {
    if (!isAnswered(question, answers[i] ?? null)) missing.push(i);
  });
  return missing;
}

/** A self-mark as whole points within what the question is worth. */
export function clampSelfMark(points: number, mark: number): number {
  if (!Number.isFinite(mark)) return 0;
  return Math.min(points, Math.max(0, Math.round(mark)));
}

export type QuestionStatus =
  /** All of the question's points. */
  | "correct"
  /** Answered, and none of the points. */
  | "wrong"
  /** A written answer the student gave some, but not all, of the points. */
  | "partial"
  /** Not answered: none of the points. */
  | "unanswered"
  /** A written answer the student has not marked yet. */
  | "to-mark";

export interface QuestionResult {
  status: QuestionStatus;
  earned: number;
  possible: number;
}

export function markQuestion(question: Question, answer: Answer, selfMark: SelfMark): QuestionResult {
  const possible = question.points;
  if (!isAnswered(question, answer)) return { status: "unanswered", earned: 0, possible };
  if (question.type === "multiple_choice") {
    return answer === question.answerIndex
      ? { status: "correct", earned: possible, possible }
      : { status: "wrong", earned: 0, possible };
  }
  if (selfMark === null) return { status: "to-mark", earned: 0, possible };
  const earned = clampSelfMark(possible, selfMark);
  return { status: earned === possible ? "correct" : earned === 0 ? "wrong" : "partial", earned, possible };
}

export interface Score {
  /** One per question, in order. */
  questions: QuestionResult[];
  /** Points earned so far. Written answers not marked yet count as 0 until they are. */
  earned: number;
  /** Points the whole paper is worth. */
  possible: number;
  /** Written answers still to mark, and the points that hang on them. */
  toMark: number;
  toMarkPoints: number;
  /** `earned / possible` as a whole percentage, or `null` while answers are still to mark. */
  percent: number | null;
  /** True once every written answer is marked: the score will not change any more. */
  final: boolean;
}

export function scoreAttempt(
  questions: readonly Question[],
  answers: readonly Answer[],
  selfMarks: readonly SelfMark[],
): Score {
  const results = questions.map((question, i) => markQuestion(question, answers[i] ?? null, selfMarks[i] ?? null));
  let earned = 0;
  let possible = 0;
  let toMark = 0;
  let toMarkPoints = 0;
  for (const result of results) {
    earned += result.earned;
    possible += result.possible;
    if (result.status === "to-mark") {
      toMark++;
      toMarkPoints += result.possible;
    }
  }
  const final = toMark === 0;
  return {
    questions: results,
    earned,
    possible,
    toMark,
    toMarkPoints,
    percent: final && possible > 0 ? Math.round((earned / possible) * 100) : null,
    final,
  };
}

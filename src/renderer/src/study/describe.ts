/**
 * How a result is described in words: what it is, how big, when and with which AI it was made.
 * Pure functions, no DOM.
 */

import { STUDY_SET_KIND_LABELS, totalPoints } from "@shared/study";
import type { StudySet } from "@shared/study";
import { describeMakerWithModel } from "../ai/labels";
import { describeTest } from "../lib/make";

export function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : many}`;
}

/** "Claude Code", "Claude Code (claude-sonnet-4-5)", or `null` when the file no longer says. */
export function describeSource(provider: string | null, model: string | null): string | null {
  return describeMakerWithModel(provider, model);
}

/**
 * "12 cards", "10 questions · 14 points", "Short", and for a practice test what it was asked to
 * be: "Full exam · 27 questions · 31 points · with written questions". `null` when there is
 * nothing to say.
 */
export function describeSize(set: StudySet): string | null {
  switch (set.kind) {
    case "flashcards":
      return plural(set.content.cards.length, "card");
    case "test":
    case "quiz":
    case "exam": {
      const questions = set.content.questions.length;
      const points = totalPoints(set.content);
      // One point each is the plain case: saying "10 questions · 10 points" adds nothing.
      const counted =
        points === questions
          ? plural(questions, "question")
          : `${plural(questions, "question")} · ${plural(points, "point")}`;
      if (set.kind !== "test") return counted;
      const hasWritten = set.content.questions.some((question) => question.type === "written");
      return [describeTest(set.content.length, null), counted, hasWritten ? "with written questions" : "multiple choice only"]
        .filter(Boolean)
        .join(" · ");
    }
    case "summary":
      return set.content.length ? { short: "Short", medium: "Medium length", long: "Long" }[set.content.length] : null;
    case "explain":
    case "cheatsheet":
    case "custom":
      return null;
  }
}

/**
 * The quiet line under the title: "Flashcards · 12 cards · Made 2 Oct 2026 with Claude Code".
 * `date` is the already formatted date, or "" when the file's date cannot be read.
 */
export function describeStudySet(set: StudySet, date: string): string {
  const source = describeSource(set.provider, set.model);
  const made = date && source ? `Made ${date} with ${source}` : date ? `Made ${date}` : source ? `Made with ${source}` : null;
  return [STUDY_SET_KIND_LABELS[set.kind], describeSize(set), made].filter(Boolean).join(" · ");
}

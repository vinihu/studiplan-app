/**
 * The words of Make and Results: what each kind is called on a button, in a sentence and in a
 * row, and which sizes are offered. Pure functions, no DOM.
 */

import type { MakeOptions, StudySetSummary } from "@shared/results";
import {
  COUNT_PRESETS,
  DEFAULT_TEST_LENGTH,
  DEFAULT_TEST_WRITTEN,
  MAKE_LABELS,
  MAKEABLE_KINDS,
  MAX_REQUEST,
  STUDY_SET_KIND_LABELS,
  TEST_LENGTHS,
  TEST_QUESTION_COUNTS,
} from "@shared/study";
import type { MakeableKind, StudySetKind, SummaryLength, TestLength } from "@shared/study";
import { makerName } from "../ai/labels";
import { countInline } from "./format";

/** The kinds in the order the Make buttons show them, and what each button says. */
export const MAKE_KINDS: readonly MakeableKind[] = MAKEABLE_KINDS;
export { MAKE_LABELS };

/**
 * Read, learn, test: the three things a student does with material, and what the kinds are for.
 * The buttons stand in these groups, each under its word, so six choices read as three and one:
 * the last group is the free-text request, set apart from the ready-made kinds.
 */
export const MAKE_GROUPS: readonly { label: string; kinds: readonly MakeableKind[] }[] = [
  { label: "Read", kinds: ["summary", "explain", "cheatsheet"] },
  { label: "Learn", kinds: ["flashcards"] },
  { label: "Test", kinds: ["test"] },
  { label: "Or ask", kinds: ["custom"] },
];

/** The confirming button: "Make summary", "Make flashcards". */
export const MAKE_ACTIONS: Readonly<Record<MakeableKind, string>> = {
  summary: "Make summary",
  explain: "Make explanation",
  cheatsheet: "Make cheat sheet",
  flashcards: "Make flashcards",
  test: "Make practice test",
  custom: "Make it",
};

/** The kind inside a sentence: "Making a practice test…", "A summary is being made in …". */
const IN_SENTENCE: Readonly<Record<StudySetKind, string>> = {
  summary: "a summary",
  explain: "an explanation",
  cheatsheet: "a cheat sheet",
  flashcards: "flashcards",
  test: "a practice test",
  quiz: "a quiz",
  exam: "a mock exam",
  custom: "what you asked for",
};

export function kindInSentence(kind: StudySetKind): string {
  return IN_SENTENCE[kind];
}

/**
 * What a delete confirmation adds when something is being made from the thing to delete.
 * `where` names the material when a whole subject is deleted; left out for the material itself.
 */
export function deletionStopsMaking(kind: StudySetKind, where?: string): string {
  const what = IN_SENTENCE[kind];
  const verb = kind === "flashcards" ? "are" : "is";
  const subject = what.charAt(0).toUpperCase() + what.slice(1);
  return where === undefined
    ? `${subject} ${verb} being made from it right now. Deleting stops that, and nothing is saved from it.`
    : `${subject} ${verb} being made in “${where}” right now. Deleting stops that, and nothing is saved from it.`;
}

/** "Making a summary", "Making flashcards". */
export function makingTitle(kind: StudySetKind): string {
  return `Making ${IN_SENTENCE[kind]}`;
}

/** One line under the kind buttons: what the chosen kind gives, and when it helps. */
export const MAKE_HINTS: Readonly<Record<MakeableKind, string>> = {
  summary: "The material in short, to read before you practise.",
  explain: "A walkthrough in plain words, for when you missed the lesson.",
  cheatsheet: "One page of key terms, formulas and must-knows.",
  flashcards: "Cards with a question on the front and the answer on the back.",
  test: "Questions like in an exam, marked with explanations.",
  custom: "Anything else from this material: a timeline, a comparison, one part explained.",
};

export interface SizeChoice {
  /** Key of the choice and what is sent: a count as text, a summary length, a test length. */
  id: string;
  label: string;
}

const LENGTH_LABELS: Readonly<Record<SummaryLength, string>> = { short: "Short", medium: "Medium", long: "Long" };

/** What a practice test's length is called: on its button with the number, in a row without. */
const TEST_LENGTH_NAMES: Readonly<Record<TestLength, string>> = { quick: "Quick", standard: "Standard", full: "Full exam" };

function testLengthChoice(length: TestLength): string {
  const about = `about ${TEST_QUESTION_COUNTS[length]}`;
  // The first one says what is counted; after it the number alone is understood.
  return `${TEST_LENGTH_NAMES[length]} · ${length === TEST_LENGTHS[0] ? `${about} questions` : about}`;
}

/** The sizes offered for a kind, smallest first. Empty for a kind that has no size to choose. */
export function sizeChoices(kind: MakeableKind): SizeChoice[] {
  if (kind === "summary") {
    return (["short", "medium", "long"] as const).map((length) => ({ id: length, label: LENGTH_LABELS[length] }));
  }
  if (kind === "flashcards") {
    return COUNT_PRESETS.flashcards.map((count) => ({ id: String(count), label: `${count} cards` }));
  }
  if (kind === "test") return TEST_LENGTHS.map((length) => ({ id: length, label: testLengthChoice(length) }));
  return [];
}

/** The size chosen when the student has not chosen: the middle one. */
export function defaultSize(kind: MakeableKind): string | null {
  if (kind === "test") return DEFAULT_TEST_LENGTH;
  return sizeChoices(kind)[1]?.id ?? null;
}

/** What the size is called above its choices. */
export function sizeLabel(kind: MakeableKind): string {
  return kind === "flashcards" ? "Size" : "Length";
}

/** Said in place of a size, for the kinds whose length the app sets itself. */
export const NO_SIZE_NOTE = "As long as your material needs. There is nothing to choose here.";

/** The two answers to "written questions too?" of a practice test. */
export const WRITTEN_CHOICES: readonly SizeChoice[] = [
  { id: "written", label: "With written questions" },
  { id: "choice", label: "Multiple choice only" },
];
export const DEFAULT_WRITTEN_CHOICE = DEFAULT_TEST_WRITTEN ? "written" : "choice";

const isTestLength = (value: string | null): value is TestLength =>
  value !== null && (TEST_LENGTHS as readonly string[]).includes(value);

/**
 * The options to send for a kind, or `null` when nothing can be made yet ("Your own request"
 * without a request, or one that is too long). `written` only matters for a practice test.
 */
export function makeOptions(kind: MakeableKind, size: string | null, request: string, written: boolean = DEFAULT_TEST_WRITTEN): MakeOptions | null {
  if (kind === "custom") {
    const text = request.trim();
    return text === "" || text.length > MAX_REQUEST ? null : { request: text };
  }
  if (kind === "summary") {
    return { length: size === "short" || size === "long" ? size : "medium" };
  }
  if (kind === "test") return { testLength: isTestLength(size) ? size : DEFAULT_TEST_LENGTH, written };
  if (kind === "flashcards") {
    const count = Number(size);
    return Number.isInteger(count) && count > 0 ? { count } : {};
  }
  return {};
}

type RowFacts = Pick<StudySetSummary, "kind" | "itemCount"> &
  Partial<Pick<StudySetSummary, "length" | "testLength" | "written" | "coverage">>;

/** "Flashcards · 20 cards", "Practice test · 27 questions", "Summary · Short", "Your request". */
export function describeResult(result: RowFacts): string {
  const kind = STUDY_SET_KIND_LABELS[result.kind];
  if (result.kind === "summary" && result.length) return `${kind} · ${LENGTH_LABELS[result.length]}`;
  if (result.itemCount === null) return kind;
  const unit = result.kind === "flashcards" ? "card" : "question";
  return `${kind} · ${countInline(result.itemCount, unit)}`;
}

/** "Full exam · with written questions": what a practice test was asked to be. `null` for the rest. */
export function describeTest(testLength: TestLength | null, written: boolean | null): string | null {
  const parts = [
    testLength ? TEST_LENGTH_NAMES[testLength] : null,
    written === null ? null : written ? "with written questions" : "multiple choice only",
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The quiet second line of a row: what a practice test is, and whether the result was made from
 * only part of the material. `null` when there is nothing to add.
 */
export function describeResultDetail(result: RowFacts): string | null {
  const test = result.kind === "test" ? describeTest(result.testLength ?? null, result.written ?? null) : null;
  const cut = result.coverage === "cut" ? "made from part of the material" : null;
  if (test && cut) return `${test} · ${cut}`;
  if (cut) return cut.charAt(0).toUpperCase() + cut.slice(1);
  return test;
}

/**
 * "Claude Code", "Claude Code · sonnet", "OpenAI · gpt-6.1-sol" for an API key, or "" when the
 * file no longer says.
 */
export function describeMaker(result: Pick<StudySetSummary, "provider" | "providerLabel" | "model">): string {
  const name = makerName(result.provider, result.model, result.providerLabel);
  return [name, result.model].filter(Boolean).join(" · ");
}

/** "2 files", "2 files · 1 result": what a material holds, for its row in the Library. */
export function describeContents(material: { fileCount: number; setCount: number }): string {
  const files = material.fileCount === 0 ? "No files" : countInline(material.fileCount, "file");
  return material.setCount > 0 ? `${files} · ${countInline(material.setCount, "result")}` : files;
}

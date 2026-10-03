/**
 * What a result ("study set") is: the kinds, the content of each, and the saved file.
 *
 * No I/O and no dependencies, so the main process (which generates and saves) and the renderer
 * (which shows and studies) share one definition.
 *
 * ## The kinds
 *
 * | Kind         | File                          | Content                                   |
 * |--------------|-------------------------------|-------------------------------------------|
 * | `summary`    | `2026-10-02-summary.md`       | Markdown: the material in short           |
 * | `explain`    | `2026-10-02-explain.md`       | Markdown: a plain-language walkthrough    |
 * | `cheatsheet` | `2026-10-02-cheatsheet.md`    | Markdown: one page of tables and lists    |
 * | `flashcards` | `2026-10-02-flashcards.json`  | cards with a front and a back             |
 * | `test`       | `2026-10-02-test.json`        | questions (the "Practice test" button)    |
 * | `custom`     | `2026-10-02-custom.md`        | Markdown ("Your own request")             |
 * | `quiz`       | `2026-10-02-quiz.json`        | questions — made by earlier versions      |
 * | `exam`       | `2026-10-02-exam.json`        | questions — made by earlier versions      |
 *
 * ## Read, learn, test
 *
 * The six kinds a student can make (`MAKEABLE_KINDS`) are three things to read (summary,
 * explanation, cheat sheet), one to learn with (flashcards), one to test with (practice test),
 * and the free-text request.
 *
 * ## Practice test, quiz and mock exam are one shape
 *
 * All three are a list of questions, each either multiple choice or written, each worth some
 * points: one validator, one JSON Schema, one viewer. Earlier versions made a "quiz" (short,
 * mostly multiple choice) and a "mock exam" (longer, with written questions and points) as two
 * kinds. They are now one kind, `test`, with a length and a choice of written questions or
 * not. Files saved as `quiz` and `exam` are still listed, opened, renamed and deleted, under
 * their own names.
 */

export const STUDY_SET_KINDS = ["summary", "explain", "cheatsheet", "flashcards", "test", "quiz", "exam", "custom"] as const;

export type StudySetKind = (typeof STUDY_SET_KINDS)[number];

/** The kinds the Make buttons offer, in their order: read, learn, test, and the free request. */
export const MAKEABLE_KINDS = ["summary", "explain", "cheatsheet", "flashcards", "test", "custom"] as const;

export type MakeableKind = (typeof MAKEABLE_KINDS)[number];

export function isMakeableKind(value: unknown): value is MakeableKind {
  return typeof value === "string" && (MAKEABLE_KINDS as readonly string[]).includes(value);
}

/** How a kind is stored and what the model is asked to return. */
export type StudySetFormat = "markdown" | "json";

export const STUDY_SET_FORMATS: Readonly<Record<StudySetKind, StudySetFormat>> = {
  summary: "markdown",
  explain: "markdown",
  cheatsheet: "markdown",
  flashcards: "json",
  test: "json",
  quiz: "json",
  exam: "json",
  custom: "markdown",
};

/** What a result of each kind is called: in the Results list and in default titles. */
export const STUDY_SET_KIND_LABELS: Readonly<Record<StudySetKind, string>> = {
  summary: "Summary",
  explain: "Explanation",
  cheatsheet: "Cheat sheet",
  flashcards: "Flashcards",
  test: "Practice test",
  quiz: "Quiz",
  exam: "Mock exam",
  custom: "Your request",
};

/** What the Make button of each kind says. */
export const MAKE_LABELS: Readonly<Record<MakeableKind, string>> = {
  summary: "Summary",
  explain: "Explain it",
  cheatsheet: "Cheat sheet",
  flashcards: "Flashcards",
  test: "Practice test",
  custom: "Your own request",
};

export function isStudySetKind(value: unknown): value is StudySetKind {
  return typeof value === "string" && (STUDY_SET_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

export interface Flashcard {
  /** A question or a term. Plain text. */
  front: string;
  /** The answer. Plain text. */
  back: string;
}

export interface FlashcardsContent {
  cards: Flashcard[];
}

export interface MultipleChoiceQuestion {
  type: "multiple_choice";
  prompt: string;
  /** 2–6 distinct options. */
  options: string[];
  /** 0-based index into `options`. Always in range once validated. */
  answerIndex: number;
  /** Why the right answer is right. Shown after submitting. */
  explanation?: string;
  /** What the question is worth. A whole number from 1 to `MAX_POINTS`. */
  points: number;
}

export interface WrittenQuestion {
  type: "written";
  prompt: string;
  /** A full answer a teacher would accept. The student compares theirs with it and self-marks. */
  modelAnswer: string;
  /** Marking notes: what earns the points, or the usual mistake. Shown after submitting. */
  explanation?: string;
  points: number;
}

export type Question = MultipleChoiceQuestion | WrittenQuestion;

export type QuestionType = Question["type"];

/** The content of a quiz and of a mock exam, and the questions of a practice test. */
export interface QuestionsContent {
  questions: Question[];
}

export const TEST_LENGTHS = ["quick", "standard", "full"] as const;

/** How long a practice test is: a quick check, a standard test, a full exam. */
export type TestLength = (typeof TEST_LENGTHS)[number];

/** A practice test: questions, and what was asked for when it was made. */
export interface TestContent extends QuestionsContent {
  /** The length that was asked for. `null` when the file no longer says. */
  length: TestLength | null;
  /**
   * Whether written questions were asked for. `null` when the file no longer says. Whether the
   * test really has any is seen in `questions`.
   */
  written: boolean | null;
}

/** An explanation or a cheat sheet: a Markdown document with nothing else to say about itself. */
export interface DocumentContent {
  /** Markdown. Untrusted: see the note on rendering in `index.ts`. */
  body: string;
}

export const SUMMARY_LENGTHS = ["short", "medium", "long"] as const;

export type SummaryLength = (typeof SUMMARY_LENGTHS)[number];

export interface SummaryContent {
  /** How condensed it was asked to be. `null` when the file no longer says. */
  length: SummaryLength | null;
  /** Markdown. Untrusted: see the note on rendering in `index.ts`. */
  body: string;
}

export interface CustomContent {
  /** What the student typed into "Your own request". `null` when the file no longer says. */
  request: string | null;
  /** Markdown. Untrusted: see the note on rendering in `index.ts`. */
  body: string;
}

export interface StudySetContentByKind {
  summary: SummaryContent;
  explain: DocumentContent;
  cheatsheet: DocumentContent;
  flashcards: FlashcardsContent;
  test: TestContent;
  quiz: QuestionsContent;
  exam: QuestionsContent;
  custom: CustomContent;
}

export type StudySetContent = StudySetContentByKind[StudySetKind];

/* ------------------------------------------------------------------ *
 * The saved file
 * ------------------------------------------------------------------ */

/** The version of the saved shape. Raised only when an old file can no longer be read as-is. */
export const STUDY_SET_SCHEMA_VERSION = 1;

/**
 * Whether the model saw the whole material or a cut version (one request is capped, and the
 * user is told when a material was too long to send whole). `unknown` only for a
 * file that no longer says, such as a summary whose front matter was deleted.
 */
export type MaterialCoverage = "whole" | "cut" | "unknown";

/** What every saved result carries besides its content. */
export interface StudySetMeta {
  schemaVersion: typeof STUDY_SET_SCHEMA_VERSION;
  title: string;
  /** ISO 8601 timestamp of when it was made. */
  created: string;
  /** The provider that made it, e.g. `claude-code`. `null` when the file no longer says. */
  provider: string | null;
  /** The model that made it, where the provider reports one. */
  model: string | null;
  coverage: MaterialCoverage;
}

/** A saved result: the envelope plus the content, which always agrees with `kind`. */
export type StudySet<K extends StudySetKind = StudySetKind> = {
  [P in K]: StudySetMeta & { kind: P; content: StudySetContentByKind[P] };
}[K];

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** More cards or questions than this are dropped (and reported), so a runaway reply is bounded. */
export const MAX_CARDS = 200;
export const MAX_QUESTIONS = 100;

/** One side of a flashcard. Long enough for a definition with an example. */
export const MAX_CARD_SIDE = 2_000;
export const MAX_PROMPT = 4_000;
export const MAX_OPTION = 1_000;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_EXPLANATION = 4_000;
export const MAX_MODEL_ANSWER = 8_000;
export const MAX_POINTS = 20;

/** A Markdown body (summary or "something else"). Longer is cut at a paragraph and reported. */
export const MAX_MARKDOWN = 50_000;

export const MAX_TITLE = 200;
/** The student's free-text request for "Something else…". */
export const MAX_REQUEST = 2_000;
/** Provider and model names in the envelope. */
export const MAX_SOURCE_NAME = 100;

/**
 * The most text accepted from a model in one reply, or from a file on disk, before any parsing.
 * Far above any real result (200 full cards are 800,000 characters).
 */
export const MAX_RAW_CHARS = 2_000_000;

/* ------------------------------------------------------------------ *
 * Validation results
 * ------------------------------------------------------------------ */

/**
 * The outcome of checking something untrusted.
 *
 * `errors` are complete sentences that name the field (`questions[3].options …`) and say what to
 * change; they are sent back to the model for its one retry. `warnings` report what was adjusted
 * while accepting the value (cards dropped over the limit, a summary shortened) and are for the
 * student.
 */
export type Validation<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[] };

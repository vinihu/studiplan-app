/**
 * The one way content becomes a result: validate, tidy, bound.
 *
 * Content is written by a model, or read back from a file a student may have edited, so nothing
 * about it is trusted — not the shape, not the types, not the sizes. Each validator takes an
 * `unknown` and returns either the typed value or a list of sentences that name the field
 * (`cards[3].back`) and say what was wrong. Those sentences go back to the model for its one
 * retry, so they are written to be acted on.
 *
 * All problems are collected instead of stopping at the first, because the one retry has to fix
 * everything at once. Questions carry points, written questions an optional explanation, and a
 * quiz/exam has a flat "wire" shape (see `schema.ts`).
 *
 * ## Two kinds of limit, treated differently on purpose
 *
 *  - **Counts are cut.** More than `MAX_CARDS` cards or `MAX_QUESTIONS` questions keeps the first
 *    ones and reports the cut in `warnings`. Only the kept entries are looked at, so an array of
 *    a million entries costs no more than one of two hundred.
 *  - **A single string over its limit is rejected.** Cutting a card's back or a question's prompt
 *    mid-sentence produces content that is wrong, not shorter. A Markdown body is the exception:
 *    it is cut at a paragraph break and reported, because a shortened summary is still a summary.
 *
 * ## What is not a problem
 *
 * Unknown keys are dropped. HTML, `<script>` and Markdown inside a string are **kept as the
 * characters they are**: the viewers show every string as text, so there is nothing to strip and
 * stripping would damage a card about HTML. Only control characters (other than tab and newline)
 * are removed, and line endings become `\n`.
 */

import {
  MAX_CARDS,
  MAX_CARD_SIDE,
  MAX_EXPLANATION,
  MAX_MARKDOWN,
  MAX_MODEL_ANSWER,
  MAX_OPTION,
  MAX_OPTIONS,
  MAX_POINTS,
  MAX_PROMPT,
  MAX_QUESTIONS,
  MAX_RAW_CHARS,
  MAX_REQUEST,
  MIN_OPTIONS,
  SUMMARY_LENGTHS,
  TEST_LENGTHS,
  type CustomContent,
  type DocumentContent,
  type TestContent,
  type TestLength,
  type Flashcard,
  type FlashcardsContent,
  type Question,
  type QuestionsContent,
  type StudySetContentByKind,
  type StudySetKind,
  type SummaryContent,
  type SummaryLength,
  type Validation,
} from "./types";

/** After this many problems the rest are summarised, so the retry message stays readable. */
export const MAX_REPORTED_ERRORS = 12;

class Problems {
  readonly list: string[] = [];
  private more = 0;

  add(message: string): undefined {
    if (this.list.length < MAX_REPORTED_ERRORS) this.list.push(message);
    else this.more++;
    return undefined;
  }

  get any(): boolean {
    return this.list.length > 0;
  }

  /** True once enough has been reported that checking further entries adds nothing. */
  get full(): boolean {
    return this.more > 0;
  }

  result(): string[] {
    return this.more > 0
      ? [...this.list, "There are more problems of the same kinds; check every entry."]
      : [...this.list];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return "a string";
  return `a ${typeof value}`;
}

/**
 * Line endings to `\n`, control characters out (tab and newline stay). Nothing else changes:
 * `<`, `>` and `&` are ordinary characters here.
 */
export function cleanText(value: string): string {
  let out = "";
  // A byte-order mark at the very start is an artefact of the file or the transport.
  for (let i = value.charCodeAt(0) === 0xfeff ? 1 : 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 13) {
      if (value.charCodeAt(i + 1) !== 10) out += "\n";
      continue;
    }
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += value[i];
  }
  return out;
}

/** A required, non-blank string, tidied and trimmed, at most `max` characters. */
function requireText(value: unknown, path: string, max: number, problems: Problems): string | undefined {
  if (typeof value !== "string") {
    return problems.add(`${path} must be a string, but it is ${describe(value)}.`);
  }
  // Checked before tidying so a multi-megabyte string is never walked.
  if (value.length > max * 4) {
    return problems.add(`${path} is ${value.length} characters; the limit is ${max}. Shorten it.`);
  }
  const text = cleanText(value).trim();
  if (text === "") {
    return problems.add(`${path} must not be empty.`);
  }
  if (text.length > max) {
    return problems.add(`${path} is ${text.length} characters; the limit is ${max}. Shorten it.`);
  }
  return text;
}

/** An optional string: missing, null or blank all mean "not given". */
function optionalText(
  value: unknown,
  path: string,
  max: number,
  problems: Problems,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return requireText(value, path, max, problems);
}

/** The entries of a required, non-empty array, cut to `max` with a warning. */
function requireList(
  value: unknown,
  path: string,
  noun: string,
  max: number,
  problems: Problems,
  warnings: string[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return problems.add(`${path} must be an array of ${noun}, but it is ${describe(value)}.`);
  }
  if (value.length === 0) {
    return problems.add(`${path} must contain at least one entry; it is empty.`);
  }
  if (value.length <= max) return value;
  warnings.push(`Only the first ${max} of ${value.length} ${noun} were kept (the limit is ${max}).`);
  return value.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * Flashcards
 * ------------------------------------------------------------------ */

const FLASHCARDS_SHAPE = '{ "cards": [ { "front": "…", "back": "…" } ] }';

export function validateFlashcards(raw: unknown): Validation<FlashcardsContent> {
  const problems = new Problems();
  const warnings: string[] = [];

  // A bare array of cards is what was meant; accept it.
  const source: unknown = Array.isArray(raw) ? { cards: raw } : raw;
  if (!isRecord(source)) {
    return {
      ok: false,
      errors: [`The reply must be a JSON object of the form ${FLASHCARDS_SHAPE}, but it is ${describe(raw)}.`],
    };
  }

  const list = requireList(source.cards, "cards", "cards", MAX_CARDS, problems, warnings);
  if (!list) return { ok: false, errors: problems.result() };

  const cards: Flashcard[] = [];
  const seen = new Set<string>();
  let repeated = 0;
  for (let i = 0; i < list.length && !problems.full; i++) {
    const card = list[i];
    if (!isRecord(card)) {
      problems.add(`cards[${i}] must be an object with "front" and "back", but it is ${describe(card)}.`);
      continue;
    }
    const front = requireText(card.front, `cards[${i}].front`, MAX_CARD_SIDE, problems);
    const back = requireText(card.back, `cards[${i}].back`, MAX_CARD_SIDE, problems);
    if (front === undefined || back === undefined) continue;
    // A model stuck in a loop repeats itself word for word. Keep the first of each.
    const key = `${front.toLowerCase()}\u0000${back.toLowerCase()}`;
    if (seen.has(key)) {
      repeated++;
      continue;
    }
    seen.add(key);
    cards.push({ front, back });
  }

  if (problems.any) return { ok: false, errors: problems.result() };
  if (repeated > 0) {
    warnings.push(
      `${repeated} repeated ${repeated === 1 ? "card was" : "cards were"} left out.`,
    );
  }
  return { ok: true, value: { cards }, warnings };
}

/* ------------------------------------------------------------------ *
 * Quiz and mock exam
 * ------------------------------------------------------------------ */

const QUESTIONS_SHAPE = '{ "questions": [ { "type": "multiple_choice", … } ] }';

function validatePoints(value: unknown, path: string, problems: Problems): number | undefined {
  // Left out means the usual one point.
  if (value === undefined || value === null) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_POINTS) {
    return problems.add(`${path} must be a whole number from 1 to ${MAX_POINTS}.`);
  }
  return value;
}

function validateQuestion(raw: unknown, i: number, problems: Problems): Question | undefined {
  const path = `questions[${i}]`;
  if (!isRecord(raw)) {
    return problems.add(`${path} must be an object, but it is ${describe(raw)}.`);
  }
  const before = problems.list.length;

  if (raw.type === "multiple_choice") {
    const prompt = requireText(raw.prompt, `${path}.prompt`, MAX_PROMPT, problems);

    let options: string[] | undefined;
    if (!Array.isArray(raw.options)) {
      problems.add(`${path}.options must be an array of strings, but it is ${describe(raw.options)}.`);
    } else if (raw.options.length < MIN_OPTIONS) {
      problems.add(
        `${path}.options must have at least ${MIN_OPTIONS} entries; it has ${raw.options.length}.`,
      );
    } else if (raw.options.length > MAX_OPTIONS) {
      problems.add(
        `${path}.options must have at most ${MAX_OPTIONS} entries; it has ${raw.options.length}.`,
      );
    } else {
      const list: string[] = [];
      raw.options.forEach((option, j) => {
        const text = requireText(option, `${path}.options[${j}]`, MAX_OPTION, problems);
        if (text !== undefined) list.push(text);
      });
      if (list.length === raw.options.length) {
        if (new Set(list.map((option) => option.toLowerCase())).size !== list.length) {
          problems.add(`${path}.options contains the same option twice; every option must differ.`);
        } else {
          options = list;
        }
      }
    }

    let answerIndex: number | undefined;
    if (options) {
      const value = raw.answerIndex;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= options.length) {
        problems.add(
          `${path}.answerIndex must be a whole number from 0 to ${options.length - 1}: the 0-based ` +
            `position of the correct option in ${path}.options (0 is the first option).`,
        );
      } else {
        answerIndex = value;
      }
    }

    const explanation = optionalText(raw.explanation, `${path}.explanation`, MAX_EXPLANATION, problems);
    const points = validatePoints(raw.points, `${path}.points`, problems);

    if (problems.list.length > before || problems.full) return undefined;
    if (prompt === undefined || !options || answerIndex === undefined || points === undefined) {
      return undefined;
    }
    return {
      type: "multiple_choice",
      prompt,
      options,
      answerIndex,
      ...(explanation === undefined ? {} : { explanation }),
      points,
    };
  }

  // "short_answer" is the name Studiplan used and a name models reach for; it means the same.
  if (raw.type === "written" || raw.type === "short_answer") {
    const prompt = requireText(raw.prompt, `${path}.prompt`, MAX_PROMPT, problems);
    const modelAnswer = requireText(raw.modelAnswer, `${path}.modelAnswer`, MAX_MODEL_ANSWER, problems);
    const explanation = optionalText(raw.explanation, `${path}.explanation`, MAX_EXPLANATION, problems);
    const points = validatePoints(raw.points, `${path}.points`, problems);
    if (prompt === undefined || modelAnswer === undefined || points === undefined) return undefined;
    if (problems.list.length > before || problems.full) return undefined;
    return {
      type: "written",
      prompt,
      modelAnswer,
      ...(explanation === undefined ? {} : { explanation }),
      points,
    };
  }

  return problems.add(`${path}.type must be "multiple_choice" or "written".`);
}

/** The content of a quiz or a mock exam. The two share one shape. */
export function validateQuestions(raw: unknown): Validation<QuestionsContent> {
  const problems = new Problems();
  const warnings: string[] = [];

  const source: unknown = Array.isArray(raw) ? { questions: raw } : raw;
  if (!isRecord(source)) {
    return {
      ok: false,
      errors: [`The reply must be a JSON object of the form ${QUESTIONS_SHAPE}, but it is ${describe(raw)}.`],
    };
  }

  const list = requireList(source.questions, "questions", "questions", MAX_QUESTIONS, problems, warnings);
  if (!list) return { ok: false, errors: problems.result() };

  const questions: Question[] = [];
  for (let i = 0; i < list.length && !problems.full; i++) {
    const question = validateQuestion(list[i], i, problems);
    if (question) questions.push(question);
  }

  if (problems.any) return { ok: false, errors: problems.result() };
  return { ok: true, value: { questions }, warnings };
}

/* ------------------------------------------------------------------ *
 * Markdown bodies: summary and "something else"
 * ------------------------------------------------------------------ */

/**
 * Cut `body` to at most `max` characters, preferring the last paragraph break in the final fifth
 * so it does not end mid-sentence.
 */
function clampMarkdown(body: string, max: number): string {
  const head = body.slice(0, max);
  const cut = head.lastIndexOf("\n\n");
  return (cut >= max * 0.8 ? head.slice(0, cut) : head).trimEnd();
}

/**
 * A reply that is one fenced block and nothing else: the model wrapped its whole document.
 * Each run of blanks can be matched in one way only, so a reply that opens a fence and goes on
 * with thousands of blanks is turned down in one pass instead of one pass per blank.
 */
const WHOLE_FENCE = /^```[ \t]*(?:(?:markdown|md)[ \t]*)?\n([\s\S]*?)\n```$/i;

/**
 * A Markdown document written by a model or read from a file: tidied, never empty, bounded.
 *
 * The Markdown itself is not parsed or filtered here. It is untrusted text, and the place that
 * makes it safe is the renderer, which must build text nodes only (see `index.ts`).
 */
export function validateMarkdown(raw: unknown, path = "The document"): Validation<string> {
  if (typeof raw !== "string") {
    return { ok: false, errors: [`${path} must be Markdown text, but it is ${describe(raw)}.`] };
  }
  if (raw.length > MAX_RAW_CHARS) {
    return {
      ok: false,
      errors: [`${path} is ${raw.length} characters; the limit is ${MAX_MARKDOWN}. Write a shorter one.`],
    };
  }
  let body = cleanText(raw).trim();
  const fenced = WHOLE_FENCE.exec(body);
  // Only unwrap when the fence really is the whole reply (no other fence inside it).
  if (fenced && fenced[1] !== undefined && !fenced[1].includes("```")) body = fenced[1].trim();
  if (body === "") {
    return { ok: false, errors: [`${path} is empty. Write the document.`] };
  }
  const warnings: string[] = [];
  if (body.length > MAX_MARKDOWN) {
    warnings.push(
      `The text was ${body.length} characters and was shortened to at most ${MAX_MARKDOWN}.`,
    );
    body = clampMarkdown(body, MAX_MARKDOWN);
  }
  return { ok: true, value: body, warnings };
}

function isSummaryLength(value: unknown): value is SummaryLength {
  return typeof value === "string" && (SUMMARY_LENGTHS as readonly string[]).includes(value);
}

export function validateSummary(raw: unknown): Validation<SummaryContent> {
  if (!isRecord(raw)) {
    return { ok: false, errors: [`A summary must be an object with "body", but it is ${describe(raw)}.`] };
  }
  const body = validateMarkdown(raw.body, "body");
  if (!body.ok) return body;
  return {
    ok: true,
    value: { length: isSummaryLength(raw.length) ? raw.length : null, body: body.value },
    warnings: body.warnings,
  };
}

export function validateCustom(raw: unknown): Validation<CustomContent> {
  if (!isRecord(raw)) {
    return { ok: false, errors: [`A note must be an object with "body", but it is ${describe(raw)}.`] };
  }
  const body = validateMarkdown(raw.body, "body");
  if (!body.ok) return body;
  const request =
    typeof raw.request === "string" && raw.request.trim() !== ""
      ? cleanText(raw.request).trim().slice(0, MAX_REQUEST)
      : null;
  return { ok: true, value: { request, body: body.value }, warnings: body.warnings };
}

export function validateDocument(raw: unknown): Validation<DocumentContent> {
  if (!isRecord(raw)) {
    return { ok: false, errors: [`A document must be an object with "body", but it is ${describe(raw)}.`] };
  }
  const body = validateMarkdown(raw.body, "body");
  if (!body.ok) return body;
  return { ok: true, value: { body: body.value }, warnings: body.warnings };
}

/** A practice test: the questions, plus what was asked for, where the file still says. */
export function validateTest(raw: unknown): Validation<TestContent> {
  const questions = validateQuestions(raw);
  if (!questions.ok) return questions;
  const record = isRecord(raw) ? raw : {};
  const length = (TEST_LENGTHS as readonly unknown[]).includes(record.length) ? (record.length as TestLength) : null;
  const written = typeof record.written === "boolean" ? record.written : null;
  return { ok: true, value: { length, written, questions: questions.value.questions }, warnings: questions.warnings };
}

/**
 * The student's free-text request for "Something else…", before it is put into a prompt. The
 * errors here are for the student, not for a model.
 */
export function validateRequest(raw: unknown): Validation<string> {
  if (typeof raw !== "string" || cleanText(raw).trim() === "") {
    return { ok: false, errors: ["Write what you want made from this material first."] };
  }
  const request = cleanText(raw).trim();
  if (request.length > MAX_REQUEST) {
    return {
      ok: false,
      errors: [`That request is ${request.length} characters long; keep it under ${MAX_REQUEST}.`],
    };
  }
  return { ok: true, value: request, warnings: [] };
}

/* ------------------------------------------------------------------ *
 * By kind
 * ------------------------------------------------------------------ */

/**
 * Validate the content of a result of `kind`. For `summary` and `custom`, `raw` is the stored
 * object (`{ length, body }` / `{ request, body }`); to check a model's Markdown reply use
 * `parseGenerationOutput()`, which builds that object.
 */
export function validateStudySetContent<K extends StudySetKind>(
  kind: K,
  raw: unknown,
): Validation<StudySetContentByKind[K]> {
  let result: Validation<StudySetContentByKind[StudySetKind]>;
  switch (kind as StudySetKind) {
    case "flashcards":
      result = validateFlashcards(raw);
      break;
    case "test":
      result = validateTest(raw);
      break;
    case "quiz":
    case "exam":
      result = validateQuestions(raw);
      break;
    case "explain":
    case "cheatsheet":
      result = validateDocument(raw);
      break;
    case "summary":
      result = validateSummary(raw);
      break;
    case "custom":
      result = validateCustom(raw);
      break;
    default:
      result = { ok: false, errors: ["Unknown kind of result."] };
  }
  return result as Validation<StudySetContentByKind[K]>;
}

/** Cards or questions in a result; `null` for a Markdown one, which has no count. */
export function countStudySetItems(content: StudySetContentByKind[StudySetKind]): number | null {
  if ("cards" in content) return content.cards.length;
  if ("questions" in content) return content.questions.length;
  return null;
}

/** Whether a test, quiz or mock exam has any written question. */
export function hasWrittenQuestions(content: QuestionsContent): boolean {
  return content.questions.some((question) => question.type === "written");
}

/** The points a quiz or mock exam is out of. */
export function totalPoints(content: QuestionsContent): number {
  return content.questions.reduce((sum, question) => sum + question.points, 0);
}

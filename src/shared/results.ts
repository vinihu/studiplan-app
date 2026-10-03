/**
 * Making results and keeping them, as the renderer sees it: the `study` namespace of the bridge.
 *
 * A result is addressed by the material it belongs to and its file name in `sets/`
 * (`2026-10-02-quiz.json`), which the main process validates like every other name. No path
 * crosses the bridge.
 *
 * ## Making one (the Make buttons)
 *
 * ```ts
 * const requestId = newRequestId();
 * const stop = window.studiplan.events.subscribe("taskProgress", (progress) => {
 *   if (progress.requestId === requestId) show(progress.message);   // fraction is always null
 * });
 * const made = await window.studiplan.study.generate(ref, { requestId, kind: "test", options: { testLength: "quick" } });
 * stop();
 * if (made.ok) open(made.value.result.name);      // and show made.value.notices, if any
 * else if (made.error.code !== "cancelled") show(made.error.message);
 * ```
 *
 * The Cancel button calls `window.studiplan.tasks.cancel(requestId)`; `generate` then resolves
 * with code `"cancelled"` and nothing is saved. One result is made at a time in the whole app:
 * a second `generate` while one is running resolves at once with code `"already-generating"`.
 * `study.current()` says what is running, for a screen that was opened while it runs.
 *
 * Pure: no Node, no Electron, no DOM.
 */
import type { LibraryErrorCode, MaterialRef } from "./library";
import type { ProviderErrorCode, ProviderId } from "./providers";
import type { GenerationOptions, MaterialCoverage, StudySet, StudySetKind, SummaryLength, TestLength } from "./study";

/**
 * Why a `study` call failed. `message` is always a plain sentence that can be shown as it is.
 * The provider's and the library's own codes pass through; these are added:
 */
export type StudyErrorCode =
  | ProviderErrorCode
  | LibraryErrorCode
  | "no-provider" // no AI is chosen yet: send the student to Settings
  | "empty-request" // "Something else…" with an empty or far too long text box
  | "nothing-readable" // the material has no files, or none that can be sent; no AI was asked
  | "unusable-material" // the AI answered that it could not read or use the material; nothing was saved
  | "already-generating" // another result is being made right now
  | "invalid-result" // the AI answered twice in a form that cannot be saved; nothing was saved
  | "unreadable-result"; // a saved file cannot be opened (edited by hand, damaged)

export interface StudyError {
  code: StudyErrorCode;
  /** A plain sentence that says what happened and what to do. */
  message: string;
  /**
   * More sentences, when there are any: for `nothing-readable`, why each file could not be
   * sent; for `unreadable-result`, what is wrong in the file; for `unusable-material`, what the
   * AI said, as a quotation (`Claude Code said: “…”` — a model's words, to be shown as text).
   * Show them under the message.
   */
  details?: string[];
}

/** Every `study` call resolves to this instead of throwing. */
export type StudyResult<T> = { ok: true; value: T } | { ok: false; error: StudyError };

/** What a Make button may choose. `coverage` is decided by the app, not by the page. */
export type MakeOptions = Pick<
  GenerationOptions,
  "count" | "length" | "testLength" | "written" | "request" | "language"
>;

export interface GenerateRequest {
  /** Made by the renderer (`newRequestId()`). Progress events carry it; `tasks.cancel` takes it. */
  requestId: string;
  kind: StudySetKind;
  /**
   * By kind (`MAKEABLE_KINDS`):
   * - `summary`: `length` (`short` | `medium` | `long`).
   * - `explain`, `cheatsheet`: no size option; the app sets their length from the material.
   * - `flashcards`: `count` (see `COUNT_PRESETS` and `COUNT_LIMITS`).
   * - `test`: `testLength` (`quick` | `standard` | `full`: about 10, 20, 30 questions) and
   *   `written` (`false` for multiple choice only).
   * - `custom`: `request` (required).
   * `language` overrides the material's language for any kind. Anything left out takes its
   * default. `quiz` and `exam` are kinds of earlier versions: their files are listed and
   * opened, and the app no longer offers to make them.
   */
  options?: MakeOptions;
  /** Use this AI instead of the default from Settings. */
  provider?: ProviderId;
  /** Use this model instead of the one saved in Settings for that AI. */
  model?: string;
}

/** One row of the Results list. */
export interface StudySetSummary {
  /** The file name in `sets/`: the result's id for `read`, `rename` and `remove`. */
  name: string;
  kind: StudySetKind;
  /** The title. For a file that cannot be opened: the kind's name. */
  title: string;
  /** ISO 8601. From the file, or local midnight of the date in its name when the file no longer says. */
  created: string;
  /** Cards or questions. `null` for a summary, a note, and a file that cannot be opened. */
  itemCount: number | null;
  /** The AI that made it, as its id (`claude-code`) and its name ("Claude Code"). `null` when the file no longer says. */
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  /** `cut`: made from only part of the material. */
  coverage: MaterialCoverage;
  /**
   * A summary's length as it was asked for, from the saved file. `null` for every other kind,
   * for a summary whose file no longer says, and for a file that cannot be opened.
   */
  length: SummaryLength | null;
  /**
   * A practice test's length as it was asked for (`quick` | `standard` | `full`). `null` for
   * every other kind — a quiz or mock exam of an earlier version included — and for a test
   * whose file no longer says.
   */
  testLength: TestLength | null;
  /**
   * Practice test, quiz, mock exam: whether it has written questions, as counted in the file.
   * `null` for every other kind and for a file that cannot be opened.
   */
  written: boolean | null;
  /**
   * `null` when the file opens. Otherwise the sentence why not; the row is still listed so the
   * student can delete the file or fix it, and `read` returns the same sentence.
   */
  problem: string | null;
}

/** What `study.generate` returns when a result was saved. */
export interface GenerateOutcome {
  /** The saved result, as its row in the Results list. Open it with `study.read(ref, result.name)`. */
  result: StudySetSummary;
  /**
   * Sentences about what of the material was not sent ("Only the first 23 of 120 pages of
   * "script.pdf" were sent."). Empty when everything was sent. When not empty, the saved
   * result's `coverage` is `cut`. They are not stored in the file: show them now.
   */
  notices: string[];
  /** Sentences about what was adjusted while accepting the answer (cards dropped over the limit). Usually empty. */
  warnings: string[];
  /** 1, or 2 when the first answer failed the check and the second passed. */
  attempts: 1 | 2;
  durationMs: number;
}

/** What `study.read` returns. */
export interface OpenedStudySet {
  name: string;
  /** Validated again when read. Everything in it is untrusted text: see `src/shared/study/index.ts`. */
  set: StudySet;
  /** What was adjusted while reading a hand-edited file. Usually empty. */
  warnings: string[];
}

/** What is being made right now. */
export interface StudyActivity {
  requestId: string;
  ref: MaterialRef;
  kind: StudySetKind;
  /** ISO 8601. */
  started: string;
  /** The last progress sentence. */
  message: string;
}

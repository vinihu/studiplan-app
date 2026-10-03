/**
 * The text of a PDF or .pptx (`library.extractText`) taken apart for reading on screen, and the
 * sentences that go with it. Pure functions, no DOM. The text comes out of the student's own
 * file: it is only ever cut into strings here, never interpreted.
 */

import type { FileText, FileTextError } from "@shared/preview";

export interface TextSection {
  /** "Slide 3: Phases of mitosis" or "Page 2". `null` for text before the first heading. */
  heading: string | null;
  body: string;
  /** Speaker notes of a slide, when it has any. */
  notes: string | null;
}

/** The headings the main process writes: `## Page 4`, `## Slide 2`, `## Slide 2: Title`. */
const HEADING = /^## ((?:Page|Slide) \d+(?:: .*)?)$/;
const NOTES_MARK = "Speaker notes:\n";

function section(heading: string | null, lines: readonly string[]): TextSection {
  const text = lines.join("\n").trim();
  if (text.startsWith(NOTES_MARK)) {
    return { heading, body: "", notes: text.slice(NOTES_MARK.length).trim() || null };
  }
  const at = text.lastIndexOf(`\n\n${NOTES_MARK}`);
  if (at === -1) return { heading, body: text, notes: null };
  return {
    heading,
    body: text.slice(0, at).trim(),
    notes: text.slice(at + 2 + NOTES_MARK.length).trim() || null,
  };
}

/** Cuts `FileText.text` at its page or slide headings. Sections with nothing in them are kept. */
export function splitSections(text: string): TextSection[] {
  const sections: TextSection[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const close = () => {
    if (heading !== null || lines.some((line) => line.trim() !== "")) {
      sections.push(section(heading, lines));
    }
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = HEADING.exec(line);
    if (match) {
      close();
      heading = match[1] ?? null;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  close();
  return sections;
}

/**
 * What was left out of the text, as a sentence, or `null` when the whole file is there.
 */
export function coverageNote(file: FileText): string | null {
  const units = file.unit === "page" ? "pages" : "slides";
  const partial = file.readCount < file.totalCount;
  if (file.stopped === null && !partial) return null;

  const shown = partial
    ? `Only the first ${file.readCount} of ${file.totalCount} ${units} are shown.`
    : `The text stops before the end of the last ${file.unit}.`;
  switch (file.stopped) {
    case "count-limit":
      return `${shown} The file has more ${units} than Studiplan reads from one file.`;
    case "text-limit":
      return `${shown} The file has more text than Studiplan reads from one file.`;
    case "time-limit":
      return `${shown} Reading took too long, so Studiplan stopped there.`;
    default:
      return `${shown} The rest could not be read.`;
  }
}

/**
 * What to say about pages or slides that are pictures with no readable text, or `null` when
 * there are too few to matter. The thresholds are the main process's own, so the preview and
 * what is sent to the AI agree: at least 3 of them, and at least a tenth of the file. From half
 * upward the file is "mostly a scan".
 */
export function textlessNote(file: FileText): { title: string; body: string } | null {
  const without = file.textlessCount ?? 0;
  const of = file.readCount;
  if (without < 3 || of <= 0 || without / of < 0.1) return null;
  const units = file.unit === "page" ? "pages" : "slides";
  const title =
    without / of >= 0.5
      ? `Mostly ${file.unit === "page" ? "a scan" : "pictures"}: ${without} of ${of} ${units} are pictures with no readable text.`
      : `${without} of ${of} ${units} are pictures with no readable text.`;
  return {
    title,
    body: `What is on them may be missing from what you make from this material. Adding photos of those ${units} always works.`,
  };
}

/** Said when a PDF's formulas did not come through as text. */
export const FORMULAS_LOST_NOTE =
  "The formulas in this PDF could not be read as text, so what is made from it may miss them or get them wrong. Adding photos of the pages with the formulas helps.";

/** A short heading for each way reading a file's text can fail. The sentence comes with the error. */
export function textErrorTitle(error: FileTextError, unit: "page" | "slide"): string {
  switch (error.code) {
    case "no-text":
      return unit === "slide" ? "These slides have no text" : "This file has no text";
    case "encrypted":
      return "This file is password-protected";
    case "damaged":
      return "This file could not be read";
    case "timed-out":
      return "Reading took too long";
    case "not-found":
      return "This file is no longer here";
    case "too-large":
      return "This file is too large to read";
    default:
      return "The text could not be read";
  }
}

/** Failures that say something about the file rather than that something went wrong. */
export function isCalmTextError(error: FileTextError): boolean {
  return error.code === "no-text" || error.code === "encrypted";
}

/** Failures where pressing "Try again" can help. */
export function canRetryTextError(error: FileTextError): boolean {
  return error.code === "timed-out" || error.code === "io" || error.code === "not-found";
}

/** "3.2 s" below a minute, "1 min 5 s" above. For how long an AI took to answer. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 950) return "under a second";
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

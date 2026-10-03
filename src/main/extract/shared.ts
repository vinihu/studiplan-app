/**
 * What the PDF and the .pptx reader have in common: the failure type, reading the input within
 * the size cap, the deadline, and turning sections into text.
 */

import { open } from "node:fs/promises";

import {
  EDGE_LINES,
  LOST_FORMULA_MIN_LINES,
  MAX_EXTRACT_MS,
  MAX_INPUT_BYTES,
  NO_TEXT_THRESHOLD,
  PAGE_TEXT_THRESHOLD,
  REPEATED_LINE_MIN_COUNT,
  REPEATED_LINE_MIN_PAGES,
  REPEATED_LINE_SHARE,
} from "./limits";
import type {
  ExtractErrorCode,
  ExtractInput,
  ExtractOptions,
  ExtractResult,
  ExtractedDocument,
  ExtractedSection,
} from "./types";

/** A failure the student can be told about. Thrown inside the module, never out of it. */
export class ExtractFailure extends Error {
  readonly code: ExtractErrorCode;

  constructor(code: ExtractErrorCode, message: string) {
    super(message);
    this.name = "ExtractFailure";
    this.code = code;
  }
}

export function fail(code: ExtractErrorCode, message: string): never {
  throw new ExtractFailure(code, message);
}

const TOO_LARGE = `This file is too large to read. The largest file Studiplan reads text from is ${MAX_INPUT_BYTES / 1024 / 1024} MB.`;

/** The input's bytes, refusing anything over the size cap before it is in memory. */
export async function readInput(input: ExtractInput): Promise<Uint8Array> {
  if (typeof input !== "string") {
    if (input.byteLength > MAX_INPUT_BYTES) fail("too-large", TOO_LARGE);
    return input;
  }
  let handle;
  try {
    handle = await open(input, "r");
  } catch {
    fail("unreadable", "This file could not be opened. It may have been moved, deleted, or be open in another program.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("unreadable", "This file could not be opened.");
    if (info.size > MAX_INPUT_BYTES) fail("too-large", TOO_LARGE);
    // The file can still grow between the stat and the read, so the read itself is bounded too.
    const buffer = Buffer.allocUnsafe(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } catch (error) {
    if (error instanceof ExtractFailure) throw error;
    fail("unreadable", "This file could not be read. It may be open in another program.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A deadline and a cancel signal for one extraction. */
export class Clock {
  private readonly end: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: ExtractOptions) {
    const requested = options.timeoutMs;
    const ms =
      typeof requested === "number" && requested >= 0 ? Math.min(requested, MAX_EXTRACT_MS) : MAX_EXTRACT_MS;
    this.end = Date.now() + ms;
    this.signal = options.signal;
  }

  get expired(): boolean {
    return Date.now() >= this.end;
  }

  /** Throws `cancelled` when the caller gave up. */
  checkCancelled(): void {
    if (this.signal?.aborted) fail("cancelled", "Reading this file was cancelled.");
  }

  /**
   * Waits for `promise`, but no longer than the deadline or the cancel signal. Resolves to
   * `TIMED_OUT` when the deadline wins. The abandoned work is the caller's to clean up.
   */
  async race<T>(promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
    this.checkCancelled();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const signal = this.signal;
    try {
      return await Promise.race([
        promise,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, this.end - Date.now()));
        }),
        new Promise<never>((_, reject) => {
          if (!signal) return;
          onAbort = () => reject(new ExtractFailure("cancelled", "Reading this file was cancelled."));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      // Whoever lost the race must not become an unhandled rejection.
      promise.catch(() => undefined);
    }
  }
}

export const TIMED_OUT = Symbol("timed-out");

export const TIMEOUT_SENTENCE = "This file took too long to read, so Studiplan stopped. It may be damaged or unusually complex.";

/**
 * Look-alike characters some PDFs carry instead of the real ones, put right:
 *
 *  - Kangxi radicals and the CJK radicals supplement (U+2E80–U+2FDF): a font may map 用 to the
 *    radical ⽤ (U+2F64). It looks the same, but a search for the word does not find it and a
 *    model may copy it into a result. Each becomes the ordinary character it stands for.
 *  - Latin ligatures (U+FB00–U+FB06): ﬁ becomes fi.
 *
 * Deliberately not a blanket NFKC: that would also turn x² into x2 and ½ into 1⁄2, which
 * changes what a formula says.
 */
/**
 * The radicals of the CJK Radicals Supplement that are an ordinary character in all but code
 * point, and that Unicode's own normalisation leaves alone (the Kangxi block it does map).
 * A radical that is only ever a component (⺡, ⻌) is not here and stays as it is.
 */
const RADICAL_SUPPLEMENT: ReadonlyMap<number, string> = new Map([
  [0x2E8C, "小"],
  [0x2E8D, "小"],
  [0x2E9C, "日"],
  [0x2E9D, "月"],
  [0x2EA0, "民"],
  [0x2EA7, "牛"],
  [0x2EAB, "目"],
  [0x2EAC, "示"],
  [0x2EAE, "竹"],
  [0x2EB6, "羊"],
  [0x2EB7, "羊"],
  [0x2EBC, "肉"],
  [0x2EC1, "虎"],
  [0x2EC4, "西"],
  [0x2EC5, "见"],
  [0x2EC6, "角"],
  [0x2EC9, "贝"],
  [0x2ECA, "足"],
  [0x2ECB, "车"],
  [0x2ED1, "長"],
  [0x2ED3, "长"],
  [0x2ED4, "门"],
  [0x2ED7, "雨"],
  [0x2ED8, "青"],
  [0x2ED9, "韦"],
  [0x2EDA, "页"],
  [0x2EDB, "风"],
  [0x2EDC, "飞"],
  [0x2EDD, "食"],
  [0x2EE1, "首"],
  [0x2EE2, "马"],
  [0x2EE3, "骨"],
  [0x2EE4, "鬼"],
  [0x2EE5, "鱼"],
  [0x2EE6, "鸟"],
  [0x2EE7, "卤"],
  [0x2EE8, "麦"],
  [0x2EE9, "黄"],
  [0x2EEA, "黾"],
  [0x2EEC, "齐"],
  [0x2EEE, "齿"],
  [0x2EF0, "龙"],
]);

export function plainCharacters(text: string): string {
  return text.replace(
    /[\u2E80-\u2FDF\uFB00-\uFB06]/g,
    (character) => RADICAL_SUPPLEMENT.get(character.charCodeAt(0)) ?? character.normalize("NFKC"),
  );
}

/**
 * Tidy whitespace inside one page or slide without merging its lines, and drop control
 * characters (a file can carry any, and the text goes into a prompt and onto the screen).
 */
export function tidy(text: string): string {
  return plainCharacters(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\f\v]/g, " ")
    .replace(/[^\P{Cc}\n\t]|\p{Cs}/gu, "")
    .replace(/[\t\p{Zs}]+/gu, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One section as text: a `##` heading, the body, then the speaker notes if there are any. */
export function renderSection(unit: "page" | "slide", section: ExtractedSection): string {
  const label = unit === "page" ? "Page" : "Slide";
  const hidden = section.hidden === true ? " (hidden)" : "";
  const heading = `## ${label} ${section.number}${hidden}${section.title ? `: ${section.title}` : ""}`;
  const body = section.body || (section.title || section.notes ? "" : "(no text)");
  const notes = section.notes ? `Speaker notes:\n${section.notes}` : "";
  return [heading, body, notes].filter((part) => part !== "").join("\n\n");
}

export function renderSections(unit: "page" | "slide", sections: readonly ExtractedSection[]): string {
  return sections.map((section) => renderSection(unit, section)).join("\n\n");
}

/** Characters of real content in a section (what the "no text" check and the caps count). */
export function sectionChars(section: ExtractedSection): number {
  return (section.title?.length ?? 0) + section.body.length + (section.notes?.length ?? 0);
}

export function hasNoRealText(sections: readonly ExtractedSection[]): boolean {
  let count = 0;
  for (const section of sections) {
    const text = `${section.title ?? ""}${section.body}${section.notes ?? ""}`;
    count += text.replace(/\s+/g, "").length;
    if (count >= NO_TEXT_THRESHOLD) return false;
  }
  return true;
}

/** Whether one page or slide has any text worth the name. */
export function hasText(section: ExtractedSection): boolean {
  const text = `${section.title ?? ""}${section.body}${section.notes ?? ""}`;
  return text.replace(/\s+/g, "").length >= PAGE_TEXT_THRESHOLD;
}

/** A line with its numbers blanked: "7.2 • Glycolysis 193" and "… 195" are the same line. */
function lineKey(line: string): string {
  return line.trim().replace(/\d+/g, "#");
}

/**
 * The first and last lines of a page. None for a page with so few lines that its edges are
 * most of it: such a page is left alone.
 */
function edgeIndexes(lines: readonly string[]): number[] {
  const filled = lines.flatMap((line, index) => (line.trim() === "" ? [] : [index]));
  if (filled.length <= EDGE_LINES * 2) return [];
  return [...filled.slice(0, EDGE_LINES), ...filled.slice(-EDGE_LINES)];
}

/**
 * Removes running headers and footers from the pages of a PDF: a line (numbers aside) that
 * stands among the first or last lines of many pages — "Access for free at openstax.org", the
 * author and title, "- 12 -". They say nothing about the subject and cost room in every
 * request. Only edge lines are ever removed, so a sentence that repeats inside the text stays,
 * and a page is never left without text by it.
 * Changes `sections` in place; returns how many lines were removed.
 */
export function stripRepeatedEdgeLines(sections: ExtractedSection[]): number {
  if (sections.length < REPEATED_LINE_MIN_PAGES) return 0;
  const pages = sections.map((section) => section.body.split("\n"));
  const seen = new Map<string, number>();
  for (const lines of pages) {
    for (const key of new Set(edgeIndexes(lines).map((index) => lineKey(lines[index] ?? "")))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const needed = Math.max(REPEATED_LINE_MIN_COUNT, Math.ceil(sections.length * REPEATED_LINE_SHARE));
  const repeated = new Set([...seen].filter(([, count]) => count >= needed).map(([key]) => key));
  if (repeated.size === 0) return 0;

  let removed = 0;
  for (const [position, lines] of pages.entries()) {
    const drop = new Set(edgeIndexes(lines).filter((index) => repeated.has(lineKey(lines[index] ?? ""))));
    if (drop.size === 0) continue;
    const section = sections[position];
    if (section === undefined) continue;
    const body = tidy(lines.filter((_, index) => !drop.has(index)).join("\n"));
    if (!hasText({ ...section, body })) continue;
    removed += drop.size;
    section.body = body;
  }
  return removed;
}

/** What is left of a formula the PDF has no characters for: "( ( ) ) (2.1)", "( )". */
const FORMULA_LEFTOVER = /^(?=.*\(\s*\))[\s()[\]{}=+\-−–·×*/.,;:|<>≤≥≈^_\d]+$/;

/** True when a PDF's text shows that its formulas did not come through. */
export function formulasWereLost(sections: readonly ExtractedSection[]): boolean {
  let count = 0;
  for (const section of sections) {
    for (const line of section.body.split("\n")) {
      if (FORMULA_LEFTOVER.test(line) && ++count >= LOST_FORMULA_MIN_LINES) return true;
    }
  }
  return false;
}

export function buildDocument(
  kind: ExtractedDocument["kind"],
  totalCount: number,
  sections: ExtractedSection[],
  stopped: ExtractedDocument["stopped"],
): ExtractedDocument {
  const unit = kind === "pdf" ? "page" : "slide";
  return {
    kind,
    unit,
    totalCount,
    sections,
    stopped,
    textlessCount: sections.filter((section) => !hasText(section)).length,
    formulasLost: kind === "pdf" && formulasWereLost(sections),
    text: renderSections(unit, sections),
  };
}

/** Runs one extraction and turns whatever happens into an `ExtractResult`. Nothing is thrown. */
export async function toResult(
  operation: () => Promise<ExtractedDocument>,
  unexpected: { code: ExtractErrorCode; message: string },
): Promise<ExtractResult> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ExtractFailure) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: unexpected };
  }
}

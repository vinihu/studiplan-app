/**
 * A whole material as what ONE AI request may carry: the text of its PDFs and decks, labelled
 * by file and cut to a budget, plus the photo pages to send as images, capped in count and
 * bytes.
 *
 * This module calls no model and knows nothing about one. Everything it returns came out of the student's files:
 * a prompt built from it must present it as material to study from, never as instructions.
 *
 * Nothing is dropped silently. Every cut, every page left out and every file that contributed
 * nothing is listed in `notices`, each with the numbers and a ready sentence.
 */

import { stat } from "node:fs/promises";

import { extractText } from "./extract";
import {
  MOSTLY_SCANNED_SHARE,
  PROMPT_MAX_IMAGES,
  PROMPT_MAX_IMAGE_BYTES,
  PROMPT_MAX_TEXT_CHARS,
  TEXTLESS_NOTICE_MIN_PAGES,
  TEXTLESS_NOTICE_SHARE,
} from "./limits";
import { renderSection } from "./shared";
import type { ExtractErrorCode, ExtractOptions, ExtractResult, TextFileKind } from "./types";

/** One file of a material, in the material's order. Paths are already validated by the caller. */
export type MaterialFileInput =
  | { name: string; kind: TextFileKind; path: string }
  | { name: string; kind: "photo-set"; pagePaths: string[] };

export interface PromptTextPart {
  type: "text";
  /** The file's name inside the material. */
  name: string;
  kind: TextFileKind;
  /** A label line naming the file and what part of it follows, then the pages or slides. */
  text: string;
  unit: "page" | "slide";
  /** Pages or slides in `text`. */
  sentCount: number;
  /** Pages or slides the file has. */
  totalCount: number;
  /** True when `text` is not the whole file. */
  truncated: boolean;
}

export interface PromptImagesPart {
  type: "images";
  /** The photo set's folder name. */
  name: string;
  /** The page images to send, in page order. */
  paths: string[];
  /** Pages the photo set has. */
  totalCount: number;
}

export type PromptPart = PromptTextPart | PromptImagesPart;

/** Something that was cut or left out. `message` is a sentence the UI can show as it is. */
export type ContentNotice =
  | {
      type: "text-cut";
      file: string;
      unit: "page" | "slide";
      /** Pages or slides sent, counted from the first. */
      sent: number;
      total: number;
      /** True when the last page sent is itself cut short. */
      partial: boolean;
      message: string;
    }
  | { type: "photos-left-out"; file: string; sent: number; total: number; message: string }
  | {
      /** A PDF with text on some pages and none on others: the others are pictures (a scan). */
      type: "pages-without-text";
      file: string;
      /** Pages with no readable text, out of `total` pages read. */
      textless: number;
      total: number;
      /**
       * True when most of the file is like that: it is a scan with a text page or two in front.
       * A caller that can hand the file itself to the AI should do that instead of the text.
       */
      mostly: boolean;
      message: string;
    }
  | { type: "formulas-lost"; file: string; message: string }
  | { type: "file-skipped"; file: string; reason: ExtractErrorCode | "no-room" | "empty"; message: string };

export interface PromptContent {
  /** In the material's file order. Empty when nothing in the material can be sent. */
  parts: PromptPart[];
  notices: ContentNotice[];
  /** False when anything was cut, left out or skipped: the result comes from part of the material. */
  complete: boolean;
  totals: { files: number; textChars: number; images: number; imageBytes: number };
  /** The bounds that were applied. */
  limits: { maxTextChars: number; maxImages: number; maxImageBytes: number };
}

export interface PromptContentOptions {
  /** Lower the text bound (a provider with a small context window). Clamped to the default. */
  maxTextChars?: number;
  /** Lower the image-count bound; 0 sends no photos. Clamped to the default. */
  maxImages?: number;
  /** Lower the image-bytes bound. Clamped to the default. */
  maxImageBytes?: number;
  signal?: AbortSignal;
  /** Replace the extractor (tests, or a caller that caches extracted text). */
  extract?: (kind: TextFileKind, path: string, options: ExtractOptions) => Promise<ExtractResult>;
}

function bound(value: number | undefined, ceiling: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return ceiling;
  return Math.min(value, ceiling);
}

/**
 * Share `budget` between files of the given sizes, fairly (water-filling): every file that
 * fits in an equal share is kept whole, and what it did not use is shared among the rest.
 * So three short files and one huge one come out as three whole files and one cut file,
 * never as one whole file and three missing ones. The result never sums to more than `budget`.
 */
export function shareBudget(sizes: readonly number[], budget: number): number[] {
  const allocation = sizes.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  let open = sizes.map((_, index) => index).filter((index) => (sizes[index] ?? 0) > 0);
  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    const fits = open.filter((index) => (sizes[index] ?? 0) <= share);
    if (fits.length === 0) {
      // Nobody fits whole: an equal share each, the odd units to the earliest files.
      let extra = remaining - share * open.length;
      for (const index of open) {
        allocation[index] = share + (extra > 0 ? 1 : 0);
        extra -= 1;
      }
      break;
    }
    for (const index of fits) {
      allocation[index] = sizes[index] ?? 0;
      remaining -= sizes[index] ?? 0;
    }
    open = open.filter((index) => (sizes[index] ?? 0) > share);
  }
  return allocation;
}

/** Characters set aside per file for its label line, so the total stays under the bound. */
const LABEL_RESERVE = 200;
const SEPARATOR = "\n\n";

/** A file name fit for a label: one line, no control characters, not endless. */
function labelName(name: string): string {
  const clean = name.replace(/\p{Cc}+/gu, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function label(name: string, kind: TextFileKind, unit: string, sent: number, total: number, partial: boolean): string {
  const type = kind === "pdf" ? "PDF" : "PowerPoint";
  const range =
    sent >= total && !partial
      ? `all ${plural(total, unit)}`
      : `${unit}s 1-${sent} of ${total}${partial ? `, ${unit} ${sent} cut short` : ""}`;
  return `=== File: ${labelName(name)} (${type}, ${range}) ===`.slice(0, LABEL_RESERVE - SEPARATOR.length);
}

/**
 * What one request may send for a material, given its files in order.
 *
 * Text: at most `PROMPT_MAX_TEXT_CHARS` characters across all PDFs and decks, labels included,
 * shared fairly (see `shareBudget`). A file is cut at a page or slide boundary; only when not
 * even its first page fits its share is that page itself cut short.
 *
 * Photos: at most `PROMPT_MAX_IMAGES` pages across all photo sets, shared fairly between the
 * sets (each keeps its first pages), and at most `PROMPT_MAX_IMAGE_BYTES` in total.
 *
 * Never throws for a bad file: it is listed in `notices` and the rest is returned.
 */
export async function buildPromptContent(
  files: readonly MaterialFileInput[],
  options: PromptContentOptions = {},
): Promise<PromptContent> {
  const limits = {
    maxTextChars: bound(options.maxTextChars, PROMPT_MAX_TEXT_CHARS),
    maxImages: bound(options.maxImages, PROMPT_MAX_IMAGES),
    maxImageBytes: bound(options.maxImageBytes, PROMPT_MAX_IMAGE_BYTES),
  };
  const extract = options.extract ?? extractText;
  const extractOptions: ExtractOptions = options.signal ? { signal: options.signal } : {};

  const notices: ContentNotice[] = [];
  const slots: (PromptPart | null)[] = files.map(() => null);
  const totals = { files: files.length, textChars: 0, images: 0, imageBytes: 0 };

  // ── Text ──────────────────────────────────────────────────────────────────────────────────
  const readable: {
    index: number;
    name: string;
    kind: TextFileKind;
    unit: "page" | "slide";
    totalCount: number;
    sections: string[];
    size: number;
  }[] = [];
  for (const [index, file] of files.entries()) {
    if (file.kind === "photo-set") continue;
    let result: ExtractResult;
    try {
      result = await extract(file.kind, file.path, extractOptions);
    } catch {
      result = { ok: false, error: { code: "corrupt", message: "This file could not be read." } };
    }
    if (!result.ok) {
      notices.push({
        type: "file-skipped",
        file: file.name,
        reason: result.error.code,
        message: `"${labelName(file.name)}" was not sent. ${result.error.message}`,
      });
      continue;
    }
    const document = result.value;
    if (document.kind === "pdf" && document.textlessCount > 0) {
      const read = document.sections.length;
      const share = document.textlessCount / read;
      const mostly = share >= MOSTLY_SCANNED_SHARE;
      if (mostly || (document.textlessCount >= TEXTLESS_NOTICE_MIN_PAGES && share >= TEXTLESS_NOTICE_SHARE)) {
        const pages = `${document.textlessCount} of the ${plural(read, "page")}`;
        notices.push({
          type: "pages-without-text",
          file: file.name,
          textless: document.textlessCount,
          total: read,
          mostly,
          message: mostly
            ? `"${labelName(file.name)}" is mostly a scan: ${pages} have no readable text (they are pictures), so only the rest was sent. Add photos of the pages you need.`
            : `${pages} of "${labelName(file.name)}" have no readable text (they are pictures) and were not sent. Add photos of those pages if they matter.`,
        });
      }
    }
    if (document.formulasLost) {
      notices.push({
        type: "formulas-lost",
        file: file.name,
        message: `The formulas in "${labelName(file.name)}" could not be read as text, so what is made from it may miss them or get them wrong. Add photos of the pages with the formulas.`,
      });
    }
    const sections = document.sections.map((section) => renderSection(document.unit, section));
    const size = sections.reduce((sum, text) => sum + text.length + SEPARATOR.length, 0);
    readable.push({
      index,
      name: file.name,
      kind: file.kind,
      unit: document.unit,
      totalCount: document.totalCount,
      sections,
      size,
    });
  }

  const allocation = shareBudget(
    readable.map((file) => file.size),
    limits.maxTextChars - readable.length * LABEL_RESERVE,
  );
  for (const [position, file] of readable.entries()) {
    const room = allocation[position] ?? 0;
    const kept: string[] = [];
    let used = 0;
    for (const section of file.sections) {
      if (used + section.length + SEPARATOR.length > room) break;
      kept.push(section);
      used += section.length + SEPARATOR.length;
    }
    let partial = false;
    const first = file.sections[0];
    if (kept.length === 0 && first !== undefined && room > SEPARATOR.length) {
      // Not even the first page fits the share: send the start of it rather than nothing.
      kept.push(first.slice(0, room - SEPARATOR.length).trimEnd());
      partial = true;
    }
    if (kept.length === 0) {
      notices.push({
        type: "file-skipped",
        file: file.name,
        reason: "no-room",
        message: `"${labelName(file.name)}" was not sent. This material holds more text than one request can take.`,
      });
      continue;
    }
    const sent = kept.length;
    const truncated = partial || sent < file.totalCount;
    if (truncated) {
      const units = `${file.unit}s`;
      notices.push({
        type: "text-cut",
        file: file.name,
        unit: file.unit,
        sent,
        total: file.totalCount,
        partial,
        message: partial
          ? `Only the beginning of the first ${file.unit} of "${labelName(file.name)}" was sent (it has ${plural(file.totalCount, file.unit)}).`
          : `Only the first ${sent} of ${file.totalCount} ${units} of "${labelName(file.name)}" were sent.`,
      });
    }
    const text = [label(file.name, file.kind, file.unit, sent, file.totalCount, partial), ...kept].join(SEPARATOR);
    totals.textChars += text.length;
    slots[file.index] = {
      type: "text",
      name: file.name,
      kind: file.kind,
      text,
      unit: file.unit,
      sentCount: sent,
      totalCount: file.totalCount,
      truncated,
    };
  }

  // ── Photos ────────────────────────────────────────────────────────────────────────────────
  const sets = files.flatMap((file, index) => (file.kind === "photo-set" ? [{ index, file }] : []));
  const imageShare = shareBudget(
    sets.map((set) => set.file.pagePaths.length),
    limits.maxImages,
  );
  let bytesFull = false;
  for (const [position, { index, file }] of sets.entries()) {
    const total = file.pagePaths.length;
    if (total === 0) {
      notices.push({
        type: "file-skipped",
        file: file.name,
        reason: "empty",
        message: `"${labelName(file.name)}" was not sent. It has no photos in it.`,
      });
      continue;
    }
    const paths: string[] = [];
    for (const path of file.pagePaths.slice(0, imageShare[position] ?? 0)) {
      if (bytesFull) break;
      let size: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        size = info.size;
      } catch {
        continue; // moved or deleted since the material was listed: counted as left out
      }
      if (totals.imageBytes + size > limits.maxImageBytes) {
        bytesFull = true;
        break;
      }
      totals.imageBytes += size;
      paths.push(path);
    }
    totals.images += paths.length;
    if (paths.length < total) {
      const left = total - paths.length;
      notices.push({
        type: "photos-left-out",
        file: file.name,
        sent: paths.length,
        total,
        message:
          paths.length === 0
            ? `None of the ${plural(total, "photo")} in "${labelName(file.name)}" could be sent.`
            : `${left} of ${plural(total, "photo")} in "${labelName(file.name)}" ${left === 1 ? "was" : "were"} left out.`,
      });
    }
    if (paths.length > 0) slots[index] = { type: "images", name: file.name, paths, totalCount: total };
  }

  return {
    parts: slots.filter((part): part is PromptPart => part !== null),
    notices,
    complete: notices.length === 0,
    totals,
    limits,
  };
}

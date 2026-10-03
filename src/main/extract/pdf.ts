/**
 * PDF text through `unpdf` (a build of PDF.js with no DOM, no worker file and no canvas).
 *
 * Pages are read one at a time instead of all at once, so a file with an absurd page count, or one that takes forever, is
 * stopped at a cap and returned as incomplete rather than read to the end.
 *
 * Nothing in a PDF is executed: PDF.js's text layer never runs document JavaScript, and the
 * build unpdf ships contains no `eval` or `new Function` at all. The bytes are handed over
 * directly, so nothing is fetched.
 */

import { getDocumentProxy } from "unpdf";

import { MAX_EXTRACT_CHARS, MAX_PAGE_CHARS, MAX_PDF_PAGES } from "./limits";
import {
  Clock,
  ExtractFailure,
  TIMED_OUT,
  TIMEOUT_SENTENCE,
  buildDocument,
  fail,
  formulasWereLost,
  stripRepeatedEdgeLines,
  hasNoRealText,
  readInput,
  sectionChars,
  tidy,
  toResult,
} from "./shared";
import type {
  ExtractInput,
  ExtractOptions,
  ExtractResult,
  ExtractedDocument,
  ExtractedSection,
} from "./types";

const CORRUPT = "This PDF is damaged and cannot be read. Try exporting or downloading it again.";

export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-". PDF.js accepts the header anywhere in the first kilobyte; so do we.
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.includes("%PDF-", 0, "latin1");
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Frees the parsed document (`loadingTask.destroy()`; `cleanup()` alone keeps it). PDF.js waits
 * for whatever it was doing to wind down first, and for a page that was stopped half-way that
 * can be never, so this waits a moment and no longer.
 */
async function release(pdf: PdfDocument): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    pdf.loadingTask.destroy().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]);
  clearTimeout(timer);
}

/** Lets timers, a cancel and everything else that is waiting have their turn. */
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface TextChunk {
  items?: Array<{ str?: unknown; hasEOL?: unknown }>;
}

/**
 * One page's text, read piece by piece as PDF.js produces it, so that it can stop: at
 * `MAX_PAGE_CHARS`, or when the clock says so. Between pieces everything else gets its turn.
 * (`getTextContent()` would build the whole page first, however large.)
 */
async function pageText(pdf: PdfDocument, pageNumber: number, clock: Clock): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  try {
    const reader = (page.streamTextContent() as ReadableStream<TextChunk>).getReader();
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of value.items ?? []) {
          if (typeof item.str === "string") text += item.str + (item.hasEOL === true ? "\n" : "");
        }
        if (text.length >= MAX_PAGE_CHARS) {
          text = text.slice(0, MAX_PAGE_CHARS);
          break;
        }
        await breathe();
        clock.checkCancelled();
        if (clock.expired) break;
      }
    } finally {
      // Tells PDF.js to stop producing the rest of the page.
      await reader.cancel().catch(() => undefined);
    }
    return text;
  } finally {
    page.cleanup();
  }
}

async function readPdf(input: ExtractInput, options: ExtractOptions): Promise<ExtractedDocument> {
  const clock = new Clock(options);
  clock.checkCancelled();
  const bytes = await readInput(input);
  if (!looksLikePdf(bytes)) {
    fail("not-a-pdf", "This file is not a PDF, even though its name says so. Open it in the program it came from, save it as a PDF, and add that.");
  }

  let pdf: PdfDocument | typeof TIMED_OUT;
  try {
    // PDF.js may detach the buffer it is given; hand it a copy so the caller's stays usable.
    pdf = await clock.race(
      getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 }),
    );
  } catch (error) {
    if (error instanceof ExtractFailure) throw error;
    if (errorName(error) === "PasswordException") {
      fail("encrypted", "This PDF is password-protected. Save a copy without the password and add that instead.");
    }
    fail("corrupt", CORRUPT);
  }
  if (pdf === TIMED_OUT) fail("timeout", TIMEOUT_SENTENCE);

  try {
    const totalCount = pdf.numPages;
    if (!Number.isInteger(totalCount) || totalCount < 1) fail("corrupt", CORRUPT);

    const sections: ExtractedSection[] = [];
    let stopped: ExtractedDocument["stopped"] = null;
    let chars = 0;
    let failedPages = 0;
    for (let number = 1; number <= totalCount; number += 1) {
      if (number > MAX_PDF_PAGES) {
        stopped = "count-limit";
        break;
      }
      if (chars > MAX_EXTRACT_CHARS) {
        stopped = "text-limit";
        break;
      }
      if (clock.expired) {
        stopped = "time-limit";
        break;
      }
      let body = "";
      try {
        const text = await clock.race(pageText(pdf, number, clock));
        if (text === TIMED_OUT) {
          stopped = "time-limit";
          break;
        }
        body = tidy(text);
      } catch (error) {
        if (error instanceof ExtractFailure) throw error;
        // One broken page does not make the rest unreadable.
        failedPages += 1;
      }
      const section = { number, title: null, body, notes: null };
      sections.push(section);
      chars += sectionChars(section);
      // Between pages too: a long file must not hold up whoever else is waiting.
      await breathe();
    }

    if (sections.length === 0) fail("timeout", TIMEOUT_SENTENCE);
    if (failedPages === sections.length) fail("corrupt", CORRUPT);
    if (hasNoRealText(sections)) {
      fail(
        "no-text",
        "This PDF has no readable text. It looks like a scan: pages stored as pictures. Add photos of the pages instead.",
      );
    }
    // After the checks above, so a file is never judged by what was taken out of it.
    const lost = formulasWereLost(sections);
    stripRepeatedEdgeLines(sections);
    return { ...buildDocument("pdf", totalCount, sections, stopped), formulasLost: lost };
  } finally {
    await release(pdf);
  }
}

/** Every page's text. Never throws: a file that cannot be read comes back as `ok: false`. */
export function extractPdfText(input: ExtractInput, options: ExtractOptions = {}): Promise<ExtractResult> {
  return toResult(() => readPdf(input, options), { code: "corrupt", message: CORRUPT });
}

/**
 * How many pages a PDF has, or `null` when that cannot be told (not a PDF, damaged, encrypted,
 * too large, cancelled, too slow). Reads no text. For a scan, whose text reading fails with
 * `no-text` and so reports no page count.
 */
export async function countPdfPages(input: ExtractInput, options: ExtractOptions = {}): Promise<number | null> {
  try {
    const clock = new Clock(options);
    const bytes = await readInput(input);
    if (!looksLikePdf(bytes)) return null;
    const pdf = await clock.race(getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 }));
    if (pdf === TIMED_OUT) return null;
    try {
      const total = pdf.numPages;
      return Number.isInteger(total) && total >= 1 ? total : null;
    } finally {
      await release(pdf);
    }
  } catch {
    return null;
  }
}

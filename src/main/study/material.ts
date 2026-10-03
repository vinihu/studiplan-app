/**
 * A material as the parts of one AI request: what goes, how it goes, and what was left out.
 *
 * How each kind of file reaches the model:
 *
 *  - **A PDF or .pptx with text**: the text is read locally and sent inline, cut to the budget
 *    of `src/main/extract` — or to the provider's own, smaller one (`Provider.maxTextChars`: a
 *    local Ollama model has a small context). Bounded, and what was cut is known exactly (pages
 *    1-23 of 120), so the student can be told.
 *  - **A photo set**: the page images go as `image` parts, within the photo budget — or the
 *    provider's own (`Provider.maxAttachmentBytes`: Google takes 20 MB per request, encoded).
 *  - **A PDF with no text layer (a scan)**: local reading yields nothing. A provider that can
 *    look at a PDF's pages (`readsScannedPdfs`) gets the file as a `file` part, up to
 *    `MAX_SCANNED_PAGES` pages per request. One that can read a page range (Claude Code) is told
 *    to stop there; one that is sent the whole file (an API key) only gets scans that fit. For
 *    any other provider the file is left out and the student is told to add photos instead.
 *
 * When anything goes as a file, the request's folder is the material's `files/` folder — not the
 * material's folder — so no provider can reach `material.json` or earlier results in `sets/`.
 *
 * No Electron import, so it runs in tests.
 */
import { buildPromptContent, countPdfPages } from "../extract";
import type { MaterialFileInput, PromptContent, PromptContentOptions } from "../extract";
import type { LocatedMaterial } from "../library/library";
import type { Part, Provider } from "../providers";

/** Pages of scanned PDFs one request asks the model to look at, across all of them. */
export const MAX_SCANNED_PAGES = 20;
/** Bytes of scanned PDFs one request hands over, across all of them. */
export const MAX_SCANNED_PDF_BYTES = 20 * 1024 * 1024;
/** Scanned PDFs in one request. */
export const MAX_SCANNED_PDFS = 5;
/**
 * A PDF with at least this share of pages without text is a scan with a page of text in front
 * (a library's notice, a cover sheet). When it cannot go as a scan it is not sent at all: its
 * text is not what the student wants summarised.
 */
export const SCAN_WITH_COVER_SHARE = 0.9;

/** Below this, a provider's text budget is not worth cutting to: it gets this much and may refuse. */
export const MIN_TEXT_CHARS = 2_000;

/** A guess at what a page holds, for the size of a summary: handwriting is sparse, print is not. */
const WORDS_PER_PHOTO = 120;
const WORDS_PER_SCANNED_PAGE = 250;

export interface PreparedMaterial {
  /** Empty when nothing in the material can be sent. */
  parts: Part[];
  /** Set when a part is a file or an image: the folder the paths lie in. */
  workingDirectory?: string;
  /** Sentences about everything that was cut, left out or skipped. */
  notices: string[];
  /** True when `notices` is empty: the model gets the whole material. */
  complete: boolean;
  /** Added to the instructions when scanned PDFs are handed over; otherwise `null`. */
  delivery: string | null;
  /**
   * Roughly how many words the parts hold: the text counted, a photographed or scanned page
   * guessed. Only good enough to say how long a summary of it should be.
   */
  words: number;
  /** For the log: numbers only. */
  counts: { files: number; textChars: number; images: number; scannedPdfs: number; notices: number };
}

export interface PrepareOptions {
  signal?: AbortSignal;
  /** The model the request will use, for the provider's own limits. */
  model?: string;
  /** Characters of instructions and schema the request will carry, with room for the retry. */
  instructionChars?: number;
  /** Replaced in tests. */
  buildContent?: (files: readonly MaterialFileInput[], options: PromptContentOptions) => Promise<PromptContent>;
  countPages?: (path: string, options: { signal?: AbortSignal }) => Promise<number | null>;
}

export type PreparingProvider = Pick<
  Provider,
  "label" | "readsScannedPdfs" | "readsPdfPageRanges" | "maxTextChars" | "maxAttachmentBytes"
>;

function quote(name: string): string {
  const clean = name.replace(/\p{Cc}+/gu, " ").trim();
  return `"${clean.length > 120 ? `${clean.slice(0, 119)}…` : clean}"`;
}

/** A limit a provider reports, or `undefined` when it reports none or the asking failed. */
async function limit(ask: (() => Promise<number | undefined>) | undefined): Promise<number | undefined> {
  if (ask === undefined) return undefined;
  try {
    const value = await ask();
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareMaterial(
  material: LocatedMaterial,
  provider: PreparingProvider,
  options: PrepareOptions = {},
): Promise<PreparedMaterial> {
  const build = options.buildContent ?? buildPromptContent;
  const countPages = options.countPages ?? countPdfPages;
  const signal = options.signal;

  // A PDF that was made from a photo set of this material holds the same pages as the photos.
  // While the photos are there, they are what goes; the PDF is not read and not sent, and
  // that is no loss, so nothing is said about it.
  const sets = new Set(material.files.filter((file) => file.kind === "photo-set").map((file) => file.name));
  const sent = material.files.filter(
    (file) => !(file.kind === "pdf" && file.madeFrom !== undefined && sets.has(file.madeFrom)),
  );
  const inputs: MaterialFileInput[] = sent.map((file) =>
    file.kind === "photo-set"
      ? { name: file.name, kind: "photo-set", pagePaths: file.pagePaths }
      : { name: file.name, kind: file.kind, path: file.path },
  );

  // The provider's own limits. The photos are counted first, as the most that can go: what
  // they cost comes out of the room for text.
  const photos = material.files.reduce((sum, file) => sum + (file.kind === "photo-set" ? file.pagePaths.length : 0), 0);
  const attachmentBytes = await limit(
    provider.maxAttachmentBytes === undefined ? undefined : () => provider.maxAttachmentBytes!(options.model),
  );
  const textChars = await limit(
    provider.maxTextChars === undefined
      ? undefined
      : () => provider.maxTextChars!(options.model, { images: photos, instructionChars: options.instructionChars ?? 0 }),
  );

  const content = await build(inputs, {
    ...(signal ? { signal } : {}),
    ...(textChars === undefined ? {} : { maxTextChars: Math.max(MIN_TEXT_CHARS, textChars) }),
    ...(attachmentBytes === undefined ? {} : { maxImageBytes: attachmentBytes }),
  });

  // Scans: hand the file itself to a provider that can look at its pages. A scan is a PDF with
  // no text at all, or one that is mostly pictures (a scanned book behind a page of text).
  const notices: string[] = [];
  const asScan = new Set<string>();
  const left = new Set<string>();
  /** A mostly-scanned file that cannot go as a scan: its text goes, or nothing of it does. */
  const cannotGoAsScan = (notice: (typeof content.notices)[number], why: string): void => {
    if (notice.type !== "pages-without-text") return;
    if (notice.textless / notice.total < SCAN_WITH_COVER_SHARE) {
      notices.push(notice.message);
      return;
    }
    left.add(notice.file);
    notices.push(
      `${quote(notice.file)} was not sent. It is a scan: ${notice.textless} of its ${notice.total} pages are pictures with no readable text${why}. Add photos of the pages you need instead.`,
    );
  };
  const scans: Part[] = [];
  let scannedPdfs = 0;
  let pagesLeft = MAX_SCANNED_PAGES;
  let bytesLeft = Math.min(MAX_SCANNED_PDF_BYTES, (attachmentBytes ?? Infinity) - content.totals.imageBytes);
  for (const notice of content.notices) {
    const partly = notice.type === "pages-without-text" && notice.mostly;
    const file =
      (notice.type === "file-skipped" && notice.reason === "no-text") || partly
        ? material.files.find((candidate) => candidate.name === notice.file)
        : undefined;
    if (file === undefined || file.kind !== "pdf" || provider.readsScannedPdfs !== true) {
      if (partly) cannotGoAsScan(notice, `, and ${provider.label} cannot read scanned pages`);
      else notices.push(notice.message);
      continue;
    }
    if (partly && (file.size > bytesLeft || pagesLeft <= 0 || scannedPdfs >= MAX_SCANNED_PDFS)) {
      cannotGoAsScan(notice, ", and it is too large to send as a scan");
      continue;
    }
    if (file.size > bytesLeft) {
      notices.push(
        `${quote(file.name)} was not sent. It is a scan (pages stored as pictures) and too large for ${provider.label} to read. Add photos of the pages instead.`,
      );
      continue;
    }
    if (pagesLeft <= 0 || scannedPdfs >= MAX_SCANNED_PDFS) {
      notices.push(
        `${quote(file.name)} was not sent. It is a scan, and one request can take ${MAX_SCANNED_PAGES} scanned pages at most.`,
      );
      continue;
    }
    const total = await countPages(file.path, signal ? { signal } : {});
    if (total === null) {
      notices.push(notice.message);
      continue;
    }
    if (total > pagesLeft && provider.readsPdfPageRanges !== true) {
      // The file would go whole: there is no telling this provider to stop at a page.
      if (partly) cannotGoAsScan(notice, `, and one request can take ${MAX_SCANNED_PAGES} scanned pages at most`);
      else {
        notices.push(
          `${quote(file.name)} was not sent. It is a scan with ${total} pages, and one request can take ${MAX_SCANNED_PAGES} scanned pages at most. Add photos of the pages you need instead.`,
        );
      }
      continue;
    }
    const sent = Math.min(total, pagesLeft);
    pagesLeft -= sent;
    bytesLeft -= file.size;
    scannedPdfs += 1;
    asScan.add(file.name);
    scans.push({ type: "file", path: file.path });
    if (sent < total) {
      notices.push(
        `Only the first ${sent} of ${total} pages of ${quote(file.name)} were sent. It is a scan, so ${provider.label} has to look at each page as a picture.`,
      );
    }
  }

  const parts: Part[] = [];
  let images = 0;
  let words = 0;
  let sentChars = 0;
  for (const part of content.parts) {
    if (part.type === "text") {
      // A file that goes as a scan goes whole: its few text pages are in it.
      if (asScan.has(part.name) || left.has(part.name)) continue;
      parts.push({ type: "text", text: part.text });
      words += part.text.split(/\s+/).length;
      sentChars += part.text.length;
    } else {
      for (const path of part.paths) parts.push({ type: "image", path });
      images += part.paths.length;
    }
  }
  parts.push(...scans);
  words += images * WORDS_PER_PHOTO + (MAX_SCANNED_PAGES - pagesLeft) * WORDS_PER_SCANNED_PAGE;

  let delivery: string | null = null;
  if (scannedPdfs > 0) {
    delivery =
      provider.readsPdfPageRanges === true
        ? "Scanned PDFs\n\n" +
          "Every PDF in the list of material files is a scan: its pages are pictures, with no text " +
          "layer. Read each one with your file-reading tool and look at the pages yourself. A PDF " +
          'with more than 10 pages has to be read with a page range ("1-20"). ' +
          `Read at most ${MAX_SCANNED_PAGES} pages of scanned PDFs in total, starting with the first ` +
          "page of the first one, and work from those pages; what lies beyond them was left out on purpose."
        : "Scanned PDFs\n\n" +
          "Every PDF that comes with the material — attached, or in the list of material files — " +
          "is a scan: its pages are pictures, with little or no text layer. Look at the pages " +
          "yourself and read what is on them, the way you read a photo. If you open files with a " +
          "file-reading tool, give it the file's path only and read the whole file at once: do " +
          "not ask for a page range, which needs extra software that is not installed here.";
  }

  const needsFolder = parts.some((part) => part.type !== "text");
  return {
    parts,
    ...(needsFolder ? { workingDirectory: material.filesDirectory } : {}),
    notices,
    complete: notices.length === 0,
    words,
    delivery,
    counts: {
      files: material.files.length,
      textChars: sentChars,
      images,
      scannedPdfs,
      notices: notices.length,
    },
  };
}

/** The sentence for a material nothing of which can be sent. `notices` say why, file by file. */
export function nothingReadableSentence(fileCount: number): string {
  return fileCount === 0
    ? "This material has no files yet. Add a PDF, a PowerPoint or photos of your notes first."
    : "Nothing in this material could be read, so nothing was sent to your AI. Add a file with text in it, or photos of the pages.";
}

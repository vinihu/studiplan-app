/**
 * The shapes the extraction module returns. Plain data only (no classes, no Buffers), so any of
 * it can cross the IPC bridge unchanged.
 */

export type TextFileKind = "pdf" | "pptx";

export type ExtractErrorCode =
  | "unreadable" // the file could not be opened (moved, deleted, in use)
  | "too-large" // over the input size cap, or an archive that unpacks to too much
  | "not-a-pdf" // the bytes are not a PDF at all
  | "not-a-pptx" // the bytes are not a PowerPoint archive at all
  | "encrypted" // password-protected
  | "corrupt" // looks like the right kind of file but cannot be parsed
  | "no-slides" // a valid archive with no slides in it
  | "no-text" // parsed fine, but there is no text in it (a scan, or picture-only slides)
  | "timeout" // took too long and nothing usable was read
  | "cancelled"; // the caller's AbortSignal fired

export interface ExtractError {
  code: ExtractErrorCode;
  /** A plain sentence for the student: no paths, no stack traces. */
  message: string;
}

/** One PDF page or one slide. */
export interface ExtractedSection {
  /** 1-based page or slide number, in presentation order. */
  number: number;
  /** Slides only: the text of the title placeholder. `null` for PDF pages and untitled slides. */
  title: string | null;
  /** The page's text, or the slide's text without its title. May be empty. */
  body: string;
  /** Slides only: the speaker notes. `null` when there are none. */
  notes: string | null;
  /** Slides only: true for a slide that is hidden in the presentation. It is still read. */
  hidden?: boolean;
}

export interface ExtractedDocument {
  kind: TextFileKind;
  unit: "page" | "slide";
  /** How many pages or slides the file has. */
  totalCount: number;
  /** The pages or slides that were read, in order. `sections.length <= totalCount`. */
  sections: ExtractedSection[];
  /**
   * Why reading stopped before the end, or `null` when the whole file was read.
   * "count-limit": more pages/slides than one file may have read. "text-limit": more text than
   * one file may yield. "time-limit": reading took too long.
   */
  stopped: "count-limit" | "text-limit" | "time-limit" | null;
  /**
   * How many of `sections` have no readable text: scanned pages, full-page pictures, slides
   * that hold only an image. A file where all of them are like that is not returned at all
   * (`no-text`).
   */
  textlessCount: number;
  /**
   * PDFs only: true when the text shows the leftovers of formulas whose characters the file
   * does not carry (lines of empty brackets and equation numbers). The formulas are not in
   * `text`.
   */
  formulasLost: boolean;
  /** Every section rendered as plain text with one `## Page N` / `## Slide N: Title` heading each. */
  text: string;
}

export type ExtractResult =
  | { ok: true; value: ExtractedDocument }
  | { ok: false; error: ExtractError };

/** A path on disk (already validated by the caller as inside the library) or the bytes themselves. */
export type ExtractInput = string | Uint8Array;

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Lower the time cap (tests). Values above `MAX_EXTRACT_MS` are clamped to it. */
  timeoutMs?: number;
}

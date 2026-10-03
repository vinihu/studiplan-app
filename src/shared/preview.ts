/**
 * Showing a material's own files in the window.
 *
 * The page never gets a path and never receives whole files over IPC. A PDF or a photo page is
 * loaded by URL instead, from a scheme only this app serves:
 *
 *   studiplan-file://library/<subject>/<material>/<file.pdf>
 *   studiplan-file://library/<subject>/<material>/<photo set>/<page-1.jpg>
 *
 * The names are the same ids the library calls use. The main process resolves them through the
 * library's path check and serves only what the library lists: PDFs and the JPEG pages of a
 * photo set. A .pptx is not served; its text is read with `library.extractText` instead.
 *
 * Pure: no Node, no Electron, no DOM.
 */
import type { LibraryErrorCode, MaterialRef } from "./library";

/** The URL scheme, without the colon. Use `PREVIEW_SCHEME + ":"` in a Content-Security-Policy. */
export const PREVIEW_SCHEME = "studiplan-file";

/** The one host the scheme has. Anything else is refused. */
export const PREVIEW_HOST = "library";

/**
 * The URL of a PDF (`previewUrl(ref, "chapter-3.pdf")`) or of one page of a photo set
 * (`previewUrl(ref, "notes-2026-10-02", "page-1.jpg")`), for an `<iframe src>` or `<img src>`.
 * `name` and `page` are the values from `MaterialFile.name` and `MaterialFile.pages`.
 */
export function previewUrl(ref: MaterialRef, name: string, page?: string): string {
  const segments = [ref.subject, ref.material, name];
  if (page !== undefined) segments.push(page);
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}/${segments.map(encodeURIComponent).join("/")}`;
}

/** What a preview URL names. */
export interface PreviewTarget {
  ref: MaterialRef;
  name: string;
  /** Present for a page of a photo set. */
  page?: string;
}

/**
 * Reads a preview URL back into names. Returns `null` for anything that is not exactly one:
 * another scheme or host, a port, a user name, a query, the wrong number of segments, an empty
 * segment, a segment that does not decode, or one that decodes to something with a path
 * separator or a control character in it.
 *
 * This only takes the URL apart. Whether the names are safe and inside the library is decided
 * by the main process, on the result.
 */
export function parsePreviewUrl(url: string): PreviewTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:`) return null;
  if (parsed.hostname !== PREVIEW_HOST || parsed.port !== "") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") return null;
  if (!parsed.pathname.startsWith("/")) return null;

  const raw = parsed.pathname.slice(1).split("/");
  if (raw.length !== 3 && raw.length !== 4) return null;

  const names: string[] = [];
  for (const segment of raw) {
    if (segment === "") return null;
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f\u007f]/.test(name)) return null;
    names.push(name);
  }

  const [subject, material, name, page] = names as [string, string, string, string | undefined];
  return { ref: { subject, material }, name, ...(page === undefined ? {} : { page }) };
}

/** The text of one PDF or .pptx of a material, read locally. */
export interface FileText {
  /** The file's name inside the material. */
  name: string;
  kind: "pdf" | "pptx";
  /** What the file is made of: PDF pages or slides. */
  unit: "page" | "slide";
  /** How many pages or slides the file has. */
  totalCount: number;
  /** How many of them are in `text`. Less than `totalCount` when `stopped` is set. */
  readCount: number;
  /**
   * Why reading stopped before the end, or `null` when the whole file was read:
   * more pages or slides than one file may have read, more text than one file may yield, or it
   * took too long.
   */
  stopped: "count-limit" | "text-limit" | "time-limit" | null;
  /**
   * How many of the `readCount` pages or slides have no readable text: scanned pages,
   * full-page pictures, slides that hold only an image. 0 for an ordinary file. A file in which
   * none has any text is not returned at all (code `no-text`); this is for the file that is
   * partly a scan — "105 of 106 pages have no readable text".
   */
  textlessCount?: number;
  /**
   * True for a PDF whose formulas did not come through as text (only empty brackets and
   * equation numbers are left of them): what is made from this text may miss the formulas.
   */
  formulasLost?: boolean;
  /**
   * Plain text, one `## Page N` or `## Slide N: Title` heading per page or slide, speaker notes
   * included. It comes out of the student's file: render it as text, never as HTML.
   */
  text: string;
}

export type FileTextErrorCode =
  | LibraryErrorCode
  | "encrypted" // password-protected
  | "damaged" // not really a PDF or a presentation, or it cannot be parsed
  | "no-text" // read fine, but there is no text in it: a scan, or picture-only slides
  | "timed-out"
  | "cancelled";

export interface FileTextError {
  code: FileTextErrorCode;
  /** A plain sentence that can be shown to the student. */
  message: string;
}

export type FileTextResult = { ok: true; value: FileText } | { ok: false; error: FileTextError };

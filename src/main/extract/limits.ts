/**
 * Every number the extraction module enforces, in one place.
 *
 * Two groups: what reading ONE file may cost (so a hostile or broken file cannot hang the app
 * or eat its memory), and what ONE AI request may carry (so a prompt is bounded whatever the
 * material holds).
 */

// ── Reading one file ────────────────────────────────────────────────────────────────────────

/** A file larger than this is not opened at all. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

/** Wall-clock time for one file. Past it, what was read so far is returned as incomplete. */
export const MAX_EXTRACT_MS = 30_000;

/** PDF pages read from one file. A longer PDF is reported as incomplete. */
export const MAX_PDF_PAGES = 2_000;

/** Slides read from one deck. */
export const MAX_SLIDES = 1_000;

/** Characters kept from one file. Reading stops at the first page or slide that passes it. */
export const MAX_EXTRACT_CHARS = 1_000_000;

/** Fewer real characters than this in a whole file means "no readable text" (a scan). */
export const NO_TEXT_THRESHOLD = 40;

/** Fewer real characters than this on one PDF page means the page has no readable text. */
export const PAGE_TEXT_THRESHOLD = 20;

/**
 * A PDF is "mostly a scan" when at least this share of its pages has no readable text. Such a
 * file is handed over as a scan where the AI can read one; its few text pages (a library's
 * notice in front of a scanned book) are not the material.
 */
export const MOSTLY_SCANNED_SHARE = 0.5;

/**
 * Below "mostly", pages without text are worth telling the student about only when there are
 * more than a few: a chapter with a full-page figure or a blank page stays quiet.
 */
export const TEXTLESS_NOTICE_MIN_PAGES = 3;
export const TEXTLESS_NOTICE_SHARE = 0.1;

/** A line is a running header or footer when it repeats on this share of the pages … */
export const REPEATED_LINE_SHARE = 0.4;
/** … and on at least this many, in a file of at least `REPEATED_LINE_MIN_PAGES` pages. */
export const REPEATED_LINE_MIN_COUNT = 4;
export const REPEATED_LINE_MIN_PAGES = 6;
/** Only the first and last lines of a page are looked at. */
export const EDGE_LINES = 2;

/**
 * Lines that are nothing but empty brackets and an equation number — what is left of a formula
 * whose characters the PDF does not carry. This many of them mean the formulas were lost.
 */
export const LOST_FORMULA_MIN_LINES = 10;

/** Entries a .pptx archive may list. A real deck has a few hundred at most. */
export const MAX_ZIP_ENTRIES = 10_000;

/** Unpacked size of one XML part that is read (a slide, its notes, a relationship list). */
export const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * Characters of text read from one PDF page. A real page has a few thousand; a page built to
 * be slow can have millions of text operations. Reading stops there, and the page keeps what
 * was read.
 */
export const MAX_PAGE_CHARS = 200_000;

/** Unpacked bytes read from one archive in total, counted as they come out, not as declared. */
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;

// ── One AI request ──────────────────────────────────────────────────────────────────────────

/**
 * Characters of extracted text in one request, across every PDF and deck of the material.
 *
 * 120,000 characters is roughly 30,000–40,000 tokens (about 4 characters per token in English,
 * nearer 3 in languages with long words). That fits every current hosted model with plenty of room left for the
 * instructions and the answer, stays under the per-minute token limits of free API tiers, and
 * is a prompt a CLI tool takes on stdin in one go. It is about 60 dense pages. A provider with
 * a small context window (a local Ollama model) should pass a lower `maxTextChars`.
 */
export const PROMPT_MAX_TEXT_CHARS = 120_000;

/**
 * Photographed pages in one request, across every photo set. 20 is the count hosted vision
 * APIs take without lowering the allowed resolution per image, and a handwritten page costs
 * roughly 1,000–1,500 tokens, so 20 pages stay a modest part of the request.
 */
export const PROMPT_MAX_IMAGES = 20;

/**
 * Raw bytes of those images together. Hosted APIs cap a request at about 32 MB and images are
 * sent base64-encoded (a third larger), so 20 MB raw stays under it.
 */
export const PROMPT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

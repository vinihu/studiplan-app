/**
 * How numbers, dates and file kinds are worded on screen. Pure functions, no DOM.
 */

import type { MaterialFile, MaterialFileKind } from "@shared/library";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** `1536` -> "2 KB", `2_500_000` -> "2.4 MB". Never shows bytes: a student does not need them. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < GB) return `${trimmed(bytes / MB)} MB`;
  return `${trimmed(bytes / GB)} GB`;
}

/** One decimal below 10, none from 10 up, and no trailing ".0". */
function trimmed(value: number): string {
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return String(rounded);
}

/** `count(1, "file")` -> "1 file", `count(3, "file")` -> "3 files", `count(0, "file")` -> "No files". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  if (n === 0) return `No ${plural}`;
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Like `count`, but for the middle of a sentence: "0 files", never "No files". */
export function countInline(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * An ISO timestamp as a date, "2 Oct 2026", in the computer's own time zone, or "" if it cannot
 * be read. One fixed format, written out here: what a system locale would pick differs between
 * computers ("Oct 2, 2026", "02.10.2026"), and a day-month order without the month's name can
 * be read two ways. Every date the app shows goes through this or `formatDateTime`.
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** The time of day on a 24-hour clock, "19:40", or "" if the timestamp cannot be read. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "2 Oct 2026, 19:40": for things made on the same day that need telling apart. */
export function formatDateTime(iso: string): string {
  const day = formatDate(iso);
  return day === "" ? "" : `${day}, ${formatTime(iso)}`;
}

/**
 * The dates of a list, one per item: the date alone, and with the time of day for the items
 * that share their date with another one.
 */
export function formatDatesApart(isos: readonly string[]): string[] {
  const days = isos.map(formatDate);
  return isos.map((iso, index) =>
    days[index] !== "" && days.filter((day) => day === days[index]).length > 1 ? formatDateTime(iso) : (days[index] ?? ""),
  );
}

const KIND_LABELS: Record<MaterialFileKind, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  "photo-set": "Photos",
};

export function kindLabel(kind: MaterialFileKind): string {
  return KIND_LABELS[kind];
}

/** Number of pages of a photo set; `null` for anything else. */
export function pageCount(file: MaterialFile): number | null {
  return file.kind === "photo-set" ? (file.pages?.length ?? 0) : null;
}

/** "PDF", "PowerPoint", or "Photos · 5 pages". */
export function describeFile(file: MaterialFile): string {
  const pages = pageCount(file);
  const what = pages === null ? kindLabel(file.kind) : `${kindLabel(file.kind)} · ${countInline(pages, "page")}`;
  // A photo set that was also turned into a PDF says so, so the two rows read as one thing.
  return file.pdf ? `${what} · also as a PDF` : what;
}

/** Under the name of a PDF that was made from a photo set: what it is, so it is not taken for more material. */
export function madeFromLine(file: MaterialFile): string | null {
  return file.madeFrom ? `PDF of ${file.madeFrom} · same pages as the photos` : null;
}

/** What the preview of such a PDF says in place of the note about scans. */
export const MADE_FROM_PHOTOS_NOTE =
  "The photos are what your AI reads; this PDF is for you to keep, share or print.";

/** Added to the confirmation when a photo set is removed while its PDF stays. */
export const PDF_STAYS_NOTE =
  "Its PDF stays. From then on it is read by your AI like any other file: a scan, which Claude Code and an AI used with an API key can read up to 20 pages of.";

/** What one add action brought in, as words: "2 files and 5 photos". "" when nothing was added. */
export function describeAdded(added: readonly MaterialFile[]): string {
  const documents = added.filter((file) => file.kind !== "photo-set").length;
  const photos = added.reduce((sum, file) => sum + (pageCount(file) ?? 0), 0);
  const parts: string[] = [];
  if (documents > 0) parts.push(countInline(documents, "file"));
  if (photos > 0) parts.push(countInline(photos, "photo"));
  return parts.join(" and ");
}

/**
 * What the system calls the place deleted things go: "Recycle Bin" on Windows, "Trash"
 * elsewhere. `null` while the platform is not known yet, and then nothing is promised.
 */
export function trashName(platform: string | null): string | null {
  if (platform === null) return null;
  return platform === "win32" ? "Recycle Bin" : "Trash";
}

/** "…will be moved to the Recycle Bin. You can restore it from there." */
function fate(trash: string | null, it: "it" | "them" = "it"): string {
  return trash === null
    ? "will be removed from your library."
    : `will be moved to the ${trash}. You can restore ${it} from there.`;
}

/** What deleting a subject takes with it. `files` is `null` when it is not known yet. */
export function subjectDeletion(
  materials: number,
  files: number | null,
  trash: string | null,
): string {
  if (materials === 0) return `This empty subject ${fate(trash)}`;
  const inside =
    files === null
      ? countInline(materials, "material")
      : `${countInline(materials, "material")} with ${countInline(files, "file")}`;
  return `This subject and everything in it (${inside}) ${fate(trash)}`;
}

/** What deleting a material takes with it. */
export function materialDeletion(
  material: { fileCount: number; setCount: number },
  trash: string | null,
): string {
  const inside: string[] = [];
  if (material.fileCount > 0) inside.push(countInline(material.fileCount, "file"));
  if (material.setCount > 0) inside.push(countInline(material.setCount, "result"));
  if (inside.length === 0) return `This empty material ${fate(trash)}`;
  return `This material and everything in it (${inside.join(" and ")}) ${fate(trash)}`;
}

/** What removing one file from a material does. The original on disk is never touched. */
export function fileRemoval(file: MaterialFile, trash: string | null): string {
  const pages = pageCount(file);
  if (pages === null) {
    return `The copy in this material ${fate(trash)} Your original file stays where it is.`;
  }
  if (pages === 1) {
    return `The photo in this material ${fate(trash)} Your original photo stays where it is.`;
  }
  return `The ${pages} photos in this material ${fate(trash, "them")} Your original photos stay where they are.`;
}

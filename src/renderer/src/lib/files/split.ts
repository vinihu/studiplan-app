/**
 * Sorting what the user dropped or picked into what a material can hold.
 *
 * From one action: PDFs and .pptx files are copied in as they are, every image together becomes
 * one photo set, and anything else is turned away with a sentence. Pure functions, no DOM.
 */

import type { RejectedFile } from "@shared/library";

export type PickedKind = "document" | "photo" | "unsupported";

/** The least this module needs to know about a file. A browser `File` fits. */
export interface PickedFile {
  name: string;
  /** MIME type as the system reports it. Often empty on Windows for less common types. */
  type: string;
  /** Its size in bytes, where known. A browser `File` knows. */
  size?: number;
}

const DOCUMENT_EXTENSIONS = new Set(["pdf", "pptx"]);
const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif"]);
/** Images that are drawings or icons, not photos of notes. */
const NOT_A_PHOTO_TYPES = new Set(["image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);

export const SUPPORTED_SENTENCE = "Studiplan takes PDFs, PowerPoint files (.pptx) and photos.";

/** Lower-case extension without the dot, or "" when the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function classify(file: PickedFile): PickedKind {
  const extension = extensionOf(file.name);
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (PHOTO_EXTENSIONS.has(extension)) return "photo";
  const type = file.type.toLowerCase();
  if (type.startsWith("image/") && !NOT_A_PHOTO_TYPES.has(type)) return "photo";
  return "unsupported";
}

/** Why a file of this name cannot be added, as a sentence for the user. */
export function unsupportedReason(name: string): string {
  const extension = extensionOf(name);
  if (extension === "ppt") {
    return "Old PowerPoint files (.ppt) cannot be added. Open it in PowerPoint, save it as .pptx and add that.";
  }
  if (extension === "doc" || extension === "docx") {
    return "Word files cannot be added. Save it as a PDF and add that.";
  }
  if (extension === "") return `This cannot be added. ${SUPPORTED_SENTENCE}`;
  return `.${extension} files cannot be added. ${SUPPORTED_SENTENCE}`;
}

export interface SplitFiles<F extends PickedFile> {
  /** PDFs and .pptx, in the order given. */
  documents: F[];
  /** Images, in the order given: the pages of one photo set. */
  photos: F[];
  unsupported: RejectedFile[];
}

export function splitFiles<F extends PickedFile>(files: readonly F[]): SplitFiles<F> {
  const result: SplitFiles<F> = { documents: [], photos: [], unsupported: [] };
  for (const file of files) {
    const kind = classify(file);
    if (kind === "document") result.documents.push(file);
    else if (kind === "photo") result.photos.push(file);
    else result.unsupported.push({ name: file.name, reason: unsupportedReason(file.name) });
  }
  return result;
}

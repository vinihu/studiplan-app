/**
 * One drop or pick, added to a material.
 *
 * Documents are copied by the main process from their paths. Photos are turned into JPEG pages
 * here and saved together as one photo set. Whatever fails is collected with its reason and
 * never hides what worked: the report always says both.
 *
 * Everything that touches the bridge or the DOM comes in through `AddDeps`, so the flow itself
 * can be tested without either.
 */

import type {
  AddFilesOutcome,
  LibraryResult,
  Material,
  MaterialFile,
  MaterialRef,
  RejectedFile,
} from "@shared/library";
import { MAX_PHOTO_FILE_BYTES, MAX_PHOTOS, PHOTO_FILE_TOO_LARGE_REASON, PhotoRefused, tooManyPhotosReason } from "./page-size";
import { splitFiles } from "./split";
import type { PickedFile } from "./split";

export interface AddDeps<F extends PickedFile> {
  /** Where the file is on the user's disk. "" when it has no place there. */
  pathFor(file: F): string;
  /**
   * One image -> upright, downscaled JPEG bytes. Throws when the image cannot be read, and a
   * `PhotoRefused` (whose message is shown) when it is too large to open.
   */
  toJpeg(file: F): Promise<Uint8Array>;
  addFiles(ref: MaterialRef, paths: string[]): Promise<LibraryResult<AddFilesOutcome>>;
  addPhotoSet(ref: MaterialRef, pages: Uint8Array[]): Promise<LibraryResult<AddFilesOutcome>>;
}

export type AddProgress =
  | { step: "photos"; done: number; total: number }
  | { step: "saving" };

export interface AddReport {
  /** The material after the last change that worked, or `null` if nothing was saved. */
  material: Material | null;
  added: MaterialFile[];
  /** Single files that were turned away, each with its reason. */
  rejected: RejectedFile[];
  /** Whole steps that failed (the disk said no, the material is gone), as sentences. */
  failures: string[];
  /** Files that were already in the material, so a second copy was saved under another name. */
  copies: SecondCopy[];
}

export interface SecondCopy {
  /** The name of the file that was picked. */
  original: string;
  /** The name its copy was saved under: the same with `-2`, `-3`, … before the ending. */
  savedAs: string;
}

/**
 * Which added files are second copies: saved as `name-2.pdf` because `name.pdf` was already
 * there. Told from the names alone: a saved name that is one of the picked names with a number
 * added, and that was not itself picked.
 */
export function findSecondCopies(pickedNames: readonly string[], added: readonly MaterialFile[]): SecondCopy[] {
  const picked = new Set(pickedNames.map((name) => name.toLowerCase()));
  const copies: SecondCopy[] = [];
  for (const file of added) {
    if (file.kind === "photo-set" || picked.has(file.name.toLowerCase())) continue;
    const match = /^(.*)-(\d+)(\.[^.]+)$/.exec(file.name);
    if (!match) continue;
    const original = pickedNames.find((name) => name.toLowerCase() === `${match[1]}${match[3]}`.toLowerCase());
    if (original !== undefined) copies.push({ original, savedAs: file.name });
  }
  return copies;
}

export const NO_PATH_REASON =
  "This file could not be found on your computer. Save it to a folder first, then add it from there.";
export const UNREADABLE_PHOTO_REASON =
  "This photo could not be read. Save it as a JPG or PNG and add it again.";

export async function addToMaterial<F extends PickedFile>(
  ref: MaterialRef,
  files: readonly F[],
  deps: AddDeps<F>,
  onProgress: (progress: AddProgress) => void = () => {},
): Promise<AddReport> {
  const { documents, photos, unsupported } = splitFiles(files);
  const report: AddReport = { material: null, added: [], rejected: [...unsupported], failures: [], copies: [] };

  const merge = (result: LibraryResult<AddFilesOutcome>) => {
    if (!result.ok) {
      report.failures.push(result.error.message);
      return;
    }
    report.material = result.value.material;
    report.added.push(...result.value.added);
    report.rejected.push(...result.value.rejected);
  };

  // Documents: only their paths cross the bridge; the main process copies the files.
  const paths: string[] = [];
  for (const file of documents) {
    const path = deps.pathFor(file);
    if (path) paths.push(path);
    else report.rejected.push({ name: file.name, reason: NO_PATH_REASON });
  }
  if (paths.length > 0) {
    onProgress({ step: "saving" });
    merge(await deps.addFiles(ref, paths));
    report.copies = findSecondCopies(
      documents.map((file) => file.name),
      report.added,
    );
  }

  // Photos: every image of this action, in the user's order, becomes one set.
  // More than a set can hold is said before a single one is opened: thousands of dropped
  // photos would otherwise all be decoded first, only for the library to refuse the set.
  if (photos.length > MAX_PHOTOS) {
    report.failures.push(tooManyPhotosReason(photos.length));
  } else if (photos.length > 0) {
    const pages: Uint8Array[] = [];
    onProgress({ step: "photos", done: 0, total: photos.length });
    // One at a time: each photo is decoded, drawn small and let go before the next is read.
    for (const [index, file] of photos.entries()) {
      if (file.size !== undefined && file.size > MAX_PHOTO_FILE_BYTES) {
        // Refused by its size on disk: the file is not read at all.
        report.rejected.push({ name: file.name, reason: PHOTO_FILE_TOO_LARGE_REASON });
      } else {
        try {
          pages.push(await deps.toJpeg(file));
        } catch (error) {
          const reason = error instanceof PhotoRefused ? error.message : UNREADABLE_PHOTO_REASON;
          report.rejected.push({ name: file.name, reason });
        }
      }
      onProgress({ step: "photos", done: index + 1, total: photos.length });
    }
    if (pages.length > 0) {
      onProgress({ step: "saving" });
      merge(await deps.addPhotoSet(ref, pages));
    }
  }

  return report;
}

/** True when the report has something the user needs to read. */
/** True when the report says something the student would not see by looking at the list. */
export function hasNotes(report: AddReport): boolean {
  return hasProblems(report) || report.copies.length > 0;
}

export function hasProblems(report: AddReport): boolean {
  return report.rejected.length > 0 || report.failures.length > 0;
}

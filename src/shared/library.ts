/**
 * The library as the renderer sees it.
 *
 * The renderer never sends or receives a path inside the library. A subject and a material are
 * addressed by their folder names (`id`), which the main process validates and resolves against
 * the library root. The only paths that cross the bridge are the source files the user picked
 * or dropped, which the main process copies in.
 */

/** Why a library call failed. `message` is a plain sentence that can be shown to the user. */
export type LibraryErrorCode =
  | "invalid-name" // empty, too long, or made only of characters a folder cannot have
  | "already-exists"
  | "not-found"
  | "unsupported-file"
  | "too-large"
  | "outside-library" // a path would have left the library root
  | "invalid-request" // the call's arguments were not what the contract says; a bug, not the user's fault
  | "io"; // the disk said no (permissions, file in use, disk full)

export interface LibraryError {
  code: LibraryErrorCode;
  message: string;
}

/** Every library call resolves to this instead of throwing, so the sentence survives the bridge. */
export type LibraryResult<T> = { ok: true; value: T } | { ok: false; error: LibraryError };

export interface LibraryInfo {
  /** Absolute path of the library root, for display only. */
  root: string;
  /** True while the library is at its default place, `Documents/Studiplan`. */
  isDefault: boolean;
  /**
   * True when the folder is set from outside the app (the `STUDIPLAN_LIBRARY_DIR` environment
   * variable). Settings cannot change it then: show the folder, disable the control. Always
   * false in a release build, which does not read the variable.
   */
  fixedByEnvironment: boolean;
  /**
   * Present when the folder saved in the settings file could not be used (it is gone, cannot be
   * written to, or is a place a library may not be) and the default place is shown instead: a
   * sentence saying so. The main process also shows it once in a message box.
   */
  notice?: string;
}

/** What `library.chooseRoot()` and `library.useDefaultRoot()` did. */
export interface ChooseRootOutcome {
  /** False when the picker was closed without a choice, or the library is already there. */
  changed: boolean;
  /** Where the library is after the call. */
  info: LibraryInfo;
  /**
   * When `changed`: where the library was before. Nothing was moved or copied; everything that
   * was there is still there, and the app now shows what is in the new folder. Otherwise `null`.
   */
  previousRoot: string | null;
  /** How many subjects (folders) the library has where it is now. */
  subjectCount: number;
}

/** Which folder `library.openFolder` opens. Left out: the library folder itself. */
export interface FolderTarget {
  subject: string;
  /** Left out: the subject's folder. */
  material?: string;
}

export interface Subject {
  /** Folder name. Also the name shown to the user. */
  id: string;
  materialCount: number;
}

/** Addresses one material: the subject's folder name and the material's folder name. */
export interface MaterialRef {
  subject: string;
  material: string;
}

export interface MaterialSummary {
  /** Folder name inside the subject. */
  id: string;
  subject: string;
  /** The title from `material.json`. It may contain characters the folder name cannot. */
  title: string;
  /** ISO 8601 timestamp from `material.json`. */
  created: string;
  fileCount: number;
  /** Number of results in `sets/`: the files the Results list shows. */
  setCount: number;
}

export type MaterialFileKind = "pdf" | "pptx" | "photo-set";

export interface MaterialFile {
  /** Name inside `files/`: a file name (`chapter-3.pdf`) or a photo set's folder name. */
  name: string;
  kind: MaterialFileKind;
  /** Bytes. For a photo set, the sum of its pages. */
  size: number;
  /** Photo sets only: the page file names in order (`page-1.jpg`, `page-2.jpg`, …). */
  pages?: string[];
  /**
   * A PDF that was made from a photo set of this material ("Turn into PDF"): the name of that
   * set. The PDF holds the same pages as the photos. While the set is there, the photos are
   * what an AI is sent and this PDF is not, so nothing goes twice. Absent for every other PDF,
   * and once the photo set has been removed (the PDF is then an ordinary scan).
   */
  madeFrom?: string;
  /** Photo sets only: the name of the PDF that was made from this set, while that PDF is there. */
  pdf?: string;
}

export interface Material extends MaterialSummary {
  /** In the order stored in `material.json`. */
  files: MaterialFile[];
}

export interface RejectedFile {
  /** The source file's name, for the message. */
  name: string;
  /** A plain sentence saying why it was not added. */
  reason: string;
}

export interface AddFilesOutcome {
  /** The material after the change. */
  material: Material;
  added: MaterialFile[];
  rejected: RejectedFile[];
}

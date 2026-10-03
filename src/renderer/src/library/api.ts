/**
 * The library calls, as the screens use them.
 *
 * Every call of `window.studiplan.library` already resolves to a `LibraryResult`. This wrapper
 * adds the one case the contract cannot cover: the call itself failing (the bridge is missing or
 * the main process threw). That becomes an ordinary `{ ok: false }` with a sentence, so a screen
 * has exactly one failure path to design for.
 */

import type { StudiplanApi } from "@shared/ipc";
import type { LibraryError } from "@shared/library";

type LibraryApi = StudiplanApi["library"];

const UNREACHABLE: LibraryError = {
  code: "io",
  message: "Studiplan could not reach your library. Close the app and open it again.",
};

function safe<Method extends keyof LibraryApi>(method: Method): LibraryApi[Method] {
  const call = async (...args: unknown[]): Promise<unknown> => {
    try {
      const target = window.studiplan.library[method] as (...a: unknown[]) => Promise<unknown>;
      return await target(...args);
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  };
  return call as LibraryApi[Method];
}

export const library: LibraryApi = {
  getInfo: safe("getInfo"),
  listSubjects: safe("listSubjects"),
  createSubject: safe("createSubject"),
  renameSubject: safe("renameSubject"),
  deleteSubject: safe("deleteSubject"),
  listMaterials: safe("listMaterials"),
  createMaterial: safe("createMaterial"),
  renameMaterial: safe("renameMaterial"),
  deleteMaterial: safe("deleteMaterial"),
  getMaterial: safe("getMaterial"),
  addFiles: safe("addFiles"),
  addPhotoSet: safe("addPhotoSet"),
  photoSetToPdf: safe("photoSetToPdf"),
  removeFile: safe("removeFile"),
  extractText: safe("extractText"),
  chooseRoot: safe("chooseRoot"),
  useDefaultRoot: safe("useDefaultRoot"),
  openFolder: safe("openFolder"),
};

/**
 * Where a dropped or picked file is on the user's disk. A `File` has no `.path` in a sandboxed
 * page; the preload asks Electron for it. "" when the file has no place on disk.
 */
export function pathFor(file: File): string {
  try {
    return window.studiplan.files.pathFor(file);
  } catch {
    return "";
  }
}

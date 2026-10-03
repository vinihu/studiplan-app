import path from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import type { IpcHandlers } from "@shared/ipc";
import type { ChooseRootOutcome, LibraryError, LibraryResult } from "@shared/library";
import type { FileTextResult } from "@shared/preview";
import { checkLibraryRoot } from "../library/choose-root";
import { fail, toResult } from "../library/errors";
import { describeError } from "../log-safe";
import { getContext } from "./context";
import { rootPlaces } from "./root-places";
import { getStudyService } from "./study";

/**
 * The `library` namespace of the bridge. The disk work is in `src/main/library`; this file adds
 * the calls that need Electron: the folder picker, the file manager, and where the system's
 * and the app's own folders are.
 */

const log = (error: unknown): void => console.error("[library]", describeError(error));

const BAD_REQUEST: LibraryError = {
  code: "invalid-request",
  message: "Studiplan could not understand that request. Try again.",
};

async function countSubjects(): Promise<number> {
  const subjects = await getContext().library.listSubjects();
  return subjects.ok ? subjects.value.length : 0;
}

/** Stores `next` (or the default, for `undefined`) and reports what changed. */
async function switchRoot(next: string | undefined): Promise<ChooseRootOutcome> {
  const { settings, libraryInfo } = getContext();
  const before = await libraryInfo();
  await settings.update({ libraryRoot: next });
  const info = await libraryInfo();
  const changed = path.relative(before.root, info.root) !== "";
  return { changed, info, previousRoot: changed ? before.root : null, subjectCount: await countSubjects() };
}

async function unchanged(): Promise<ChooseRootOutcome> {
  return { changed: false, info: await getContext().libraryInfo(), previousRoot: null, subjectCount: await countSubjects() };
}

async function refuseWhenFixed(): Promise<void> {
  if ((await getContext().libraryInfo()).fixedByEnvironment) {
    fail(
      "invalid-request",
      "The library folder is set from outside the app for this run (STUDIPLAN_LIBRARY_DIR), so it cannot be changed here.",
    );
  }
}

// One picker at a time: a second press while it is open waits for the first.
let choosing: Promise<unknown> = Promise.resolve();

function chooseRoot(): Promise<LibraryResult<ChooseRootOutcome>> {
  const result = choosing.then(() =>
    toResult(async () => {
      await refuseWhenFixed();
      const before = await getContext().libraryInfo();

      const options: Electron.OpenDialogOptions = {
        title: "Choose the library folder",
        buttonLabel: "Use this folder",
        defaultPath: before.root,
        properties: ["openDirectory", "createDirectory"],
      };
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const candidate = picked.canceled ? undefined : picked.filePaths[0];
      if (candidate === undefined) return unchanged();

      const root = await checkLibraryRoot(candidate, rootPlaces());
      return switchRoot(root);
    }, log),
  );
  choosing = result;
  return result;
}

function useDefaultRoot(): Promise<LibraryResult<ChooseRootOutcome>> {
  return toResult(async () => {
    await refuseWhenFixed();
    return switchRoot(undefined);
  }, log);
}

async function openFolder(target: unknown): Promise<LibraryResult<null>> {
  // Through the same path check as everything else: only the library folder, a subject's or
  // a material's folder can be opened, never a path from the page.
  const located = await getContext().library.locateFolder(target);
  if (!located.ok) return located;
  return toResult(async () => {
    const problem = await shell.openPath(located.value);
    if (problem !== "") {
      log(problem);
      fail("io", "The folder could not be opened. It may have been moved or deleted.");
    }
    return null;
  }, log);
}

function extractText(ref: unknown, name: unknown, requestId: unknown): Promise<FileTextResult> {
  const { text, tasks } = getContext();
  if (requestId === undefined || requestId === null) return text.read(ref, name);
  return tasks.run(
    requestId,
    (signal) => text.read(ref, name, signal),
    () => ({ ok: false, error: BAD_REQUEST }),
  );
}

const BUSY_MAKING: LibraryError = {
  code: "io",
  message:
    "Studiplan is making something from this material right now. Wait until it is finished, or cancel it, then rename.",
};

/**
 * What is being made from a material stops before the material, its subject or one of its
 * files goes: the AI's process is ended and nothing is written afterwards. A rename is refused
 * instead, since it would only make the finished result homeless.
 */
async function afterCancelling<T>(target: unknown, operation: () => Promise<T>): Promise<T> {
  await getStudyService().cancelFor(target);
  return operation();
}

function unlessMaking<T>(target: unknown, operation: () => Promise<LibraryResult<T>>): Promise<LibraryResult<T>> {
  if (getStudyService().isMakingFrom(target)) return Promise.resolve({ ok: false, error: BUSY_MAKING });
  return operation();
}

export const libraryHandlers: IpcHandlers["library"] = {
  getInfo: () => getContext().library.getInfo(),
  listSubjects: () => getContext().library.listSubjects(),
  createSubject: (name) => getContext().library.createSubject(name),
  renameSubject: (subject, newName) => unlessMaking({ subject }, () => getContext().library.renameSubject(subject, newName)),
  deleteSubject: (subject) => afterCancelling({ subject }, () => getContext().library.deleteSubject(subject)),
  listMaterials: (subject) => getContext().library.listMaterials(subject),
  createMaterial: (subject, title) => getContext().library.createMaterial(subject, title),
  renameMaterial: (ref, title) => unlessMaking(ref, () => getContext().library.renameMaterial(ref, title)),
  deleteMaterial: (ref) => afterCancelling(ref, () => getContext().library.deleteMaterial(ref)),
  getMaterial: (ref) => getContext().library.getMaterial(ref),
  addFiles: (ref, paths) => getContext().library.addFiles(ref, paths),
  addPhotoSet: (ref, pages) => getContext().library.addPhotoSet(ref, pages),
  photoSetToPdf: (ref, name) => getContext().library.photoSetToPdf(ref, name),
  removeFile: (ref, name) => afterCancelling(ref, () => getContext().library.removeFile(ref, name)),
  extractText: (ref, name, requestId) => extractText(ref, name, requestId),
  // No arguments are taken from the page: the folder comes from the system's own picker.
  chooseRoot: () => chooseRoot(),
  useDefaultRoot: () => useDefaultRoot(),
  openFolder: (target) => openFolder(target),
};

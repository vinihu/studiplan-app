/**
 * The library on disk:
 *
 *   <root>/<subject>/<material>/material.json   { title, created, files: [names in order] }
 *   <root>/<subject>/<material>/files/          PDFs, .pptx files, photo-set folders
 *   <root>/<subject>/<material>/sets/           results made from the material
 *
 * This module does not import Electron, so it runs in tests against a temporary folder.
 * Whatever needs Electron (where the root is, how to move something to the recycle bin) is
 * passed in.
 *
 * The folders are the truth. A student may rename, add and delete things in Explorer, so
 * every read looks at what is really there and treats `material.json` as a hint: a missing
 * or broken one is replaced by defaults taken from the folder, names it lists that are gone
 * are dropped, and files it does not know are appended. It is rewritten the next time the
 * material changes; reading never writes.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IpcHandlers } from "@shared/ipc";
import { describeError } from "../log-safe";
import type {
  AddFilesOutcome,
  FolderTarget,
  LibraryInfo,
  LibraryResult,
  Material,
  MaterialFile,
  MaterialFileKind,
  MaterialRef,
  MaterialSummary,
  RejectedFile,
  Subject,
} from "@shared/library";
import { listStudySetFiles, parseStudySetFileName } from "@shared/study";
import { MAX_INPUT_BYTES } from "../extract/limits";
import { fail, isErrno, LibraryFailure, toResult } from "./errors";
import {
  cleanTitle,
  compareNames,
  firstFreeName,
  folderNameFromTitle,
  isHiddenName,
  isLocalFilePath,
  isReservedDeviceName,
  isSafeSegment,
  MAX_FILE_NAME,
  MAX_FOLDER_NAME,
  MAX_PATH_LENGTH,
  MAX_SOURCE_PATH,
  MAX_TITLE,
  MAX_TYPED_NAME,
  nameKey,
  sanitiseName,
  storedFileName,
} from "./names";
import { OUTSIDE, resolveInside } from "./paths";
import { pdfOverheadBytes, PhotoPdfFailure, writePhotoPdf } from "./photo-pdf";
import { EXTENSION, isJpeg, kindFromName, matchesSignature, readHead } from "./signatures";

/**
 * The most one PDF or .pptx may weigh. The same number as the most the text reader opens, so a
 * file the library takes is never one the app then cannot read.
 */
export const MAX_FILE_BYTES = MAX_INPUT_BYTES;
/** The most files one `addFiles` call takes. */
export const MAX_FILES_PER_CALL = 200;
/** The most pages in one photo set. */
export const MAX_PHOTO_PAGES = 100;
/** The most one page may weigh. The renderer downscales first, so real pages are far smaller. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const META_FILE = "material.json";
const FILES_DIR = "files";
const SETS_DIR = "sets";
const MAX_META_BYTES = 256 * 1024;
const MAX_META_ENTRIES = 5000;

export interface LibraryDeps {
  /** Where the library is right now. Asked on every call, so a change in Settings takes effect at once. */
  root: () => Promise<LibraryInfo> | LibraryInfo;
  /** Removes a file or folder in a way the user can undo (the system recycle bin). */
  trash: (absolutePath: string) => Promise<void>;
  /** What the user's system calls the place deleted things go. Used in sentences. */
  trashName?: string;
  /** Receives the real error behind every `io` result. */
  log?: (error: unknown) => void;
  now?: () => Date;
}

/**
 * Calls of the `library` namespace that need Electron (a dialog, the file manager) or another
 * module (text extraction). They are put together in `src/main/ipc/library.ts`.
 */
type OutsideMethod = "extractText" | "chooseRoot" | "useDefaultRoot" | "openFolder";

/** The `library` namespace of the bridge, as far as it is plain disk work. Every call resolves; none rejects. */
export type Library = {
  readonly [Method in Exclude<keyof IpcHandlers["library"], OutsideMethod>]: (
    ...args: Parameters<IpcHandlers["library"][Method]>
  ) => Promise<Awaited<ReturnType<IpcHandlers["library"][Method]>>>;
};

/** A file of a material that may be shown or read, found through the path check. */
export interface LocatedFile {
  /** Absolute path. For the main process only; it never crosses the bridge. */
  path: string;
  kind: "pdf" | "pptx" | "photo-page";
  size: number;
  mtimeMs: number;
}

/**
 * What the rest of the main process may ask the library for. Not part of the bridge: these
 * return paths. They do not wait in the queue of library operations (they only look), so a
 * preview is never held up by a long copy.
 */
export interface LibraryLookup {
  /**
   * One document of a material (`page` left out), or one page of a photo set. Only what a
   * list would show is found: a real PDF or .pptx file, or a real `.jpg` inside a real
   * photo-set folder. Hidden names, links and everything else are not.
   */
  locateFile(ref: unknown, name: unknown, page?: unknown): Promise<LibraryResult<LocatedFile>>;
  /** The library folder (`target` left out), a subject's folder or a material's folder. */
  locateFolder(target?: unknown): Promise<LibraryResult<string>>;
  /** A material's title and every file it lists, with paths, for one AI request. */
  locateMaterial(ref: unknown): Promise<LibraryResult<LocatedMaterial>>;

  // Results (`sets/`). The library knows a result only as a file whose name is a result's name
  // (`YYYY-MM-DD-kind.ext`); what is inside is the business of `src/main/study`.

  /** The result files of a material that really are files, in no particular order. */
  listSetFiles(ref: unknown): Promise<LibraryResult<SetFileInfo[]>>;
  /** The text of one result file. Refused when it is larger than `maxBytes`. */
  readSetFile(ref: unknown, name: unknown, maxBytes: number): Promise<LibraryResult<SetFileText>>;
  /**
   * Writes a new result file, whole or not at all (a hidden temporary file, then a rename).
   * `choose` gets every name already in `sets/` and returns the new file's name and text, or
   * `null` to write nothing (the request was cancelled meanwhile); the result is then `null`.
   * An existing file is never replaced.
   */
  saveSetFile(
    ref: unknown,
    choose: (existingNames: string[]) => { name: string; text: string } | null,
    /**
     * `LocatedMaterial.identity` from when the material was read. When the folder is no longer
     * that one — deleted and made again under the same name — nothing is written and the result
     * is `not-found`.
     */
    identity?: string,
  ): Promise<LibraryResult<SetFileInfo | null>>;
  /** Replaces one result file's text with `edit(text)`, whole or not at all. */
  rewriteSetFile(
    ref: unknown,
    name: unknown,
    edit: (text: string) => string,
    maxBytes: number,
  ): Promise<LibraryResult<SetFileInfo>>;
  /** Moves one result file to the recycle bin. */
  deleteSetFile(ref: unknown, name: unknown): Promise<LibraryResult<null>>;
}

/** One file of a material with where it is. For the main process only. */
export type LocatedMaterialFile =
  | {
      name: string;
      kind: "pdf" | "pptx";
      path: string;
      size: number;
      /** A PDF made from a photo set that is still in the material: the set's name. */
      madeFrom?: string;
    }
  | { name: string; kind: "photo-set"; pagePaths: string[]; size: number };

export interface LocatedMaterial {
  /** The folder name. */
  id: string;
  /** The title from `material.json`. */
  title: string;
  /** Which folder this is, beyond its name: a folder made again under the same name has another. */
  identity: string;
  /** Absolute path of the material's `files/` folder: every path below lies inside it. */
  filesDirectory: string;
  /** In the material's order. */
  files: LocatedMaterialFile[];
}

export interface SetFileInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface SetFileText extends SetFileInfo {
  text: string;
}

/** The most result files of one material that are listed. */
export const MAX_SET_FILES = 500;

export type LibraryService = Library & LibraryLookup;

interface Meta {
  title: string;
  created: string;
  files: string[];
  /**
   * Which PDF was made from which photo set: PDF name → set name. A hint like everything in
   * `material.json`: a pair counts only while both are really there (see `liveLinks`).
   */
  madeFrom?: Record<string, string>;
}

/** The pairs of `madeFrom` whose PDF and photo set are both among `entries`. */
function liveLinks(madeFrom: Record<string, string> | undefined, entries: readonly FileEntry[]): Map<string, string> {
  const live = new Map<string, string>();
  if (madeFrom === undefined) return live;
  const kinds = new Map(entries.map((entry) => [entry.name, entry.kind]));
  const taken = new Set<string>();
  for (const [pdf, set] of Object.entries(madeFrom)) {
    // One PDF per set: a second claim on the same set (a file edited by hand) is not believed.
    if (kinds.get(pdf) !== "pdf" || kinds.get(set) !== "photo-set" || taken.has(set)) continue;
    taken.add(set);
    live.set(pdf, set);
  }
  return live;
}

interface FileEntry {
  name: string;
  kind: MaterialFileKind;
}

const pad = (value: number): string => String(value).padStart(2, "0");

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Notepad and some editors put a byte-order mark in front of the JSON. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function badRequest(): never {
  fail("invalid-request", "Studiplan could not understand that request. Try again.");
}

function isListable(entry: Dirent): boolean {
  return !isHiddenName(entry.name) && isSafeSegment(entry.name);
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT", "ENOTDIR")) return [];
    throw error;
  }
}

/** `lstat`, or null if nothing is there. Links are reported as links, never followed. */
async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT", "ENOTDIR")) return null;
    throw error;
  }
}

async function isRealDirectory(target: string): Promise<boolean> {
  return (await lstatOrNull(target))?.isDirectory() ?? false;
}

function tempName(prefix: string, suffix = ""): string {
  return `${prefix}${randomBytes(6).toString("hex")}${suffix}`;
}

export function createLibrary(deps: LibraryDeps): LibraryService {
  // The kind of error, never its message or its path: those name the user's files.
  const log = deps.log ?? ((error: unknown) => console.error("[library]", describeError(error)));
  const now = deps.now ?? (() => new Date());
  const trashName = deps.trashName ?? "Recycle Bin";

  // One operation at a time: two calls can never interleave their reads and writes.
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(operation: () => Promise<T>) {
    const result = queue.then(() => toResult(operation, log));
    queue = result;
    return result;
  }

  async function openRoot(): Promise<string> {
    const { root } = await deps.root();
    await mkdir(root, { recursive: true });
    return root;
  }

  // ── Resolving ids ──────────────────────────────────────────────────────────────────────

  function checkId(id: unknown, missing: string): asserts id is string {
    if (typeof id !== "string") badRequest();
    if (!isSafeSegment(id)) fail("outside-library", OUTSIDE);
    // A hidden or system name is never offered by a list, so it is never a valid id.
    if (isHiddenName(id)) fail("not-found", missing);
  }

  const SUBJECT_GONE = "That subject is no longer there. It may have been renamed or deleted outside Studiplan.";
  const MATERIAL_GONE = "That material is no longer there. It may have been renamed or deleted outside Studiplan.";
  const FILE_GONE = "That file is no longer there. It may have been renamed or deleted outside Studiplan.";

  async function subjectDir(root: string, subject: unknown): Promise<string> {
    checkId(subject, SUBJECT_GONE);
    const dir = await resolveInside(root, subject);
    if (!(await isRealDirectory(dir))) fail("not-found", SUBJECT_GONE);
    return dir;
  }

  function checkRef(ref: unknown): asserts ref is MaterialRef {
    if (typeof ref !== "object" || ref === null) badRequest();
    const { subject, material } = ref as Record<string, unknown>;
    checkId(subject, SUBJECT_GONE);
    checkId(material, MATERIAL_GONE);
  }

  async function materialDir(root: string, ref: unknown): Promise<string> {
    checkRef(ref);
    await subjectDir(root, ref.subject);
    const dir = await resolveInside(root, ref.subject, ref.material);
    if (!(await isRealDirectory(dir))) fail("not-found", MATERIAL_GONE);
    return dir;
  }

  /** `files/` or `sets/` of a material, created if a student deleted it by hand. */
  async function innerDir(root: string, ref: MaterialRef, name: string, create: boolean): Promise<string> {
    const dir = await resolveInside(root, ref.subject, ref.material, name);
    if (create) {
      await mkdir(dir, { recursive: true });
      // mkdir is content with a link that is already there; a link is not a folder of ours.
      if (!(await isRealDirectory(dir))) fail("outside-library", OUTSIDE);
    }
    return dir;
  }

  // ── material.json ──────────────────────────────────────────────────────────────────────

  /** Reads `material.json` as untrusted text. Anything unusable in it is replaced by a default. */
  async function readMeta(root: string, ref: MaterialRef, dir: string): Promise<Meta> {
    let raw: unknown = null;
    try {
      const file = await resolveInside(root, ref.subject, ref.material, META_FILE);
      const info = await lstatOrNull(file);
      if (info?.isFile() && info.size <= MAX_META_BYTES) {
        raw = JSON.parse(stripBom(await readFile(file, "utf8")));
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof LibraryFailure)) log(error);
    }
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

    const title = typeof record["title"] === "string" ? cleanTitle(record["title"]).slice(0, MAX_TITLE) : "";

    let created: string;
    if (typeof record["created"] === "string" && !Number.isNaN(Date.parse(record["created"]))) {
      created = new Date(record["created"]).toISOString();
    } else {
      const info = await stat(dir);
      created = (info.birthtimeMs > 0 ? info.birthtime : info.mtime).toISOString();
    }

    // Names, never paths: anything that is not one clean segment is dropped here, and each
    // name is only ever used to put entries of `files/` in order.
    const files = Array.isArray(record["files"])
      ? record["files"].slice(0, MAX_META_ENTRIES).filter((name): name is string => isSafeSegment(name))
      : [];

    // Names again, and only pairs of them; whether they exist is checked where they are used.
    const madeFrom: Record<string, string> = {};
    const links = record["madeFrom"];
    if (typeof links === "object" && links !== null && !Array.isArray(links)) {
      for (const [pdf, set] of Object.entries(links).slice(0, MAX_META_ENTRIES)) {
        if (isSafeSegment(pdf) && isSafeSegment(set) && kindFromName(pdf) === "pdf") madeFrom[pdf] = set;
      }
    }

    return { title: title === "" ? ref.material : title, created, files, madeFrom };
  }

  async function writeMeta(root: string, ref: MaterialRef, input: Meta): Promise<void> {
    // A link is written only between two names of the list that is written with it: removing
    // a photo set, or its PDF, drops the link in the same step.
    const listed = new Set(input.files);
    const links = Object.entries(input.madeFrom ?? {}).filter(([pdf, set]) => listed.has(pdf) && listed.has(set));
    const meta: Meta = { title: input.title, created: input.created, files: input.files };
    if (links.length > 0) meta.madeFrom = Object.fromEntries(links);
    const file = await resolveInside(root, ref.subject, ref.material, META_FILE);
    const temp = await resolveInside(root, ref.subject, ref.material, tempName(".material-", ".tmp"));
    try {
      await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────

  /** What is really in `files/`, in the order of `material.json`, then the rest by name. */
  async function listFileEntries(root: string, ref: MaterialRef, order: string[]): Promise<FileEntry[]> {
    const dir = await innerDir(root, ref, FILES_DIR, false);
    const found = new Map<string, FileEntry>();
    for (const entry of await readEntries(dir)) {
      if (!isListable(entry)) continue;
      if (entry.isDirectory()) found.set(nameKey(entry.name), { name: entry.name, kind: "photo-set" });
      else if (entry.isFile()) {
        const kind = kindFromName(entry.name);
        if (kind) found.set(nameKey(entry.name), { name: entry.name, kind });
      }
    }

    const ordered: FileEntry[] = [];
    for (const name of order) {
      const entry = found.get(nameKey(name));
      if (entry && found.delete(nameKey(name))) ordered.push(entry);
    }
    const rest = [...found.values()].sort((a, b) => compareNames(a.name, b.name));
    return [...ordered, ...rest];
  }

  async function countSets(root: string, ref: MaterialRef): Promise<number> {
    const dir = await innerDir(root, ref, SETS_DIR, false);
    // Only what the Results list shows: real files with a result's name. Anything else a
    // student keeps in the folder is not counted.
    return Math.min(listStudySetFiles(await setFileNames(dir)).length, MAX_SET_FILES);
  }

  async function setFileNames(dir: string): Promise<string[]> {
    return (await readEntries(dir)).filter((entry) => entry.isFile() && isListable(entry)).map((entry) => entry.name);
  }

  async function describeFile(root: string, ref: MaterialRef, entry: FileEntry): Promise<MaterialFile> {
    const target = await resolveInside(root, ref.subject, ref.material, FILES_DIR, entry.name);
    if (entry.kind !== "photo-set") {
      return { name: entry.name, kind: entry.kind, size: (await lstat(target)).size };
    }
    const pages = (await readEntries(target))
      .filter((page) => page.isFile() && isListable(page) && /\.jpe?g$/i.test(page.name))
      .map((page) => page.name)
      .sort(compareNames);
    let size = 0;
    for (const page of pages) {
      size += (await lstat(await resolveInside(root, ref.subject, ref.material, FILES_DIR, entry.name, page))).size;
    }
    return { name: entry.name, kind: "photo-set", size, pages };
  }

  async function summarise(root: string, ref: MaterialRef): Promise<{ summary: MaterialSummary; entries: FileEntry[]; meta: Meta }> {
    const dir = await resolveInside(root, ref.subject, ref.material);
    const meta = await readMeta(root, ref, dir);
    const entries = await listFileEntries(root, ref, meta.files);
    const summary: MaterialSummary = {
      id: ref.material,
      subject: ref.subject,
      title: meta.title,
      created: meta.created,
      fileCount: entries.length,
      setCount: await countSets(root, ref),
    };
    return { summary, entries, meta };
  }

  async function loadMaterial(root: string, ref: MaterialRef): Promise<Material> {
    const { summary, entries, meta } = await summarise(root, ref);
    const links = liveLinks(meta.madeFrom, entries);
    const pdfOf = new Map([...links].map(([pdf, set]) => [set, pdf]));
    const files: MaterialFile[] = [];
    for (const entry of entries) {
      try {
        const file = await describeFile(root, ref, entry);
        const madeFrom = links.get(entry.name);
        const pdf = pdfOf.get(entry.name);
        if (madeFrom !== undefined) file.madeFrom = madeFrom;
        if (pdf !== undefined) file.pdf = pdf;
        files.push(file);
      } catch (error) {
        // One entry that cannot be read (a link, a file that vanished) does not hide the rest.
        if (!(error instanceof LibraryFailure) && !isErrno(error, "ENOENT")) log(error);
      }
    }
    return { ...summary, fileCount: files.length, files };
  }

  async function subjectFolders(root: string): Promise<string[]> {
    return (await readEntries(root))
      .filter((entry) => entry.isDirectory() && isListable(entry))
      .map((entry) => entry.name)
      .sort(compareNames);
  }

  async function materialFolders(dir: string): Promise<string[]> {
    return (await readEntries(dir))
      .filter((entry) => entry.isDirectory() && isListable(entry))
      .map((entry) => entry.name);
  }

  /** The keys of everything in a folder, whatever it is: a new name must not collide with any of it. */
  async function takenKeys(dir: string): Promise<Set<string>> {
    return new Set((await readEntries(dir)).map((entry) => nameKey(entry.name)));
  }

  // ── Names typed by the user ────────────────────────────────────────────────────────────

  function subjectName(input: unknown): string {
    if (typeof input !== "string") badRequest();
    // Before anything looks at the text: tidying a name takes time that grows with its length,
    // and nobody types one this long.
    if (input.length > MAX_TYPED_NAME) fail("invalid-name", `That name is too long. Use ${MAX_FOLDER_NAME} characters or fewer.`);
    const name = sanitiseName(input);
    if (name === "") {
      fail("invalid-name", "Type a name for the subject. It needs at least one letter or number.");
    }
    if (name.length > MAX_FOLDER_NAME) {
      fail("invalid-name", `That name is too long. Use ${MAX_FOLDER_NAME} characters or fewer.`);
    }
    if (isReservedDeviceName(name) || isHiddenName(name)) {
      fail("invalid-name", `"${name}" is a name the system keeps for itself. Pick a different name.`);
    }
    return name;
  }

  function materialTitle(input: unknown): { title: string; folder: string } {
    if (typeof input !== "string") badRequest();
    if (input.length > 4 * MAX_TITLE) fail("invalid-name", `That title is too long. Use ${MAX_TITLE} characters or fewer.`);
    const title = cleanTitle(input);
    if (title === "") fail("invalid-name", "Type a title for the material.");
    if (title.length > MAX_TITLE) {
      fail("invalid-name", `That title is too long. Use ${MAX_TITLE} characters or fewer.`);
    }
    // The same answer as for a subject: a name the system keeps for itself is refused, not
    // quietly stored under another one.
    const plain = sanitiseName(title);
    if (plain !== "" && isReservedDeviceName(plain)) {
      fail("invalid-name", `"${plain}" is a name the system keeps for itself. Pick a different title.`);
    }
    let folder = folderNameFromTitle(title);
    if (folder === "") fail("invalid-name", "The title needs at least one letter or number.");
    if (isHiddenName(folder)) folder = `_${folder}`;
    return { title, folder };
  }

  function checkPathLength(target: string): void {
    if (target.length > MAX_PATH_LENGTH) {
      fail(
        "invalid-name",
        "That name is too long for where your library is kept. Use a shorter name, or move the library to a folder with a shorter path.",
      );
    }
  }

  // ── Subjects ───────────────────────────────────────────────────────────────────────────

  async function listSubjects(): Promise<Subject[]> {
    const root = await openRoot();
    const subjects: Subject[] = [];
    for (const id of await subjectFolders(root)) {
      let materialCount = 0;
      try {
        materialCount = (await materialFolders(await resolveInside(root, id))).length;
      } catch (error) {
        log(error);
      }
      subjects.push({ id, materialCount });
    }
    return subjects;
  }

  async function createSubject(input: unknown): Promise<Subject> {
    const root = await openRoot();
    const name = subjectName(input);
    if ((await takenKeys(root)).has(nameKey(name))) {
      fail("already-exists", `A subject called "${name}" already exists. Pick a different name.`);
    }
    const dir = await resolveInside(root, name);
    checkPathLength(dir);
    await mkdir(dir);
    return { id: name, materialCount: 0 };
  }

  async function renameSubject(subject: unknown, input: unknown): Promise<Subject> {
    const root = await openRoot();
    const from = await subjectDir(root, subject);
    const name = subjectName(input);
    if (name !== subject) {
      const taken = await takenKeys(root);
      // Changing only the capitals of a name is a rename of the same folder, not a collision.
      if (nameKey(name) !== nameKey(subject as string) && taken.has(nameKey(name))) {
        fail("already-exists", `A subject called "${name}" already exists. Pick a different name.`);
      }
      const to = await resolveInside(root, name);
      checkPathLength(to);
      await rename(from, to);
    }
    return { id: name, materialCount: (await materialFolders(await resolveInside(root, name))).length };
  }

  async function moveToTrash(target: string, what: string): Promise<void> {
    try {
      await deps.trash(target);
    } catch (error) {
      log(error);
      fail(
        "io",
        `${what} could not be moved to the ${trashName}. Close any program that has it open and try again.`,
      );
    }
  }

  async function deleteSubject(subject: unknown): Promise<null> {
    const root = await openRoot();
    await moveToTrash(await subjectDir(root, subject), "The subject");
    return null;
  }

  // ── Materials ──────────────────────────────────────────────────────────────────────────

  async function listMaterials(subject: unknown): Promise<MaterialSummary[]> {
    const root = await openRoot();
    const dir = await subjectDir(root, subject);
    const summaries: MaterialSummary[] = [];
    for (const material of await materialFolders(dir)) {
      try {
        summaries.push((await summarise(root, { subject: subject as string, material })).summary);
      } catch (error) {
        // One odd folder must not take the whole list down.
        log(error);
      }
    }
    return summaries.sort((a, b) => compareNames(a.title, b.title) || compareNames(a.id, b.id));
  }

  async function createMaterial(subject: unknown, input: unknown): Promise<MaterialSummary> {
    const root = await openRoot();
    const parent = await subjectDir(root, subject);
    const { title, folder } = materialTitle(input);
    if ((await takenKeys(parent)).has(nameKey(folder))) {
      fail("already-exists", `A material called "${folder}" already exists in this subject. Pick a different title.`);
    }
    const ref: MaterialRef = { subject: subject as string, material: folder };
    const dir = await resolveInside(root, ref.subject, ref.material);
    checkPathLength(dir);
    await mkdir(dir);
    try {
      await innerDir(root, ref, FILES_DIR, true);
      await innerDir(root, ref, SETS_DIR, true);
      await writeMeta(root, ref, { title, created: now().toISOString(), files: [] });
    } catch (error) {
      // Nothing of the user's is in a folder made a moment ago: take it away again.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return (await summarise(root, ref)).summary;
  }

  async function renameMaterial(input: unknown, titleInput: unknown): Promise<MaterialSummary> {
    const root = await openRoot();
    const from = await materialDir(root, input);
    const ref = input as MaterialRef;
    const { title, folder } = materialTitle(titleInput);
    const { meta, entries } = await summarise(root, ref);
    const next: Meta = { ...meta, title, files: entries.map((entry) => entry.name) };

    if (folder === ref.material) {
      await writeMeta(root, ref, next);
      return (await summarise(root, ref)).summary;
    }

    const parent = await resolveInside(root, ref.subject);
    if (nameKey(folder) !== nameKey(ref.material) && (await takenKeys(parent)).has(nameKey(folder))) {
      fail("already-exists", `A material called "${folder}" already exists in this subject. Pick a different title.`);
    }
    const renamed: MaterialRef = { subject: ref.subject, material: folder };
    const to = await resolveInside(root, renamed.subject, renamed.material);
    checkPathLength(to);
    await rename(from, to);
    try {
      await writeMeta(root, renamed, next);
    } catch (error) {
      // Folder and title change together or not at all.
      await rename(to, from).catch(log);
      throw error;
    }
    return (await summarise(root, renamed)).summary;
  }

  async function deleteMaterial(ref: unknown): Promise<null> {
    const root = await openRoot();
    await moveToTrash(await materialDir(root, ref), "The material");
    return null;
  }

  async function getMaterial(ref: unknown): Promise<Material> {
    const root = await openRoot();
    await materialDir(root, ref);
    return loadMaterial(root, ref as MaterialRef);
  }

  // ── Files ──────────────────────────────────────────────────────────────────────────────

  /** Checks one source file and copies it in. Returns the stored name, or the reason it was refused. */
  async function copyIn(source: unknown, inFiles: (name: string) => Promise<string>, filesDir: string, taken: Set<string>): Promise<{ stored: string } | RejectedFile> {
    if (typeof source !== "string" || source.includes("\0")) {
      return { name: "Unknown file", reason: "This file could not be found." };
    }
    const name = path.basename(source).slice(0, 255);
    const reject = (reason: string): RejectedFile => ({ name, reason });
    if (source.length > MAX_SOURCE_PATH || !path.isAbsolute(source)) return reject("This file could not be found.");
    // Before the file is touched in any way: only a file on one of this computer's drives. A
    // network path makes Windows sign in to whatever computer it names, and a device path is
    // not a file at all.
    if (!isLocalFilePath(source)) {
      return reject("Files on a network location cannot be added. Copy the file to this computer first.");
    }

    const kind = kindFromName(name);
    if (!kind) {
      if (/\.ppt$/i.test(name)) {
        return reject("Old PowerPoint files (.ppt) cannot be added. Open it in PowerPoint, save it as .pptx and add that.");
      }
      return reject("Only PDF and PowerPoint (.pptx) files can be added.");
    }

    let temp: string | null = null;
    try {
      const info = await stat(source);
      if (info.isDirectory()) return reject("This is a folder. Add the files inside it instead.");
      if (!info.isFile()) return reject("This is not a file that can be added.");
      if (info.size === 0) return reject("This file is empty.");
      if (info.size > MAX_FILE_BYTES) {
        return reject(`This file is too large. The largest file Studiplan takes is ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      if (!matchesSignature(kind, await readHead(source))) {
        return reject(
          kind === "pdf"
            ? "This does not look like a real PDF. The file may be damaged or have the wrong ending."
            : "This does not look like a real PowerPoint file. It may be damaged or have the wrong ending.",
        );
      }

      const extension = EXTENSION[kind];
      // Keep the whole path short enough for Windows tools; a long name gives way first.
      const room = Math.min(MAX_FILE_NAME, MAX_PATH_LENGTH - filesDir.length - 1 - 4);
      if (room < extension.length + 8) {
        return reject("Your library is kept in a folder with a very long path, so this file cannot be added. Move the library to a shorter path.");
      }
      const wanted = storedFileName(name, extension, room);
      const stored = firstFreeName(wanted.slice(0, -extension.length), extension, taken);

      // Copy under a hidden temporary name, then rename: a file that is listed is always whole.
      temp = await inFiles(tempName(".incoming-", ".part"));
      await copyFile(source, temp, constants.COPYFILE_EXCL);
      const copied = await lstat(temp);
      if (!copied.isFile() || copied.size > MAX_FILE_BYTES) {
        await rm(temp, { force: true });
        return reject("This file changed while it was being copied. Try adding it again.");
      }
      // The name was free when the folder was listed. If something took it since, the next free
      // one is used: a rename would replace what is there without a word.
      let finalName = stored;
      for (let attempt = 0; (await lstatOrNull(await inFiles(finalName))) !== null; attempt += 1) {
        if (attempt >= 20) {
          await rm(temp, { force: true });
          return reject("This file could not be copied. Try adding it again.");
        }
        taken.add(nameKey(finalName));
        finalName = firstFreeName(wanted.slice(0, -extension.length), extension, taken);
      }
      await rename(temp, await inFiles(finalName));
      taken.add(nameKey(finalName));
      return { stored: finalName };
    } catch (error) {
      if (temp) await rm(temp, { force: true }).catch(() => {});
      if (isErrno(error, "ENOENT", "ENOTDIR")) return reject("This file could not be found. It may have been moved or deleted.");
      log(error);
      if (isErrno(error, "ENOSPC")) return reject("The disk is full. Free up some space and add the file again.");
      if (isErrno(error, "EACCES", "EPERM", "EBUSY")) {
        return reject("This file could not be read. Close it in other programs and add it again.");
      }
      return reject("This file could not be copied. Try adding it again.");
    }
  }

  /** Records newly stored entries in `material.json`; if that fails, takes them out again. */
  async function commitAdded(root: string, ref: MaterialRef, meta: Meta, before: FileEntry[], names: string[]): Promise<AddFilesOutcome["added"]> {
    try {
      // A link to something that is no longer there must not come back to life when a new
      // file takes the old name: only the links that hold now are kept.
      const madeFrom = Object.fromEntries(liveLinks(meta.madeFrom, before));
      await writeMeta(root, ref, { ...meta, madeFrom, files: [...before.map((entry) => entry.name), ...names] });
    } catch (error) {
      for (const name of names) {
        await rm(await resolveInside(root, ref.subject, ref.material, FILES_DIR, name), { recursive: true, force: true }).catch(log);
      }
      throw error;
    }
    const added: MaterialFile[] = [];
    for (const name of names) {
      const kind: MaterialFileKind = kindFromName(name) ?? "photo-set";
      added.push(await describeFile(root, ref, { name, kind }));
    }
    return added;
  }

  async function addFiles(input: unknown, paths: unknown): Promise<AddFilesOutcome> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    if (!Array.isArray(paths)) badRequest();
    if (paths.length > MAX_FILES_PER_CALL) {
      fail("too-large", `That is too many files at once. Add up to ${MAX_FILES_PER_CALL} at a time.`);
    }

    const filesDir = await innerDir(root, ref, FILES_DIR, true);
    const { meta, entries: before } = await summarise(root, ref);
    const taken = await takenKeys(filesDir);
    const inFiles = (name: string) => resolveInside(root, ref.subject, ref.material, FILES_DIR, name);

    const stored: string[] = [];
    const rejected: RejectedFile[] = [];
    for (const source of paths as unknown[]) {
      const outcome = await copyIn(source, inFiles, filesDir, taken);
      if ("stored" in outcome) stored.push(outcome.stored);
      else rejected.push(outcome);
    }

    const added = stored.length > 0 ? await commitAdded(root, ref, meta, before, stored) : [];
    return { material: await loadMaterial(root, ref), added, rejected };
  }

  function toBytes(page: unknown): Uint8Array | null {
    if (page instanceof Uint8Array) return page;
    if (page instanceof ArrayBuffer) return new Uint8Array(page);
    return null;
  }

  async function addPhotoSet(input: unknown, pagesInput: unknown): Promise<AddFilesOutcome> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    if (!Array.isArray(pagesInput)) badRequest();
    if (pagesInput.length === 0) fail("unsupported-file", "Add at least one photo.");
    if (pagesInput.length > MAX_PHOTO_PAGES) {
      fail("too-large", `A photo set can have up to ${MAX_PHOTO_PAGES} pages. Split the photos into smaller sets.`);
    }
    // Every page is checked before anything is written.
    const pages: Uint8Array[] = [];
    for (const [index, page] of (pagesInput as unknown[]).entries()) {
      const bytes = toBytes(page);
      if (!bytes || !isJpeg(bytes)) {
        fail("unsupported-file", `Photo ${index + 1} could not be read as a picture. Take or choose it again.`);
      }
      if (bytes.byteLength > MAX_PHOTO_BYTES) {
        fail("too-large", `Photo ${index + 1} is too large to add. Try a smaller picture.`);
      }
      pages.push(bytes);
    }

    const filesDir = await innerDir(root, ref, FILES_DIR, true);
    const { meta, entries: before } = await summarise(root, ref);
    const setName = firstFreeName(`notes-${localDate(now())}`, "", await takenKeys(filesDir));
    checkPathLength(path.join(filesDir, setName, "page-100.jpg"));

    // Written under a hidden temporary name, then renamed: a photo set that is listed is whole.
    const tempSet = tempName(".incoming-");
    const temp = await resolveInside(root, ref.subject, ref.material, FILES_DIR, tempSet);
    try {
      await mkdir(temp);
      for (const [index, bytes] of pages.entries()) {
        const page = await resolveInside(root, ref.subject, ref.material, FILES_DIR, tempSet, `page-${index + 1}.jpg`);
        await writeFile(page, bytes, { flag: "wx" });
      }
      await rename(temp, await resolveInside(root, ref.subject, ref.material, FILES_DIR, setName));
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    const added = await commitAdded(root, ref, meta, before, [setName]);
    return { material: await loadMaterial(root, ref), added, rejected: [] };
  }

  // ── A PDF of a photo set ───────────────────────────────────────────────────────────────

  async function photoSetToPdf(input: unknown, name: unknown): Promise<AddFilesOutcome> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    checkId(name, FILE_GONE);

    const { meta, entries } = await summarise(root, ref);
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) fail("not-found", FILE_GONE);
    if (entry.kind !== "photo-set") fail("unsupported-file", "Only a set of photos can be turned into a PDF.");

    const links = liveLinks(meta.madeFrom, entries);
    const existing = [...links].find(([, set]) => set === entry.name)?.[0];
    if (existing !== undefined) {
      fail("already-exists", `These photos already have their PDF: "${existing}". It holds the same pages as the photos.`);
    }

    const set = await describeFile(root, ref, entry);
    const pages = set.pages ?? [];
    if (pages.length === 0) fail("unsupported-file", "This photo set has no photos in it.");
    // Decided before anything is written: the PDF is the photos plus a little.
    if (set.size + pdfOverheadBytes(pages.length) > MAX_FILE_BYTES) {
      fail(
        "too-large",
        `These photos add up to more than ${MAX_FILE_BYTES / 1024 / 1024} MB, which is more than one file may weigh. Split them into smaller sets and turn each into a PDF.`,
      );
    }

    const filesDir = await innerDir(root, ref, FILES_DIR, true);
    const stored = firstFreeName(entry.name, EXTENSION.pdf, await takenKeys(filesDir));
    const target = await resolveInside(root, ref.subject, ref.material, FILES_DIR, stored);
    checkPathLength(target);

    // Written under a hidden temporary name, then renamed: a PDF that is listed is whole.
    const temp = await resolveInside(root, ref.subject, ref.material, FILES_DIR, tempName(".incoming-", ".part"));
    const inSet = (page: string) => resolveInside(root, ref.subject, ref.material, FILES_DIR, entry.name, page);
    try {
      const handle = await open(temp, "wx");
      try {
        await writePhotoPdf(
          pages.length,
          async (index) => {
            const file = await inSet(pages[index] as string);
            const info = await lstat(file);
            if (!info.isFile() || info.size > MAX_PHOTO_BYTES) throw new PhotoPdfFailure("is too large to go into a PDF.");
            return readFile(file);
          },
          async (chunk) => {
            await handle.write(chunk);
          },
        );
      } finally {
        await handle.close();
      }
      if ((await lstat(temp)).size > MAX_FILE_BYTES) fail("too-large", "These photos make a PDF that is too large. Split them into smaller sets.");
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (error instanceof PhotoPdfFailure) {
        const number = (error as { pageNumber?: number }).pageNumber;
        fail(
          "unsupported-file",
          `${number === undefined ? "A photo" : `Photo ${number}`} of "${entry.name}" ${error.message} No PDF was made.`,
        );
      }
      throw error;
    }

    // The PDF takes its place directly after its photos.
    const names = entries.map((candidate) => candidate.name);
    names.splice(names.indexOf(entry.name) + 1, 0, stored);
    try {
      await writeMeta(root, ref, { ...meta, files: names, madeFrom: { ...Object.fromEntries(links), [stored]: entry.name } });
    } catch (error) {
      await rm(target, { force: true }).catch(log);
      throw error;
    }
    const material = await loadMaterial(root, ref);
    return { material, added: material.files.filter((file) => file.name === stored), rejected: [] };
  }

  async function removeFile(input: unknown, name: unknown): Promise<Material> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    checkId(name, FILE_GONE);

    const target = await resolveInside(root, ref.subject, ref.material, FILES_DIR, name);
    const info = await lstatOrNull(target);
    // Only what a list would show can be removed: a document, or a photo-set folder.
    const removable = info?.isDirectory() || (info?.isFile() && kindFromName(name) !== null);
    if (!removable) fail("not-found", FILE_GONE);

    await moveToTrash(target, info?.isDirectory() ? "The photo set" : "The file");

    try {
      const { meta, entries } = await summarise(root, ref);
      await writeMeta(root, ref, { ...meta, files: entries.map((entry) => entry.name) });
    } catch (error) {
      // The file is gone, which is what was asked. A stale name in material.json is ignored
      // by every read and dropped at the next write.
      log(error);
    }
    return loadMaterial(root, ref);
  }

  // ── Lookups for the rest of the main process ───────────────────────────────────────────

  const NOT_SHOWABLE = "That file cannot be shown here.";

  async function locateFile(input: unknown, name: unknown, page: unknown): Promise<LocatedFile> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    checkId(name, FILE_GONE);
    if (page !== undefined) checkId(page, FILE_GONE);

    const target = await resolveInside(root, ref.subject, ref.material, FILES_DIR, name);
    // lstat: a link is reported as a link, so it is neither a file nor a folder of ours.
    const info = await lstatOrNull(target);
    if (info === null) fail("not-found", FILE_GONE);

    if (page === undefined) {
      const kind = kindFromName(name);
      if (info.isDirectory()) fail("unsupported-file", "A photo set is shown page by page, not as one file.");
      if (!info.isFile() || kind === null) fail("unsupported-file", NOT_SHOWABLE);
      return { path: target, kind, size: info.size, mtimeMs: info.mtimeMs };
    }

    if (!info.isDirectory()) fail("not-found", FILE_GONE);
    if (!/\.jpe?g$/i.test(page)) fail("unsupported-file", NOT_SHOWABLE);
    const pageTarget = await resolveInside(root, ref.subject, ref.material, FILES_DIR, name, page);
    const pageInfo = await lstatOrNull(pageTarget);
    if (pageInfo === null) fail("not-found", FILE_GONE);
    if (!pageInfo.isFile()) fail("unsupported-file", NOT_SHOWABLE);
    return { path: pageTarget, kind: "photo-page", size: pageInfo.size, mtimeMs: pageInfo.mtimeMs };
  }

  async function locateFolder(target: unknown): Promise<string> {
    const root = await openRoot();
    if (target === undefined || target === null) return root;
    if (typeof target !== "object") badRequest();
    const { subject, material } = target as Partial<Record<keyof FolderTarget, unknown>>;
    if (material === undefined || material === null) return subjectDir(root, subject);
    return materialDir(root, { subject, material });
  }

  async function locateMaterial(input: unknown): Promise<LocatedMaterial> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    const material = await loadMaterial(root, ref);
    const filesDirectory = await innerDir(root, ref, FILES_DIR, false);
    const inFiles = (...names: string[]) => resolveInside(root, ref.subject, ref.material, FILES_DIR, ...names);
    const files: LocatedMaterialFile[] = [];
    for (const file of material.files) {
      if (file.kind === "photo-set") {
        const pagePaths: string[] = [];
        for (const page of file.pages ?? []) pagePaths.push(await inFiles(file.name, page));
        files.push({ name: file.name, kind: "photo-set", pagePaths, size: file.size });
      } else {
        files.push({
          name: file.name,
          kind: file.kind,
          path: await inFiles(file.name),
          size: file.size,
          ...(file.madeFrom === undefined ? {} : { madeFrom: file.madeFrom }),
        });
      }
    }
    const identity = await folderIdentity(await resolveInside(root, ref.subject, ref.material));
    return { id: material.id, title: material.title, identity, filesDirectory, files };
  }

  /** When the folder was made and which entry of the disk it is: a remade folder differs. */
  async function folderIdentity(dir: string): Promise<string> {
    const info = await stat(dir);
    return `${info.ino}:${Math.floor(info.birthtimeMs)}`;
  }

  // ── Results (`sets/`) ──────────────────────────────────────────────────────────────────

  const RESULT_GONE = "That result is no longer there. It may have been renamed or deleted outside Studiplan.";
  const RESULT_TOO_LARGE = "This result's file is too large to open.";

  /** A result is addressed by its file name, and only a result's name is ever one. */
  function checkSetName(name: unknown): asserts name is string {
    checkId(name, RESULT_GONE);
    if (parseStudySetFileName(name) === null) fail("not-found", RESULT_GONE);
  }

  /** The path of one result file that is really a file (not a folder, not a link). */
  async function setFile(root: string, ref: MaterialRef, name: unknown): Promise<{ target: string; info: SetFileInfo }> {
    checkSetName(name);
    const target = await resolveInside(root, ref.subject, ref.material, SETS_DIR, name);
    const info = await lstatOrNull(target);
    if (!info?.isFile()) fail("not-found", RESULT_GONE);
    return { target, info: { name, size: info.size, mtimeMs: info.mtimeMs } };
  }

  async function listSetFiles(input: unknown): Promise<SetFileInfo[]> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    const dir = await innerDir(root, ref, SETS_DIR, false);
    const found: SetFileInfo[] = [];
    for (const { fileName } of listStudySetFiles(await setFileNames(dir)).slice(0, MAX_SET_FILES)) {
      try {
        found.push((await setFile(root, ref, fileName)).info);
      } catch (error) {
        // One odd entry (it vanished, or it is a link) does not hide the rest.
        if (!(error instanceof LibraryFailure)) log(error);
      }
    }
    return found;
  }

  async function readSetFile(input: unknown, name: unknown, maxBytes: number): Promise<SetFileText> {
    const root = await openRoot();
    await materialDir(root, input);
    const { target, info } = await setFile(root, input as MaterialRef, name);
    if (info.size > maxBytes) fail("too-large", RESULT_TOO_LARGE);
    return { ...info, text: await readFile(target, "utf8") };
  }

  /** Writes `text` under a hidden temporary name in `sets/`, then renames it to `target`. */
  async function writeSetText(root: string, ref: MaterialRef, target: string, text: string): Promise<void> {
    const temp = await resolveInside(root, ref.subject, ref.material, SETS_DIR, tempName(".incoming-", ".part"));
    try {
      await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function saveSetFile(
    input: unknown,
    choose: (existingNames: string[]) => { name: string; text: string } | null,
    identity?: string,
  ): Promise<SetFileInfo | null> {
    const root = await openRoot();
    const materialFolder = await materialDir(root, input);
    const ref = input as MaterialRef;
    if (identity !== undefined && (await folderIdentity(materialFolder)) !== identity) fail("not-found", MATERIAL_GONE);
    const dir = await innerDir(root, ref, SETS_DIR, true);
    // Every name counts, whatever it is: a new result never takes the name of anything there.
    const chosen = choose((await readEntries(dir)).map((entry) => entry.name));
    if (chosen === null) return null;
    checkSetName(chosen.name);

    const target = await resolveInside(root, ref.subject, ref.material, SETS_DIR, chosen.name);
    checkPathLength(target);
    if ((await lstatOrNull(target)) !== null) {
      fail("already-exists", "A result with that name already exists. Try again.");
    }
    await writeSetText(root, ref, target, chosen.text);
    return (await setFile(root, ref, chosen.name)).info;
  }

  async function rewriteSetFile(
    input: unknown,
    name: unknown,
    edit: (text: string) => string,
    maxBytes: number,
  ): Promise<SetFileInfo> {
    const root = await openRoot();
    await materialDir(root, input);
    const ref = input as MaterialRef;
    const { target, info } = await setFile(root, ref, name);
    if (info.size > maxBytes) fail("too-large", RESULT_TOO_LARGE);
    const next = edit(await readFile(target, "utf8"));
    await writeSetText(root, ref, target, next);
    return (await setFile(root, ref, name)).info;
  }

  async function deleteSetFile(input: unknown, name: unknown): Promise<null> {
    const root = await openRoot();
    await materialDir(root, input);
    const { target } = await setFile(root, input as MaterialRef, name);
    await moveToTrash(target, "The result");
    return null;
  }

  return {
    locateFile: (ref, name, page) => toResult(() => locateFile(ref, name, page), log),
    locateFolder: (target) => toResult(() => locateFolder(target), log),
    locateMaterial: (ref) => toResult(() => locateMaterial(ref), log),
    listSetFiles: (ref) => toResult(() => listSetFiles(ref), log),
    readSetFile: (ref, name, maxBytes) => toResult(() => readSetFile(ref, name, maxBytes), log),
    // Writes wait their turn like every other change to the library.
    saveSetFile: (ref, choose, identity) => run(() => saveSetFile(ref, choose, identity)),
    rewriteSetFile: (ref, name, edit, maxBytes) => run(() => rewriteSetFile(ref, name, edit, maxBytes)),
    deleteSetFile: (ref, name) => run(() => deleteSetFile(ref, name)),
    getInfo: () => run(async () => deps.root()),
    listSubjects: () => run(listSubjects),
    createSubject: (name) => run(() => createSubject(name)),
    renameSubject: (subject, newName) => run(() => renameSubject(subject, newName)),
    deleteSubject: (subject) => run(() => deleteSubject(subject)),
    listMaterials: (subject) => run(() => listMaterials(subject)),
    createMaterial: (subject, title) => run(() => createMaterial(subject, title)),
    renameMaterial: (ref, title) => run(() => renameMaterial(ref, title)),
    deleteMaterial: (ref) => run(() => deleteMaterial(ref)),
    getMaterial: (ref) => run(() => getMaterial(ref)),
    addFiles: (ref, paths) => run(() => addFiles(ref, paths)),
    addPhotoSet: (ref, pages) => run(() => addPhotoSet(ref, pages)),
    photoSetToPdf: (ref, name) => run(() => photoSetToPdf(ref, name)),
    removeFile: (ref, name) => run(() => removeFile(ref, name)),
  };
}

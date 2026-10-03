/**
 * Whether a folder the user picked may become the library.
 *
 * In the library every folder directly inside the root is a subject, and deleting a subject
 * moves its folder to the recycle bin. So the root must be a folder that is the library's own:
 * never a place whose folders belong to the system, to the app or to the rest of the user's
 * life.
 *
 * No Electron import: the places to keep out of are passed in, so this runs in tests.
 */
import { randomBytes } from "node:crypto";
import { realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail, isErrno } from "./errors";
import { isInside } from "./paths";

/**
 * The longest root the app accepts. Windows tools stop at 260 characters for a whole path, and
 * a subject, a material, `files` and a file name still have to fit behind the root.
 */
export const MAX_ROOT_LENGTH = 120;

export interface RootPlaces {
  /** The user's home folder. It, and everything above it, is refused. */
  home: string;
  /**
   * Folders that hold the user's things side by side (Documents, Desktop, Downloads, Pictures…).
   * Each is refused itself; a folder inside one is the normal choice.
   */
  personal: readonly string[];
  /**
   * The app's own folders (where it is installed, where it keeps its data). The library may not
   * be one of them, inside one, or around one.
   */
  app: readonly string[];
  /** Folders of the operating system and of installed programs. Nothing inside them is accepted. */
  system: readonly string[];
}

async function real(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

async function realAll(targets: readonly string[]): Promise<string[]> {
  const found = await Promise.all(targets.filter((target) => path.isAbsolute(target)).map(real));
  return found.filter((target): target is string => target !== null);
}

const same = (a: string, b: string): boolean => path.relative(a, b) === "";

/**
 * Checks `candidate` and returns the folder to store: its real location, with every link on
 * the way followed. Throws a `LibraryFailure` whose sentence says what to pick instead.
 */
export async function checkLibraryRoot(candidate: unknown, places: RootPlaces): Promise<string> {
  if (typeof candidate !== "string" || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    fail("invalid-request", "Studiplan could not understand that request. Try again.");
  }

  const root = await real(candidate);
  let isDirectory = false;
  if (root !== null) {
    try {
      isDirectory = (await stat(root)).isDirectory();
    } catch {
      isDirectory = false;
    }
  }
  if (root === null || !isDirectory) {
    fail("not-found", "That folder could not be opened. Pick a folder that exists.");
  }

  if (same(path.parse(root).root, root)) {
    fail(
      "invalid-name",
      "A whole drive cannot be the library. Make a folder on it, for example one called Studiplan, and pick that.",
    );
  }

  const home = await real(places.home);
  if (home !== null && isInside(root, home)) {
    fail(
      "invalid-name",
      "Your whole user folder cannot be the library. Make a folder inside it, for example in Documents, and pick that.",
    );
  }
  for (const folder of await realAll(places.personal)) {
    if (same(folder, root)) {
      fail(
        "invalid-name",
        `Every folder in the library is shown as a subject, so "${path.basename(root)}" itself cannot be the library. Make a new folder inside it and pick that.`,
      );
    }
    // A folder that holds one of them (a synced folder with Documents in it, say): Documents
    // would be listed as a subject, and a subject can be deleted.
    if (isInside(root, folder)) {
      fail(
        "invalid-name",
        `That folder holds your "${path.basename(folder)}" folder, and every folder in the library is shown as a subject. Pick a folder that is only for your study materials.`,
      );
    }
  }

  for (const folder of await realAll(places.app)) {
    if (isInside(folder, root) || isInside(root, folder)) {
      fail("invalid-name", "That folder belongs to the Studiplan app itself. Pick a folder of your own, for example in Documents.");
    }
  }
  for (const folder of await realAll(places.system)) {
    if (isInside(folder, root) || isInside(root, folder)) {
      fail("invalid-name", "That folder belongs to the system. Pick a folder of your own, for example in Documents.");
    }
  }

  if (root.length > MAX_ROOT_LENGTH) {
    fail(
      "invalid-name",
      "That folder's path is too long to keep subjects and files inside it. Pick a folder closer to the top of the drive.",
    );
  }

  // Writable? The only sure way to know is to write. The probe is hidden and removed at once.
  const probe = path.join(root, `.studiplan-check-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch (error) {
    if (isErrno(error, "ENOSPC")) fail("io", "That disk is full. Free up some space or pick another folder.");
    fail("io", "Studiplan is not allowed to save files in that folder. Pick another one.");
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }

  return root;
}

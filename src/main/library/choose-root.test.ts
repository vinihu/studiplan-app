import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLibraryRoot, MAX_ROOT_LENGTH } from "./choose-root";
import type { RootPlaces } from "./choose-root";
import { LibraryFailure } from "./errors";

let sandbox: string;
let places: RootPlaces;

// A pretend computer: home/Documents, home/Desktop, an installed app, its data, a system folder.
beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "sp-root-")));
  const home = path.join(sandbox, "home");
  places = {
    home,
    personal: [path.join(home, "Documents"), path.join(home, "Desktop"), path.join(home, "No such folder")],
    app: [path.join(sandbox, "Programs", "Studiplan"), path.join(home, "AppData", "Studiplan")],
    system: [path.join(sandbox, "Windows")],
  };
  for (const folder of [
    path.join(home, "Documents", "Studiplan"),
    path.join(home, "Desktop"),
    path.join(home, "AppData", "Studiplan", "Cache"),
    path.join(sandbox, "Programs", "Studiplan", "resources"),
    path.join(sandbox, "Windows", "System32"),
    path.join(sandbox, "Elsewhere", "My library"),
  ]) {
    await mkdir(folder, { recursive: true });
  }
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function refusal(candidate: unknown) {
  const error = await checkLibraryRoot(candidate, places).then(
    (value) => value,
    (thrown: unknown) => thrown,
  );
  expect(error, String(candidate)).toBeInstanceOf(LibraryFailure);
  const failure = error as LibraryFailure;
  // The sentence says what to do and never repeats the whole path.
  expect(failure.message).not.toContain(sandbox);
  expect(failure.message.length).toBeGreaterThan(20);
  return failure;
}

describe("checkLibraryRoot", () => {
  it("accepts a folder of the user's own, and leaves nothing behind in it", async () => {
    const inDocuments = path.join(places.home, "Documents", "Studiplan");
    expect(await checkLibraryRoot(inDocuments, places)).toBe(inDocuments);
    expect(await readdir(inDocuments)).toEqual([]);

    const elsewhere = path.join(sandbox, "Elsewhere", "My library");
    expect(await checkLibraryRoot(elsewhere, places)).toBe(elsewhere);
    // A folder that already has things in it is fine: nothing is touched.
    await mkdir(path.join(elsewhere, "Biology"));
    expect(await checkLibraryRoot(elsewhere, places)).toBe(elsewhere);
    expect(await readdir(elsewhere)).toEqual(["Biology"]);
  });

  it("refuses a request that is not a path", async () => {
    for (const bad of [undefined, null, 5, "", "relative/folder", `${sandbox}\0x`]) {
      expect((await refusal(bad)).code).toBe("invalid-request");
    }
  });

  it("refuses a folder that is not there, and a file", async () => {
    expect((await refusal(path.join(sandbox, "missing"))).code).toBe("not-found");
    const file = path.join(sandbox, "Elsewhere", "notes.txt");
    await writeFile(file, "x");
    expect((await refusal(file)).code).toBe("not-found");
  });

  it("refuses a whole drive", async () => {
    const failure = await refusal(path.parse(sandbox).root);
    expect(failure.code).toBe("invalid-name");
    expect(failure.message).toContain("whole drive");
  });

  it("refuses the home folder and everything above it, but not a folder inside it", async () => {
    expect((await refusal(places.home)).message).toContain("user folder");
    expect((await refusal(sandbox)).message).toContain("user folder");
    await mkdir(path.join(places.home, "Study"));
    expect(await checkLibraryRoot(path.join(places.home, "Study"), places)).toBe(path.join(places.home, "Study"));
  });

  it("refuses Documents and Desktop themselves, and says to make a folder inside", async () => {
    for (const name of ["Documents", "Desktop"]) {
      const failure = await refusal(path.join(places.home, name));
      expect(failure.code).toBe("invalid-name");
      expect(failure.message).toContain(`"${name}"`);
      expect(failure.message).toContain("Make a new folder inside it");
    }
  });

  it("refuses the app's own folders: themselves, inside them, and around them", async () => {
    for (const folder of [
      path.join(sandbox, "Programs", "Studiplan"),
      path.join(sandbox, "Programs", "Studiplan", "resources"),
      path.join(sandbox, "Programs"),
      path.join(places.home, "AppData", "Studiplan", "Cache"),
      path.join(places.home, "AppData"),
    ]) {
      expect((await refusal(folder)).message, folder).toContain("Studiplan app itself");
    }
  });

  it("refuses system folders", async () => {
    expect((await refusal(path.join(sandbox, "Windows", "System32"))).message).toContain("belongs to the system");
    expect((await refusal(path.join(sandbox, "Windows"))).message).toContain("belongs to the system");
  });

  it("judges the real place a link leads to", async () => {
    const link = path.join(sandbox, "Elsewhere", "shortcut");
    await symlink(path.join(places.home, "Documents"), link, "junction");
    expect((await refusal(link)).message).toContain('"Documents"');

    const fine = path.join(sandbox, "Elsewhere", "to-library");
    await symlink(path.join(sandbox, "Elsewhere", "My library"), fine, "junction");
    // What is stored is where the library really is.
    expect(await checkLibraryRoot(fine, places)).toBe(path.join(sandbox, "Elsewhere", "My library"));
  });

  it("refuses a path too long to keep subjects and files under", async () => {
    let deep = path.join(sandbox, "Elsewhere");
    while (deep.length <= MAX_ROOT_LENGTH) deep = path.join(deep, "a-rather-long-folder-name");
    await mkdir(deep, { recursive: true });
    expect((await refusal(deep)).message).toContain("too long");
  });

  it.skipIf(process.platform !== "win32")("compares without regard to capitals on Windows", async () => {
    expect((await refusal(path.join(places.home, "DOCUMENTS"))).message).toContain("Make a new folder inside it");
  });
});

describe("a folder that holds one of the user's own folders", () => {
  it("is refused: Documents would become a subject that can be deleted", async () => {
    // A synced folder with the user's Documents inside it, outside the home folder.
    const synced = path.join(sandbox, "Sync");
    const documents = path.join(synced, "Documents");
    await mkdir(documents, { recursive: true });
    const here: RootPlaces = { ...places, personal: [...places.personal, documents] };
    const error = await checkLibraryRoot(synced, here).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(LibraryFailure);
    expect((error as LibraryFailure).message).toMatch(/holds your "Documents" folder/);
    expect((error as LibraryFailure).message).not.toContain(sandbox);
    // A folder next to it, and one inside it, are fine.
    await mkdir(path.join(synced, "Studiplan"));
    expect(await checkLibraryRoot(path.join(synced, "Studiplan"), here)).toBe(path.join(synced, "Studiplan"));
    await mkdir(path.join(documents, "Studiplan"));
    expect(await checkLibraryRoot(path.join(documents, "Studiplan"), here)).toBe(path.join(documents, "Studiplan"));
  });
});

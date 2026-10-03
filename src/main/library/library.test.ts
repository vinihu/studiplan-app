import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryResult, MaterialRef } from "@shared/library";
import { growthOfAsync } from "@shared/test-scaling";
import { MAX_INPUT_BYTES } from "../extract/limits";
import { createLibrary, MAX_FILE_BYTES, MAX_PHOTO_BYTES, MAX_PHOTO_PAGES } from "./library";
import type { LibraryService } from "./library";

let sandbox: string;
let root: string;
let sources: string;
let library: LibraryService;
let logged: unknown[];
let trashed: string[];
let trashFails: boolean;

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-library-")));
  root = path.join(sandbox, "library");
  sources = path.join(sandbox, "sources");
  await mkdir(sources);
  logged = [];
  trashed = [];
  trashFails = false;
  library = createLibrary({
    root: () => ({ root, isDefault: false, fixedByEnvironment: false }),
    trash: async (target) => {
      if (trashFails) throw new Error(`cannot trash ${target}`);
      trashed.push(target);
      await rm(target, { recursive: true });
    },
    log: (error) => logged.push(error),
    now: () => new Date(2026, 9, 2, 14, 30),
  });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function value<T>(result: LibraryResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function failure<T>(result: LibraryResult<T>) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  // No sentence shown to a student carries a path, an error code or a stack.
  expect(result.error.message).not.toContain(sandbox);
  expect(result.error.message).not.toMatch(/E[A-Z]{4,}|\bat .+:\d+/);
  expect(result.error.message.length).toBeGreaterThan(10);
  return result.error;
}

async function source(name: string, content: Buffer | string): Promise<string> {
  const file = path.join(sources, name);
  await writeFile(file, content);
  return file;
}

async function newMaterial(subject = "Biology", title = "Cell division"): Promise<MaterialRef> {
  if (!existsSync(path.join(root, subject))) value(await library.createSubject(subject));
  const material = value(await library.createMaterial(subject, title));
  return { subject, material: material.id };
}

async function metaOf(ref: MaterialRef): Promise<{ title: string; created: string; files: string[] }> {
  return JSON.parse(await readFile(path.join(root, ref.subject, ref.material, "material.json"), "utf8")) as never;
}

/** The json's order and the folder's contents must describe the same things. */
async function expectJsonMatchesFolder(ref: MaterialRef): Promise<void> {
  const onDisk = (await readdir(path.join(root, ref.subject, ref.material, "files"))).filter((name) => !name.startsWith("."));
  expect([...(await metaOf(ref)).files].sort()).toEqual([...onDisk].sort());
}

describe("root", () => {
  it("reports the root and creates it on first use", async () => {
    expect(value(await library.getInfo())).toEqual({ root, isDefault: false, fixedByEnvironment: false });
    expect(existsSync(root)).toBe(false);
    expect(value(await library.listSubjects())).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });
});

describe("subjects", () => {
  it("creates, lists in natural order, and counts materials", async () => {
    value(await library.createSubject("Maths 10"));
    value(await library.createSubject("maths 2"));
    expect(value(await library.createSubject("  Biology  "))).toEqual({ id: "Biology", materialCount: 0 });
    value(await library.createMaterial("Biology", "Cells"));
    value(await library.createMaterial("Biology", "Plants"));

    expect(value(await library.listSubjects())).toEqual([
      { id: "Biology", materialCount: 2 },
      { id: "maths 2", materialCount: 0 },
      { id: "Maths 10", materialCount: 0 },
    ]);
    expect((await stat(path.join(root, "Biology"))).isDirectory()).toBe(true);
  });

  it("keeps Unicode names and sanitises what a folder cannot hold", async () => {
    expect(value(await library.createSubject("数学")).id).toBe("数学");
    expect(value(await library.createSubject("Física: mecánica?")).id).toBe("Física- mecánica");
    expect(existsSync(path.join(root, "Física- mecánica"))).toBe(true);
  });

  it("rejects names that cannot be a folder", async () => {
    for (const name of ["", "   ", "...", "???", "CON", "nul", "com1.txt", "desktop.ini", "x".repeat(61)]) {
      expect(failure(await library.createSubject(name)).code, JSON.stringify(name)).toBe("invalid-name");
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a collision whatever the capitals, with a sentence that names the subject", async () => {
    value(await library.createSubject("Biology"));
    const error = failure(await library.createSubject("BIOLOGY"));
    expect(error.code).toBe("already-exists");
    expect(error.message).toBe('A subject called "BIOLOGY" already exists. Pick a different name.');
    expect(failure(await library.createSubject("biology  ")).code).toBe("already-exists");
    expect(await readdir(root)).toEqual(["Biology"]);
  });

  it("collides with a stray file of the same name too", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "Notes"), "a file, not a folder");
    expect(failure(await library.createSubject("notes")).code).toBe("already-exists");
  });

  it("renames and keeps the contents", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("a.pdf", PDF)]));

    expect(value(await library.renameSubject("Biology", "Life science"))).toEqual({ id: "Life science", materialCount: 1 });
    expect(existsSync(path.join(root, "Biology"))).toBe(false);
    const material = value(await library.getMaterial({ subject: "Life science", material: ref.material }));
    expect(material.files.map((file) => file.name)).toEqual(["a.pdf"]);
  });

  it("renames to the same name with other capitals, and refuses another subject's name", async () => {
    value(await library.createSubject("biology"));
    value(await library.createSubject("Chemistry"));
    expect(value(await library.renameSubject("biology", "Biology")).id).toBe("Biology");
    expect((await readdir(root)).sort()).toEqual(["Biology", "Chemistry"]);
    expect(value(await library.renameSubject("Biology", "Biology")).id).toBe("Biology");

    expect(failure(await library.renameSubject("Biology", "chemistry")).code).toBe("already-exists");
    expect(failure(await library.renameSubject("Biology", "??")).code).toBe("invalid-name");
    expect(failure(await library.renameSubject("Physics", "Anything")).code).toBe("not-found");
  });

  it("deletes through the recycle bin, and says so plainly when that fails", async () => {
    await newMaterial();
    trashFails = true;
    const error = failure(await library.deleteSubject("Biology"));
    expect(error.code).toBe("io");
    expect(error.message).toContain("Recycle Bin");
    expect(existsSync(path.join(root, "Biology"))).toBe(true);
    expect(logged).toHaveLength(1);

    trashFails = false;
    expect(value(await library.deleteSubject("Biology"))).toBeNull();
    expect(trashed).toEqual([path.join(root, "Biology")]);
    expect(value(await library.listSubjects())).toEqual([]);
    expect(failure(await library.deleteSubject("Biology")).code).toBe("not-found");
  });
});

describe("materials", () => {
  it("creates the documented folder layout", async () => {
    value(await library.createSubject("Biology"));
    const material = value(await library.createMaterial("Biology", "Cell division"));
    expect(material).toEqual({
      id: "Cell division",
      subject: "Biology",
      title: "Cell division",
      created: new Date(2026, 9, 2, 14, 30).toISOString(),
      fileCount: 0,
      setCount: 0,
    });
    const dir = path.join(root, "Biology", "Cell division");
    expect((await readdir(dir)).sort()).toEqual(["files", "material.json", "sets"]);
    expect(await metaOf({ subject: "Biology", material: "Cell division" })).toEqual({
      title: "Cell division",
      created: material.created,
      files: [],
    });
  });

  it("keeps the full title in the json when the folder name has to differ", async () => {
    value(await library.createSubject("Biology"));
    const material = value(await library.createMaterial("Biology", 'What is "DNA"? Part 1/2'));
    expect(material.title).toBe('What is "DNA"? Part 1/2');
    expect(material.id).toBe("What is DNA Part 1-2");
    // A name the system keeps for itself is refused, for a material as for a subject.
    for (const title of ["CON", "nul", "Aux", "com1.txt", "LPT1"]) {
      const error = failure(await library.createMaterial("Biology", title));
      expect(error.code).toBe("invalid-name");
      expect(error.message).toMatch(/is a name the system keeps for itself/);
    }
    expect(failure(await library.createSubject("NUL")).message).toMatch(/is a name the system keeps for itself/);
    // Nothing but spaces is no title and no name, and both say so.
    for (const blank of ["   ", "\t\n ", ""]) {
      expect(failure(await library.createMaterial("Biology", blank))).toEqual({ code: "invalid-name", message: "Type a title for the material." });
      expect(failure(await library.createSubject(blank)).code).toBe("invalid-name");
      expect(failure(await library.renameMaterial({ subject: "Biology", material: "What is DNA Part 1-2" }, blank)).code).toBe("invalid-name");
      expect(failure(await library.renameSubject("Biology", blank)).code).toBe("invalid-name");
    }
    expect(value(await library.createMaterial("Biology", "División celular – Übung 数学")).id).toBe("División celular – Übung 数学");
  });

  it("rejects bad titles, collisions and unknown subjects", async () => {
    value(await library.createSubject("Biology"));
    value(await library.createMaterial("Biology", "Cells"));
    expect(failure(await library.createMaterial("Biology", "  ")).code).toBe("invalid-name");
    expect(failure(await library.createMaterial("Biology", "???")).code).toBe("invalid-name");
    expect(failure(await library.createMaterial("Biology", "x".repeat(201))).code).toBe("invalid-name");
    expect(failure(await library.createMaterial("Biology", "CELLS")).code).toBe("already-exists");
    expect(failure(await library.createMaterial("Biology", "Cells?")).code).toBe("already-exists");
    expect(failure(await library.createMaterial("Physics", "Waves")).code).toBe("not-found");
    expect(failure(await library.listMaterials("Physics")).code).toBe("not-found");
  });

  it("lists by title in natural order with counts", async () => {
    const ten = await newMaterial("Biology", "Lecture 10");
    await newMaterial("Biology", "Lecture 2");
    value(await library.addFiles(ten, [await source("a.pdf", PDF), await source("b.pptx", PPTX)]));
    await writeFile(path.join(root, "Biology", "Lecture 10", "sets", "2026-10-02-summary.md"), "# Summary");

    const list = value(await library.listMaterials("Biology"));
    expect(list.map((m) => [m.title, m.fileCount, m.setCount])).toEqual([
      ["Lecture 2", 0, 0],
      ["Lecture 10", 2, 1],
    ]);
  });

  it("renames: the title changes, the folder follows, the contents stay", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("a.pdf", PDF)]));
    const created = (await metaOf(ref)).created;

    const renamed = value(await library.renameMaterial(ref, "Mitosis & meiosis"));
    expect(renamed).toMatchObject({ id: "Mitosis & meiosis", title: "Mitosis & meiosis", created, fileCount: 1 });
    expect(existsSync(path.join(root, "Biology", "Cell division"))).toBe(false);
    const next = { subject: "Biology", material: renamed.id };
    expect(await metaOf(next)).toEqual({ title: "Mitosis & meiosis", created, files: ["a.pdf"] });

    // A change that leaves the folder name alone only rewrites the title.
    const again = value(await library.renameMaterial(next, "Mitosis & meiosis?"));
    expect(again).toMatchObject({ id: "Mitosis & meiosis", title: "Mitosis & meiosis?" });
    expect(await readdir(path.join(root, "Biology"))).toEqual(["Mitosis & meiosis"]);
  });

  it("refuses a rename onto another material and leaves both untouched", async () => {
    const a = await newMaterial("Biology", "Cells");
    await newMaterial("Biology", "Plants");
    expect(failure(await library.renameMaterial(a, "plants")).code).toBe("already-exists");
    expect(failure(await library.renameMaterial(a, "")).code).toBe("invalid-name");
    expect((await metaOf(a)).title).toBe("Cells");
    expect(value(await library.renameMaterial(a, "CELLS")).id).toBe("CELLS");
    expect(failure(await library.renameMaterial({ subject: "Biology", material: "Gone" }, "X")).code).toBe("not-found");
  });

  it("deletes one material and leaves its neighbours", async () => {
    const a = await newMaterial("Biology", "Cells");
    await newMaterial("Biology", "Plants");
    expect(value(await library.deleteMaterial(a))).toBeNull();
    expect(value(await library.listMaterials("Biology")).map((m) => m.id)).toEqual(["Plants"]);
    expect(failure(await library.getMaterial(a)).code).toBe("not-found");
  });
});

describe("hand-made mess", () => {
  it("ignores stray and system files in the root and in a subject", async () => {
    await newMaterial();
    await writeFile(path.join(root, "desktop.ini"), "[.ShellClassInfo]");
    await writeFile(path.join(root, "Thumbs.db"), "x");
    await writeFile(path.join(root, "todo.txt"), "x");
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "$RECYCLE.BIN"));
    await writeFile(path.join(root, "Biology", "desktop.ini"), "x");
    await writeFile(path.join(root, "Biology", "syllabus.pdf"), PDF);
    await mkdir(path.join(root, "Biology", ".trash"));

    expect(value(await library.listSubjects())).toEqual([{ id: "Biology", materialCount: 1 }]);
    expect(value(await library.listMaterials("Biology")).map((m) => m.id)).toEqual(["Cell division"]);
    expect(failure(await library.listMaterials(".git")).code).toBe("not-found");
    expect(failure(await library.deleteSubject("$RECYCLE.BIN")).code).toBe("not-found");
    expect(failure(await library.listMaterials("todo.txt")).code).toBe("not-found");
  });

  it("treats a folder without material.json as a material named after the folder", async () => {
    await mkdir(path.join(root, "Biology", "Made by hand"), { recursive: true });
    const [material] = value(await library.listMaterials("Biology"));
    expect(material).toMatchObject({ id: "Made by hand", title: "Made by hand", fileCount: 0, setCount: 0 });
    expect(Number.isNaN(Date.parse(material!.created))).toBe(false);
    // Reading does not write.
    expect(await readdir(path.join(root, "Biology", "Made by hand"))).toEqual([]);

    // The first change heals it: files/ and material.json appear.
    const ref = { subject: "Biology", material: "Made by hand" };
    value(await library.addFiles(ref, [await source("a.pdf", PDF)]));
    expect(await metaOf(ref)).toEqual({ title: "Made by hand", created: material!.created, files: ["a.pdf"] });
  });

  it("survives a corrupt, wrong-shaped, empty or oversized material.json", async () => {
    const ref = await newMaterial();
    const file = path.join(root, ref.subject, ref.material, "material.json");
    const broken = [
      "{ not json",
      "",
      "null",
      "[1,2,3]",
      '"text"',
      JSON.stringify({ title: 42, created: "yesterday-ish", files: "a.pdf" }),
      JSON.stringify({ title: "   ", created: 5, files: [1, null, { a: 1 }] }),
      `{"title":"${"x".repeat(300 * 1024)}"}`,
    ];
    for (const text of broken) {
      await writeFile(file, text);
      const [summary] = value(await library.listMaterials("Biology"));
      expect(summary, text.slice(0, 30)).toMatchObject({ id: "Cell division", title: "Cell division" });
      expect(Number.isNaN(Date.parse(summary!.created))).toBe(false);
      expect(value(await library.getMaterial(ref)).files).toEqual([]);
    }
    // A byte-order mark from Notepad is fine.
    await writeFile(file, `\uFEFF${JSON.stringify({ title: "From Notepad", created: "2026-01-05T10:00:00.000Z", files: [] })}`);
    expect(value(await library.getMaterial(ref))).toMatchObject({ title: "From Notepad", created: "2026-01-05T10:00:00.000Z" });
  });

  it("never treats a name in material.json as a path", async () => {
    const ref = await newMaterial();
    const secret = path.join(sandbox, "secret.pdf");
    await writeFile(secret, PDF);
    value(await library.addFiles(ref, [await source("real.pdf", PDF)]));
    await writeFile(
      path.join(root, ref.subject, ref.material, "material.json"),
      JSON.stringify({
        title: "T",
        created: "2026-01-05T10:00:00.000Z",
        files: [secret, "../../../secret.pdf", "..\\..\\..\\secret.pdf", "..", "real.pdf", "C:\\Windows\\win.ini", "nul"],
      }),
    );
    const material = value(await library.getMaterial(ref));
    expect(material.files.map((file) => file.name)).toEqual(["real.pdf"]);

    // The next write drops the bad names.
    value(await library.renameMaterial(ref, "T2"));
    expect((await metaOf({ subject: ref.subject, material: "T2" })).files).toEqual(["real.pdf"]);
    expect(existsSync(secret)).toBe(true);
  });

  it("reconciles the order with what is really in files/", async () => {
    const ref = await newMaterial();
    const files = path.join(root, ref.subject, ref.material, "files");
    value(await library.addFiles(ref, [await source("b.pdf", PDF), await source("a.pdf", PDF), await source("gone.pdf", PDF)]));
    expect((await metaOf(ref)).files).toEqual(["b.pdf", "a.pdf", "gone.pdf"]);

    await rm(path.join(files, "gone.pdf")); // deleted by hand
    await writeFile(path.join(files, "zz-by-hand.pptx"), PPTX); // added by hand
    await writeFile(path.join(files, "c-by-hand.PDF"), PDF);
    await writeFile(path.join(files, "desktop.ini"), "x");
    await writeFile(path.join(files, "Thumbs.db"), "x");
    await writeFile(path.join(files, "essay.docx"), "x");
    await writeFile(path.join(files, "~$zz-by-hand.pptx"), "lock");
    await mkdir(path.join(files, "scans"));
    await writeFile(path.join(files, "scans", "IMG_2.jpg"), JPEG);
    await writeFile(path.join(files, "scans", "IMG_10.JPEG"), JPEG);
    await writeFile(path.join(files, "scans", "notes.txt"), "x");

    const material = value(await library.getMaterial(ref));
    expect(material.files.map((file) => [file.name, file.kind])).toEqual([
      ["b.pdf", "pdf"],
      ["a.pdf", "pdf"],
      ["c-by-hand.PDF", "pdf"],
      ["scans", "photo-set"],
      ["zz-by-hand.pptx", "pptx"],
    ]);
    expect(material.fileCount).toBe(5);
    expect(material.files[3]).toEqual({ name: "scans", kind: "photo-set", size: JPEG.length * 2, pages: ["IMG_2.jpg", "IMG_10.JPEG"] });
    expect(value(await library.listMaterials("Biology"))[0]!.fileCount).toBe(5);

    // The json's own order is matched whatever the capitals, and catches up on the next change.
    value(await library.removeFile(ref, "a.pdf"));
    expect((await metaOf(ref)).files).toEqual(["b.pdf", "c-by-hand.PDF", "scans", "zz-by-hand.pptx"]);
  });

  it("works when files/ and sets/ were deleted by hand", async () => {
    const ref = await newMaterial();
    await rm(path.join(root, ref.subject, ref.material, "files"), { recursive: true });
    await rm(path.join(root, ref.subject, ref.material, "sets"), { recursive: true });
    expect(value(await library.getMaterial(ref))).toMatchObject({ fileCount: 0, setCount: 0, files: [] });
    expect(value(await library.addFiles(ref, [await source("a.pdf", PDF)])).added).toHaveLength(1);
  });

  it("does not let one odd folder break the list", async () => {
    await newMaterial("Biology", "Good");
    await mkdir(path.join(root, "Biology", "Odd"));
    await mkdir(path.join(root, "Biology", "Odd", "material.json")); // a folder where the file should be
    await writeFile(path.join(root, "Biology", "Odd", "files"), "a file where the folder should be");
    const list = value(await library.listMaterials("Biology"));
    expect(list.map((m) => [m.id, m.title, m.fileCount])).toEqual([
      ["Good", "Good", 0],
      ["Odd", "Odd", 0],
    ]);
  });
});

describe("path safety through the public calls", () => {
  const hostile = ["..", "../outside", "..\\outside", "Biology/..", "/", "C:\\", "C:", "Biology\\Cell division", "a\u0000b", "NUL", "Biology."];

  it("refuses hostile subject and material ids on every call", async () => {
    const ref = await newMaterial();
    const outside = path.join(sandbox, "outside");
    await mkdir(path.join(outside, "inner"), { recursive: true });
    const pdf = await source("a.pdf", PDF);

    for (const id of [...hostile, outside]) {
      const results: Array<LibraryResult<unknown>> = [
        await library.listMaterials(id),
        await library.createMaterial(id, "X"),
        await library.renameSubject(id, "X"),
        await library.deleteSubject(id),
        await library.getMaterial({ subject: id, material: ref.material }),
        await library.getMaterial({ subject: ref.subject, material: id }),
        await library.deleteMaterial({ subject: ref.subject, material: id }),
        await library.renameMaterial({ subject: ref.subject, material: id }, "X"),
        await library.addFiles({ subject: ref.subject, material: id }, [pdf]),
        await library.addPhotoSet({ subject: id, material: ref.material }, [JPEG]),
        await library.removeFile(ref, id),
      ];
      for (const result of results) expect(failure(result).code, JSON.stringify(id)).toBe("outside-library");
    }
    expect(trashed).toEqual([]);
    expect((await readdir(sandbox)).sort()).toEqual(["library", "outside", "sources"]);
    expect(await readdir(outside)).toEqual(["inner"]);
  });

  it("refuses arguments of the wrong type without throwing", async () => {
    const ref = await newMaterial();
    const calls: Array<Promise<LibraryResult<unknown>>> = [
      library.createSubject(42 as never),
      library.createSubject(null as never),
      library.createSubject({ toString: () => "x" } as never),
      library.renameSubject("Biology", ["x"] as never),
      library.listMaterials(undefined as never),
      library.createMaterial("Biology", 7 as never),
      library.getMaterial(null as never),
      library.getMaterial("Biology/Cell division" as never),
      library.getMaterial({ subject: "Biology" } as never),
      library.getMaterial({ subject: ["Biology"], material: "Cell division" } as never),
      library.addFiles(ref, "C:\\a.pdf" as never),
      library.addFiles(ref, { length: 1, 0: "x" } as never),
      library.addPhotoSet(ref, JPEG as never),
      library.addPhotoSet(ref, [[0xff, 0xd8, 0xff]] as never),
      library.addPhotoSet(ref, ["ÿØÿ"] as never),
      library.removeFile(ref, 5 as never),
    ];
    for (const call of calls) expect((await call).ok).toBe(false);
  });

  it("does not follow a junction that stands where a subject, a material or files/ should be", async () => {
    const ref = await newMaterial();
    const outside = path.join(sandbox, "outside");
    await mkdir(path.join(outside, "Material", "files"), { recursive: true });
    await writeFile(path.join(outside, "Material", "files", "secret.pdf"), PDF);

    await symlink(outside, path.join(root, "Linked subject"), "junction");
    await symlink(path.join(outside, "Material"), path.join(root, "Biology", "Linked material"), "junction");

    // Links are not listed…
    expect(value(await library.listSubjects()).map((s) => s.id)).toEqual(["Biology"]);
    expect(value(await library.listMaterials("Biology")).map((m) => m.id)).toEqual(["Cell division"]);
    // …and cannot be addressed.
    expect(failure(await library.listMaterials("Linked subject")).code).toBe("outside-library");
    expect(failure(await library.deleteSubject("Linked subject")).code).toBe("outside-library");
    expect(failure(await library.getMaterial({ subject: "Biology", material: "Linked material" })).code).toBe("outside-library");
    expect(failure(await library.removeFile({ subject: "Biology", material: "Linked material" }, "secret.pdf")).code).toBe("outside-library");

    // files/ replaced by a link to somewhere else: nothing is read from it or copied into it.
    await rm(path.join(root, ref.subject, ref.material, "files"), { recursive: true });
    await symlink(path.join(outside, "Material", "files"), path.join(root, ref.subject, ref.material, "files"), "junction");
    expect(failure(await library.getMaterial(ref)).code).toBe("outside-library");
    expect(failure(await library.addFiles(ref, [await source("a.pdf", PDF)])).code).toBe("outside-library");
    expect(failure(await library.addPhotoSet(ref, [JPEG])).code).toBe("outside-library");
    expect(failure(await library.removeFile(ref, "secret.pdf")).code).toBe("outside-library");

    expect(await readdir(path.join(outside, "Material", "files"))).toEqual(["secret.pdf"]);
    expect(trashed).toEqual([]);
  });

  it("does not address a link that points to another place inside the library either", async () => {
    await newMaterial();
    await symlink(path.join(root, "Biology"), path.join(root, "Alias"), "junction");
    expect(value(await library.listSubjects()).map((s) => s.id)).toEqual(["Biology"]);
    expect(failure(await library.deleteSubject("Alias")).code).toBe("not-found");
    expect(existsSync(path.join(root, "Biology", "Cell division"))).toBe(true);
  });
});

describe("addFiles", () => {
  it("copies PDFs and .pptx files in, in order, and leaves the sources alone", async () => {
    const ref = await newMaterial();
    const pdf = await source("chapter-3.pdf", PDF);
    const pptx = await source("Slides.PPTX", PPTX);

    const outcome = value(await library.addFiles(ref, [pdf, pptx]));
    expect(outcome.rejected).toEqual([]);
    expect(outcome.added).toEqual([
      { name: "chapter-3.pdf", kind: "pdf", size: PDF.length },
      { name: "Slides.pptx", kind: "pptx", size: PPTX.length },
    ]);
    expect(outcome.material.files).toEqual(outcome.added);
    expect(outcome.material.fileCount).toBe(2);

    const files = path.join(root, ref.subject, ref.material, "files");
    expect((await readdir(files)).sort()).toEqual(["Slides.pptx", "chapter-3.pdf"]);
    expect(await readFile(path.join(files, "chapter-3.pdf"))).toEqual(PDF);
    expect(await readFile(pdf)).toEqual(PDF);
    expect(existsSync(pptx)).toBe(true);
    await expectJsonMatchesFolder(ref);
  });

  it("rejects everything else with a sentence, and still adds the good ones", async () => {
    const ref = await newMaterial();
    const outcome = value(
      await library.addFiles(ref, [
        await source("essay.docx", "PK\u0003\u0004 a word file"),
        await source("old.ppt", "x"),
        await source("photo.jpg", JPEG),
        await source("fake.pdf", "this is plain text, not a pdf"),
        await source("fake.pptx", PDF),
        await source("empty.pdf", ""),
        await source("noextension", PDF),
        path.join(sources, "missing.pdf"),
        sources, // a folder
        "relative.pdf",
        42 as never,
        await source("good.pdf", PDF),
      ]),
    );
    expect(outcome.added.map((file) => file.name)).toEqual(["good.pdf"]);
    expect(outcome.rejected.map((file) => file.name)).toEqual([
      "essay.docx", "old.ppt", "photo.jpg", "fake.pdf", "fake.pptx", "empty.pdf", "noextension", "missing.pdf", "sources", "relative.pdf", "Unknown file",
    ]);
    for (const { reason } of outcome.rejected) {
      expect(reason).not.toContain(sandbox);
      expect(reason).toMatch(/^[A-Z].*\.$/);
    }
    expect(outcome.rejected[1]!.reason).toContain(".pptx");
    expect(outcome.rejected[3]!.reason).toContain("does not look like a real PDF");
    await expectJsonMatchesFolder(ref);
    expect(await readdir(path.join(root, ref.subject, ref.material, "files"))).toEqual(["good.pdf"]);
  });

  it("accepts a PDF whose header is not at the very first byte", async () => {
    const ref = await newMaterial();
    const outcome = value(await library.addFiles(ref, [await source("scanner.pdf", Buffer.concat([Buffer.from("\r\n\r\n"), PDF]))]));
    expect(outcome.added).toHaveLength(1);
  });

  it("rejects a file above the size ceiling without copying it", async () => {
    const ref = await newMaterial();
    const big = path.join(sources, "big.pdf");
    const { open } = await import("node:fs/promises");
    const handle = await open(big, "w");
    await handle.write(PDF, 0, PDF.length, 0);
    await handle.truncate(MAX_FILE_BYTES + 1); // sparse: no real data is written
    await handle.close();

    const outcome = value(await library.addFiles(ref, [big]));
    expect(outcome.added).toEqual([]);
    expect(outcome.rejected[0]!.reason).toContain("too large");
    // The same ceiling as the text reader's: what the library takes, the app can read.
    expect(MAX_FILE_BYTES).toBe(MAX_INPUT_BYTES);
    expect(outcome.rejected[0]!.reason).toBe("This file is too large. The largest file Studiplan takes is 100 MB.");
    expect(await readdir(path.join(root, ref.subject, ref.material, "files"))).toEqual([]);
  });

  it("never overwrites: a second file of the same name gets a suffix", async () => {
    const ref = await newMaterial();
    const first = await source("notes.pdf", PDF);
    value(await library.addFiles(ref, [first]));
    const other = Buffer.concat([PDF, Buffer.from("different")]);
    const second = await source("NOTES.pdf", other);
    const outcome = value(await library.addFiles(ref, [second, second]));
    expect(outcome.added.map((file) => file.name)).toEqual(["NOTES-2.pdf", "NOTES-3.pdf"]);

    const files = path.join(root, ref.subject, ref.material, "files");
    expect(await readFile(path.join(files, "notes.pdf"))).toEqual(PDF);
    expect(await readFile(path.join(files, "NOTES-2.pdf"))).toEqual(other);
    expect((await metaOf(ref)).files).toEqual(["notes.pdf", "NOTES-2.pdf", "NOTES-3.pdf"]);
  });

  it("sanitises the stored name", async () => {
    const ref = await newMaterial();
    const outcome = value(
      await library.addFiles(ref, [
        await source("con.pdf", PDF).catch(() => source("con_.pdf", PDF)),
        await source("  spaced   name .pdf", PDF),
        await source(`${"long".repeat(40)}.pdf`, PDF),
        await source("数学 ノート.pdf", PDF),
      ]),
    );
    const names = outcome.added.map((file) => file.name);
    expect(names[1]).toBe("spaced name.pdf");
    expect(names[2]).toHaveLength(80);
    expect(names[3]).toBe("数学 ノート.pdf");
    await expectJsonMatchesFolder(ref);
  });

  it("leaves no half-copied file and no stale json when the json cannot be written", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("first.pdf", PDF)]));
    const dir = path.join(root, ref.subject, ref.material);
    // Make the json impossible to replace: a non-empty folder stands in its place.
    await rm(path.join(dir, "material.json"));
    await mkdir(path.join(dir, "material.json", "blocker"), { recursive: true });

    const result = await library.addFiles(ref, [await source("second.pdf", PDF)]);
    expect(failure(result).code).toBe("io");
    expect(logged.length).toBeGreaterThan(0);
    // The copy was taken back, and no temporary file is left anywhere.
    expect(await readdir(path.join(dir, "files"))).toEqual(["first.pdf"]);
    expect((await readdir(dir)).sort()).toEqual(["files", "material.json", "sets"]);

    const photos = await library.addPhotoSet(ref, [JPEG]);
    expect(failure(photos).code).toBe("io");
    expect(await readdir(path.join(dir, "files"))).toEqual(["first.pdf"]);
  });

  it("takes an empty list and refuses an absurdly long one", async () => {
    const ref = await newMaterial();
    expect(value(await library.addFiles(ref, []))).toMatchObject({ added: [], rejected: [] });
    expect(failure(await library.addFiles(ref, new Array<string>(201).fill("C:\\a.pdf"))).code).toBe("too-large");
    expect(failure(await library.addFiles({ subject: "Biology", material: "Gone" }, [])).code).toBe("not-found");
  });
});

describe("photo sets", () => {
  it("stores pages in order under notes-<local date>, then -2, -3", async () => {
    const ref = await newMaterial();
    const second = Buffer.concat([JPEG, Buffer.from([1, 2, 3])]);
    const outcome = value(await library.addPhotoSet(ref, [new Uint8Array(JPEG), new Uint8Array(second), JPEG]));

    expect(outcome.rejected).toEqual([]);
    expect(outcome.added).toEqual([
      {
        name: "notes-2026-10-02",
        kind: "photo-set",
        size: JPEG.length * 2 + second.length,
        pages: ["page-1.jpg", "page-2.jpg", "page-3.jpg"],
      },
    ]);
    const set = path.join(root, ref.subject, ref.material, "files", "notes-2026-10-02");
    expect(await readFile(path.join(set, "page-2.jpg"))).toEqual(second);

    expect(value(await library.addPhotoSet(ref, [JPEG])).added[0]!.name).toBe("notes-2026-10-02-2");
    expect(value(await library.addPhotoSet(ref, [JPEG])).added[0]!.name).toBe("notes-2026-10-02-3");
    expect((await metaOf(ref)).files).toEqual(["notes-2026-10-02", "notes-2026-10-02-2", "notes-2026-10-02-3"]);
    expect(value(await library.listMaterials("Biology"))[0]!.fileCount).toBe(3);
    await expectJsonMatchesFolder(ref);
  });

  it("orders more than nine pages by number", async () => {
    const ref = await newMaterial();
    const outcome = value(await library.addPhotoSet(ref, new Array<Uint8Array>(11).fill(JPEG)));
    expect(outcome.added[0]!.pages).toEqual(Array.from({ length: 11 }, (_, index) => `page-${index + 1}.jpg`));
  });

  it("accepts an ArrayBuffer as well as a typed array", async () => {
    const ref = await newMaterial();
    const buffer = new Uint8Array(JPEG).buffer;
    expect(value(await library.addPhotoSet(ref, [buffer as never])).added[0]!.size).toBe(JPEG.length);
  });

  it("rejects the whole set, writing nothing, if any page is not a JPEG, too big, or there are too many", async () => {
    const ref = await newMaterial();
    const files = path.join(root, ref.subject, ref.material, "files");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

    expect(failure(await library.addPhotoSet(ref, [])).code).toBe("unsupported-file");
    const notJpeg = failure(await library.addPhotoSet(ref, [JPEG, png]));
    expect(notJpeg.code).toBe("unsupported-file");
    expect(notJpeg.message).toContain("Photo 2");
    expect(failure(await library.addPhotoSet(ref, [new Uint8Array(0)])).code).toBe("unsupported-file");
    expect(failure(await library.addPhotoSet(ref, [PDF])).code).toBe("unsupported-file");

    const huge = new Uint8Array(MAX_PHOTO_BYTES + 1);
    huge.set(JPEG);
    expect(failure(await library.addPhotoSet(ref, [JPEG, huge])).code).toBe("too-large");
    expect(failure(await library.addPhotoSet(ref, new Array<Uint8Array>(MAX_PHOTO_PAGES + 1).fill(JPEG))).code).toBe("too-large");

    expect(await readdir(files)).toEqual([]);
    expect((await metaOf(ref)).files).toEqual([]);
  });
});

describe("removeFile", () => {
  it("removes a file or a whole photo set and keeps the json in step", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("a.pdf", PDF), await source("b.pptx", PPTX)]));
    value(await library.addPhotoSet(ref, [JPEG, JPEG]));

    const afterFile = value(await library.removeFile(ref, "a.pdf"));
    expect(afterFile.files.map((file) => file.name)).toEqual(["b.pptx", "notes-2026-10-02"]);
    await expectJsonMatchesFolder(ref);

    const afterSet = value(await library.removeFile(ref, "notes-2026-10-02"));
    expect(afterSet.files.map((file) => file.name)).toEqual(["b.pptx"]);
    expect(afterSet.fileCount).toBe(1);
    await expectJsonMatchesFolder(ref);
    expect(trashed.map((target) => path.basename(target))).toEqual(["a.pdf", "notes-2026-10-02"]);
  });

  it("only removes what a list would show", async () => {
    const ref = await newMaterial();
    const files = path.join(root, ref.subject, ref.material, "files");
    await writeFile(path.join(files, "desktop.ini"), "x");
    await writeFile(path.join(files, "essay.docx"), "x");
    expect(failure(await library.removeFile(ref, "missing.pdf")).code).toBe("not-found");
    expect(failure(await library.removeFile(ref, "desktop.ini")).code).toBe("not-found");
    expect(failure(await library.removeFile(ref, "essay.docx")).code).toBe("not-found");
    expect((await readdir(files)).sort()).toEqual(["desktop.ini", "essay.docx"]);
  });

  it("keeps the file and the json when the recycle bin refuses", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("a.pdf", PDF)]));
    trashFails = true;
    const error = failure(await library.removeFile(ref, "a.pdf"));
    expect(error.code).toBe("io");
    expect(error.message).toContain("could not be moved to the Recycle Bin");
    expect((await metaOf(ref)).files).toEqual(["a.pdf"]);
    await expectJsonMatchesFolder(ref);
  });
});

describe("lookups for the rest of the main process", () => {
  it("finds a document and a photo page, with what is needed to tell a changed file", async () => {
    const ref = await newMaterial();
    value(await library.addFiles(ref, [await source("a.pdf", PDF), await source("s.pptx", PPTX)]));
    const set = value(await library.addPhotoSet(ref, [JPEG])).added[0]!;
    const files = path.join(root, ref.subject, ref.material, "files");

    const pdf = value(await library.locateFile(ref, "a.pdf"));
    expect(pdf).toMatchObject({ path: path.join(files, "a.pdf"), kind: "pdf", size: PDF.length });
    expect(pdf.mtimeMs).toBeGreaterThan(0);
    expect(value(await library.locateFile(ref, "s.pptx")).kind).toBe("pptx");
    expect(value(await library.locateFile(ref, set.name, "page-1.jpg"))).toMatchObject({
      path: path.join(files, set.name, "page-1.jpg"),
      kind: "photo-page",
      size: JPEG.length,
    });

    expect(failure(await library.locateFile(ref, set.name)).code).toBe("unsupported-file");
    expect(failure(await library.locateFile(ref, "a.pdf", "page-1.jpg")).code).toBe("not-found");
    expect(failure(await library.locateFile(ref, set.name, "page-1.png")).code).toBe("unsupported-file");
    expect(failure(await library.locateFile(ref, "gone.pdf")).code).toBe("not-found");
    expect(failure(await library.locateFile(ref, "../a.pdf")).code).toBe("outside-library");
    expect(failure(await library.locateFile(ref, 7)).code).toBe("invalid-request");
    expect(failure(await library.locateFile("Biology", "a.pdf")).code).toBe("invalid-request");
  });

  it("finds the folder of the library, of a subject and of a material, and nothing else", async () => {
    const ref = await newMaterial();
    expect(value(await library.locateFolder())).toBe(root);
    expect(value(await library.locateFolder(null))).toBe(root);
    expect(value(await library.locateFolder({ subject: ref.subject }))).toBe(path.join(root, ref.subject));
    expect(value(await library.locateFolder(ref))).toBe(path.join(root, ref.subject, ref.material));

    expect(failure(await library.locateFolder({ subject: "Physics" })).code).toBe("not-found");
    expect(failure(await library.locateFolder({ subject: ref.subject, material: "Nope" })).code).toBe("not-found");
    expect(failure(await library.locateFolder({ subject: ".." })).code).toBe("outside-library");
    expect(failure(await library.locateFolder({ subject: ref.subject, material: "..\\.." })).code).toBe("outside-library");
    expect(failure(await library.locateFolder(sandbox)).code).toBe("invalid-request");
    expect(failure(await library.locateFolder({})).code).toBe("invalid-request");
    expect(failure(await library.locateFolder({ subject: 5 })).code).toBe("invalid-request");
  });

  it("reports arguments of the wrong type as invalid-request, not as a disk problem", async () => {
    expect(failure(await library.createSubject(5 as unknown as string)).code).toBe("invalid-request");
    expect(failure(await library.getMaterial("Biology" as unknown as MaterialRef)).code).toBe("invalid-request");
    expect(failure(await library.addFiles(await newMaterial(), "a.pdf" as unknown as string[])).code).toBe("invalid-request");
    expect(logged).toEqual([]);
  });
});

describe("errors and ordering", () => {
  it("turns an unexpected error into `io` with a generic sentence and logs the real one", async () => {
    const broken = createLibrary({
      root: () => {
        throw new Error(`secret detail at ${sandbox}`);
      },
      trash: async () => {},
      log: (error) => logged.push(error),
    });
    const error = failure(await broken.listSubjects());
    expect(error).toEqual({ code: "io", message: "Something went wrong while reading or writing the library. Try again." });
    expect(String(logged[0])).toContain("secret detail");
  });

  it("runs calls one after another, so simultaneous creates cannot both win", async () => {
    const results = await Promise.all([
      library.createSubject("Biology"),
      library.createSubject("biology"),
      library.createSubject("BIOLOGY"),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false, false]);

    const ref = await newMaterial("Biology", "Cells");
    const pdf = await source("same.pdf", PDF);
    const adds = await Promise.all([library.addFiles(ref, [pdf]), library.addFiles(ref, [pdf]), library.addPhotoSet(ref, [JPEG])]);
    expect(adds.every((result) => result.ok)).toBe(true);
    expect((await metaOf(ref)).files).toEqual(["same.pdf", "same-2.pdf", "notes-2026-10-02"]);
    await expectJsonMatchesFolder(ref);
  });
});

describe("what the page may hand over", () => {
  it("refuses network and device paths before touching them, with a sentence", async () => {
    const ref = await newMaterial();
    const started = Date.now();
    const outcome = value(
      await library.addFiles(ref, [
        "\\\\server.invalid\\share\\a.pdf",
        "//server.invalid/share/a.pptx",
        "\\\\?\\C:\\Windows\\a.pdf",
        "\\\\.\\pipe\\x.pdf",
        "\\\\?\\UNC\\server.invalid\\share\\a.pdf",
      ]),
    );
    // No sign-in to another computer was tried: that takes seconds, this takes none.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.added).toEqual([]);
    expect(outcome.rejected).toHaveLength(5);
    for (const rejected of outcome.rejected) {
      expect(rejected.reason).toBe("Files on a network location cannot be added. Copy the file to this computer first.");
    }
    // A file on a drive of this computer is still added.
    expect(value(await library.addFiles(ref, [await source("a.pdf", PDF)])).added).toHaveLength(1);
  });

  it("refuses an endless name before tidying it", async () => {
    expect(failure(await library.createSubject(".".repeat(200_000))).code).toBe("invalid-name");
    expect(failure(await library.createSubject(` ${".".repeat(200_000)}x`)).code).toBe("invalid-name");
    value(await library.createSubject("Biology"));
    expect(failure(await library.createMaterial("Biology", `${" ".repeat(200_000)}.`)).code).toBe("invalid-name");
    // Refused by its length, before any pattern runs over it: the time does not grow with its square.
    const growth = await growthOfAsync(
      (size) => `${" ".repeat(size)}.`,
      (title) => library.createMaterial("Biology", title),
      200_000,
    );
    expect(growth).toMatchObject({ linear: true });
  });

  it("keeps both files when two with the same name are added at the same moment", async () => {
    const ref = await newMaterial();
    const other = path.join(sandbox, "other");
    await mkdir(other);
    await writeFile(path.join(other, "notes.pdf"), Buffer.concat([PDF, Buffer.from("second")]));
    const [first, second] = await Promise.all([
      library.addFiles(ref, [await source("notes.pdf", PDF)]),
      library.addFiles(ref, [path.join(other, "notes.pdf")]),
    ]);
    const names = [...value(first).added, ...value(second).added].map((file) => file.name);
    expect(new Set(names).size).toBe(2);
    const stored = (await readdir(path.join(root, "Biology", "Cell division", "files"))).sort();
    expect(stored).toEqual([...names].sort());
    const sizes = await Promise.all(stored.map(async (name) => (await stat(path.join(root, "Biology", "Cell division", "files", name))).size));
    expect(sizes.sort()).toEqual([PDF.length, PDF.length + 6].sort());
  });
});

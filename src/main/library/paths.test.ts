import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryFailure } from "./errors";
import { isInside, resolveInside } from "./paths";

let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-paths-")));
  root = path.join(sandbox, "library");
  outside = path.join(sandbox, "outside");
  await mkdir(path.join(root, "Biology", "Cells", "files"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function expectOutside(...segments: unknown[]): Promise<void> {
  const error = await resolveInside(root, ...segments).then(
    (value) => value,
    (thrown: unknown) => thrown,
  );
  expect(error, JSON.stringify(segments)).toBeInstanceOf(LibraryFailure);
  expect((error as LibraryFailure).code).toBe("outside-library");
  // The sentence shown to the user never contains a path.
  expect((error as LibraryFailure).message).not.toContain(sandbox);
}

/** A directory link that needs no special rights on Windows (a junction) and works elsewhere too. */
async function linkDir(target: string, at: string): Promise<void> {
  await symlink(target, at, "junction");
}

describe("isInside", () => {
  it("compares whole segments, not text prefixes", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, "a", "b"))).toBe(true);
    expect(isInside(root, `${root}-other`)).toBe(false);
    expect(isInside(root, path.join(root, "..", "outside"))).toBe(false);
    expect(isInside(root, sandbox)).toBe(false);
    expect(isInside(root, path.join(root, "..notes"))).toBe(true);
  });
});

describe("resolveInside", () => {
  it("resolves names to a path under the root", async () => {
    expect(await resolveInside(root)).toBe(root);
    expect(await resolveInside(root, "Biology")).toBe(path.join(root, "Biology"));
    expect(await resolveInside(root, "Biology", "Cells", "files", "a.pdf")).toBe(
      path.join(root, "Biology", "Cells", "files", "a.pdf"),
    );
  });

  it("accepts a target that does not exist yet", async () => {
    expect(await resolveInside(root, "Chemistry", "New", "files")).toBe(path.join(root, "Chemistry", "New", "files"));
  });

  it("keeps Unicode names", async () => {
    expect(await resolveInside(root, "..notes", "...and more")).toBe(path.join(root, "..notes", "...and more"));
    expect(await resolveInside(root, "数学", "Übung é")).toBe(path.join(root, "数学", "Übung é"));
  });

  it("refuses parent references in every position", async () => {
    await expectOutside("..");
    await expectOutside("..", "outside");
    await expectOutside("Biology", "..");
    await expectOutside("Biology", "..", "..", "outside");
    await expectOutside("Biology", "Cells", "files", "..");
    await expectOutside(".");
    await expectOutside("Biology", ".");
  });

  it("refuses names that contain a separator of either kind", async () => {
    await expectOutside("../outside");
    await expectOutside("..\\outside");
    await expectOutside("Biology/Cells");
    await expectOutside("Biology\\Cells");
    await expectOutside("Biology", "Cells/../../../outside/secret.txt");
    await expectOutside("Biology", "Cells", "files", "..\\..\\..\\..\\outside\\secret.txt");
    await expectOutside("Biology/");
    await expectOutside("/");
    await expectOutside("\\");
  });

  it("refuses absolute paths, drive letters, UNC and device paths", async () => {
    await expectOutside(path.join(outside, "secret.txt"));
    await expectOutside(outside);
    await expectOutside("Biology", outside);
    await expectOutside("/etc/passwd");
    await expectOutside("C:\\Windows\\win.ini");
    await expectOutside("C:");
    await expectOutside("C:secret.txt");
    await expectOutside("\\\\server\\share");
    await expectOutside("\\\\?\\C:\\Windows");
    await expectOutside("\\\\.\\NUL");
    await expectOutside("file:///C:/Windows/win.ini");
  });

  it("refuses alternate data streams, device names and names Windows would rewrite", async () => {
    await expectOutside("Biology:stream");
    await expectOutside("Biology", "Cells", "files", "a.pdf::$DATA");
    await expectOutside("NUL");
    await expectOutside("Biology", "con.txt");
    await expectOutside("Biology.");
    await expectOutside("Biology ");
    await expectOutside(" Biology");
    await expectOutside("Biology", "..."); // would become the subject itself
  });

  it("refuses empty names, control characters and things that are not text", async () => {
    await expectOutside("");
    await expectOutside("Biology", "");
    await expectOutside("Bio\u0000logy");
    await expectOutside("Biology\n");
    await expectOutside(null);
    await expectOutside(undefined);
    await expectOutside(42);
    await expectOutside({ toString: () => "Biology" });
    await expectOutside(["Biology"]);
    await expectOutside("Biology", ["..", ".."]);
  });

  it("refuses URL-encoded and wildcard tricks rather than interpreting them", async () => {
    await expectOutside("*");
    await expectOutside("Bio?ogy");
    // Percent signs are ordinary characters: this is a literal name, and it stays inside.
    expect(await resolveInside(root, "%2e%2e")).toBe(path.join(root, "%2e%2e"));
  });

  it("refuses a link inside the library that points outside it", async () => {
    await linkDir(outside, path.join(root, "Escape"));
    await expectOutside("Escape");
    await expectOutside("Escape", "secret.txt");
    await expectOutside("Escape", "new-folder", "files");
  });

  it("refuses a link deeper down, and one that replaces `files`", async () => {
    await rm(path.join(root, "Biology", "Cells", "files"), { recursive: true });
    await linkDir(outside, path.join(root, "Biology", "Cells", "files"));
    await expectOutside("Biology", "Cells", "files");
    await expectOutside("Biology", "Cells", "files", "secret.txt");
    await expectOutside("Biology", "Cells", "files", "not-there-yet.pdf");
    // The material itself is still fine.
    expect(await resolveInside(root, "Biology", "Cells")).toBe(path.join(root, "Biology", "Cells"));
  });

  it("refuses a link that points at the folder above the library", async () => {
    await linkDir(sandbox, path.join(root, "Up"));
    await expectOutside("Up");
    await expectOutside("Up", "outside", "secret.txt");
  });

  it("allows a link that stays inside the library", async () => {
    await linkDir(path.join(root, "Biology"), path.join(root, "Alias"));
    expect(await resolveInside(root, "Alias", "Cells")).toBe(path.join(root, "Alias", "Cells"));
  });

  it("works when the root itself is reached through a link", async () => {
    const linkedRoot = path.join(sandbox, "linked-library");
    await linkDir(root, linkedRoot);
    expect(await resolveInside(linkedRoot, "Biology")).toBe(path.join(linkedRoot, "Biology"));
    await linkDir(outside, path.join(root, "Escape"));
    await expect(resolveInside(linkedRoot, "Escape")).rejects.toMatchObject({ code: "outside-library" });
  });

  it("refuses a root that is not absolute, and fails for a root that does not exist", async () => {
    await expect(resolveInside("relative/library", "Biology")).rejects.toMatchObject({ code: "outside-library" });
    await expect(resolveInside(path.join(sandbox, "nowhere"), "Biology")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not confuse a sibling folder whose name starts with the root's name", async () => {
    await mkdir(`${root}-backup`);
    await linkDir(`${root}-backup`, path.join(root, "Backup"));
    await expectOutside("Backup");
  });
});

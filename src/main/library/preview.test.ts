import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewUrl } from "@shared/preview";
import { createLibrary } from "./library";
import { createPreviewHandler, parseRange } from "./preview";

let sandbox: string;
let root: string;
let outside: string;
let handle: (request: Request) => Promise<Response>;

const ref = { subject: "Biology", material: "Cell division" };
const PDF = Buffer.from("%PDF-1.7\n0123456789abcdefghijklmnopqrstuvwxyz\n%%EOF\n", "latin1");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);
const SECRET = "secret outside the library";

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-preview-")));
  root = path.join(sandbox, "library");
  outside = path.join(sandbox, "outside");
  const files = path.join(root, ref.subject, ref.material, "files");
  await mkdir(path.join(files, "notes-2026-10-02"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, ref.subject, ref.material, "material.json"), "{}");
  await writeFile(path.join(files, "chapter-3.pdf"), PDF);
  await writeFile(path.join(files, "Skript 50% #2.pdf"), PDF);
  await writeFile(path.join(files, "slides.pptx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  await writeFile(path.join(files, "essay.docx"), "not a kind the library lists");
  await writeFile(path.join(files, ".hidden.pdf"), PDF);
  await writeFile(path.join(files, "notes-2026-10-02", "page-1.jpg"), JPEG);
  await writeFile(path.join(files, "notes-2026-10-02", "scan.png"), "png");
  await writeFile(path.join(files, "notes-2026-10-02", ".page-9.jpg"), JPEG);
  await writeFile(path.join(files, "notes-2026-10-02", "inner.pdf"), PDF);
  await writeFile(path.join(outside, "secret.pdf"), SECRET);
  await writeFile(path.join(outside, "page-1.jpg"), SECRET);

  const library = createLibrary({
    root: () => ({ root, isDefault: false, fixedByEnvironment: false }),
    trash: async () => {},
    log: () => {},
  });
  handle = createPreviewHandler(library);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const get = (url: string, init: RequestInit = {}): Promise<Response> => handle(new Request(url, init));

async function expectRefused(url: string, status?: number): Promise<void> {
  const response = await get(url);
  expect(response.status, url).toBeGreaterThanOrEqual(400);
  if (status !== undefined) expect(response.status, url).toBe(status);
  const text = await response.text();
  expect(text, url).not.toContain(SECRET);
  // A refusal never says where anything is.
  expect(text, url).not.toContain(sandbox);
  expect(response.headers.get("content-type"), url).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("x-content-type-options"), url).toBe("nosniff");
}

describe("the preview handler", () => {
  it("serves a PDF with its type, its length and nosniff", async () => {
    const response = await get(previewUrl(ref, "chapter-3.pdf"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe(String(PDF.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);
  });

  it("serves a file whose name needs encoding", async () => {
    const response = await get(previewUrl(ref, "Skript 50% #2.pdf"));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);
  });

  it("serves a page of a photo set as a JPEG", async () => {
    const response = await get(previewUrl(ref, "notes-2026-10-02", "page-1.jpg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
  });

  it("answers a range request with that part only", async () => {
    const response = await get(previewUrl(ref, "chapter-3.pdf"), { headers: { Range: "bytes=9-18" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 9-18/${PDF.length}`);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");

    const tail = await get(previewUrl(ref, "chapter-3.pdf"), { headers: { Range: "bytes=-6" } });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe("%%EOF\n");

    const beyond = await get(previewUrl(ref, "chapter-3.pdf"), { headers: { Range: "bytes=99999-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${PDF.length}`);
  });

  it("answers HEAD without a body and refuses every other method", async () => {
    const head = await get(previewUrl(ref, "chapter-3.pdf"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PDF.length));
    expect(await head.text()).toBe("");

    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await get(previewUrl(ref, "chapter-3.pdf"), { method });
      expect(response.status, method).toBe(405);
    }
  });

  it("refuses what the library does not show", async () => {
    // A .pptx is read as text, never served; other kinds are not in the library at all.
    await expectRefused(previewUrl(ref, "slides.pptx"), 404);
    await expectRefused(previewUrl(ref, "essay.docx"), 404);
    await expectRefused(previewUrl(ref, "material.json"), 404);
    // A photo set is not one file.
    await expectRefused(previewUrl(ref, "notes-2026-10-02"), 404);
    // Inside a photo set only .jpg pages.
    await expectRefused(previewUrl(ref, "notes-2026-10-02", "scan.png"), 404);
    await expectRefused(previewUrl(ref, "notes-2026-10-02", "inner.pdf"), 404);
    // A PDF is not a folder with pages.
    await expectRefused(previewUrl(ref, "chapter-3.pdf", "page-1.jpg"), 404);
    // Missing things.
    await expectRefused(previewUrl(ref, "nothing.pdf"), 404);
    await expectRefused(previewUrl(ref, "notes-2026-10-02", "page-2.jpg"), 404);
    await expectRefused(previewUrl({ subject: "Physics", material: "x" }, "a.pdf"), 404);
  });

  it("refuses hidden files", async () => {
    await expectRefused(previewUrl(ref, ".hidden.pdf"), 404);
    await expectRefused(previewUrl(ref, "notes-2026-10-02", ".page-9.jpg"), 404);
    await expectRefused(previewUrl({ subject: ".git", material: "x" }, "a.pdf"), 404);
  });

  it("refuses traversal, however it is written", async () => {
    const base = "studiplan-file://library/Biology/Cell%20division";
    // Plain and encoded dot segments: folded away by URL parsing, leaving a URL that names nothing.
    await expectRefused(`${base}/../../../outside/secret.pdf`);
    await expectRefused(`${base}/%2e%2e/%2e%2e/outside/secret.pdf`);
    await expectRefused("studiplan-file://library/../outside/secret.pdf");
    // Encoded separators inside one segment.
    await expectRefused(`${base}/..%2F..%2F..%2Foutside%2Fsecret.pdf`, 400);
    await expectRefused(`${base}/..%5C..%5C..%5Coutside%5Csecret.pdf`, 400);
    await expectRefused(`${base}/notes-2026-10-02/..%2Fchapter-3.pdf`, 400);
    // Names built by the helper that are not clean segments.
    await expectRefused(previewUrl({ subject: "..", material: "outside" }, "secret.pdf"));
    await expectRefused(previewUrl(ref, "..", "secret.pdf"));
    await expectRefused(previewUrl(ref, "notes-2026-10-02", ".."));
    // An absolute path, a drive letter, a device name, a trailing dot.
    await expectRefused(previewUrl(ref, path.join(outside, "secret.pdf")), 400);
    await expectRefused(previewUrl(ref, "C:secret.pdf"), 403);
    await expectRefused(previewUrl(ref, "NUL.pdf"), 403);
    await expectRefused(previewUrl(ref, "chapter-3.pdf."), 403);
    // Another host, a query.
    await expectRefused("studiplan-file://outside/Biology/Cell%20division/chapter-3.pdf", 400);
    await expectRefused(`${base}/chapter-3.pdf?x=1`, 400);
  });

  it("refuses a junction that points out of the library", async () => {
    const files = path.join(root, ref.subject, ref.material, "files");
    // A photo set, a material and a subject that are really links to a folder outside.
    await symlink(outside, path.join(files, "linked-set"), "junction");
    await symlink(outside, path.join(root, ref.subject, "Linked material"), "junction");
    await symlink(outside, path.join(root, "Linked subject"), "junction");
    await mkdir(path.join(outside, "files"));
    await writeFile(path.join(outside, "files", "secret.pdf"), SECRET);

    await expectRefused(previewUrl(ref, "linked-set", "page-1.jpg"));
    await expectRefused(previewUrl({ subject: ref.subject, material: "Linked material" }, "secret.pdf"));
    await expectRefused(previewUrl({ subject: "Linked subject", material: "files" }, "secret.pdf"));
  });

  it("refuses a link to a file, even one that stays inside the library", async () => {
    const files = path.join(root, ref.subject, ref.material, "files");
    try {
      await symlink(path.join(outside, "secret.pdf"), path.join(files, "linked.pdf"), "file");
      await symlink(path.join(files, "chapter-3.pdf"), path.join(files, "alias.pdf"), "file");
    } catch {
      // Creating a file link needs a right this Windows account does not have. Junctions,
      // which need none, are covered above.
      return;
    }
    await expectRefused(previewUrl(ref, "linked.pdf"));
    await expectRefused(previewUrl(ref, "alias.pdf"));
  });
});

describe("parseRange", () => {
  it("reads the three forms", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("ignores what it does not understand and refuses what lies outside", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=9-3", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

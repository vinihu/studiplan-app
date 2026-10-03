import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractErrorCode, ExtractResult, TextFileKind } from "../extract/types";
import { makePdf, makePptx, textStream } from "../extract/fixtures";
import { createLibrary } from "./library";
import type { LibraryService } from "./library";
import { createTextReader } from "./text";

let sandbox: string;
let files: string;
let library: LibraryService;

const ref = { subject: "Biology", material: "Cells" };

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-text-")));
  const root = path.join(sandbox, "library");
  files = path.join(root, ref.subject, ref.material, "files");
  await mkdir(path.join(files, "notes"), { recursive: true });
  await writeFile(path.join(files, "notes", "page-1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  library = createLibrary({
    root: () => ({ root, isDefault: false, fixedByEnvironment: false }),
    trash: async () => {},
    log: () => {},
  });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function ok(text: string, kind: TextFileKind = "pdf"): ExtractResult {
  return {
    ok: true,
    value: {
      kind,
      unit: kind === "pdf" ? "page" : "slide",
      totalCount: 3,
      sections: [{ number: 1, title: null, body: text, notes: null }],
      stopped: "count-limit",
      textlessCount: 0,
      formulasLost: false,
      text,
    },
  };
}

function failing(code: ExtractErrorCode): ExtractResult {
  return { ok: false, error: { code, message: `The sentence for ${code}.` } };
}

/** A reader whose extraction is counted and can be held back. */
function counted(answer: (kind: TextFileKind, file: string) => ExtractResult | Promise<ExtractResult>, limits = {}) {
  const calls: string[] = [];
  const reader = createTextReader({
    locateFile: (r, name) => library.locateFile(r, name),
    extract: async (kind, file) => {
      calls.push(path.basename(file));
      return answer(kind, file);
    },
    ...limits,
  });
  return { reader, calls };
}

describe("the text reader", () => {
  it("reads a real .pptx and a real PDF through the extraction module", async () => {
    await writeFile(path.join(files, "slides.pptx"), await makePptx({ slides: { 1: { title: "Mitosis", body: ["Prophase comes first, then metaphase and anaphase."] } }, order: [1] }));
    await writeFile(path.join(files, "chapter.pdf"), makePdf([textStream(["Cells divide in a fixed order of phases, every time."])]));
    const reader = createTextReader({ locateFile: (r, name) => library.locateFile(r, name) });

    const deck = await reader.read(ref, "slides.pptx");
    expect(deck.ok && deck.value).toMatchObject({ name: "slides.pptx", kind: "pptx", unit: "slide", totalCount: 1, readCount: 1, stopped: null });
    expect(deck.ok && deck.value.text).toContain("Prophase comes first");
    expect(deck.ok && deck.value.text).toContain("## Slide 1: Mitosis");

    const pdf = await reader.read(ref, "chapter.pdf");
    expect(pdf.ok && pdf.value).toMatchObject({ name: "chapter.pdf", kind: "pdf", unit: "page", totalCount: 1, readCount: 1 });
    expect(pdf.ok && pdf.value.text).toContain("Cells divide in a fixed order");
  });

  it("passes on counts and why reading stopped", async () => {
    await writeFile(path.join(files, "a.pdf"), "x");
    const { reader } = counted(() => ok("hello"));
    expect(await reader.read(ref, "a.pdf")).toEqual({
      ok: true,
      value: { name: "a.pdf", kind: "pdf", unit: "page", totalCount: 3, readCount: 1, stopped: "count-limit", textlessCount: 0, formulasLost: false, text: "hello" },
    });
  });

  it("reads an unchanged file once, and a changed one again", async () => {
    const file = path.join(files, "a.pdf");
    await writeFile(file, "one");
    const { reader, calls } = counted(() => ok("text"));

    await reader.read(ref, "a.pdf");
    await reader.read(ref, "a.pdf");
    expect(calls).toHaveLength(1);

    // Another size.
    await writeFile(file, "longer than before");
    await reader.read(ref, "a.pdf");
    expect(calls).toHaveLength(2);

    // The same size, another modified time.
    await utimes(file, new Date(), new Date(Date.now() + 60_000));
    await reader.read(ref, "a.pdf");
    expect(calls).toHaveLength(3);
    await reader.read(ref, "a.pdf");
    expect(calls).toHaveLength(3);
  });

  it("shares one reading between calls made at the same time", async () => {
    await writeFile(path.join(files, "a.pdf"), "x");
    let release: (result: ExtractResult) => void = () => {};
    const { reader, calls } = counted(() => new Promise<ExtractResult>((resolve) => (release = resolve)));

    const first = reader.read(ref, "a.pdf");
    const second = reader.read(ref, "a.pdf");
    // Until the reading has started (the file is looked up on disk first), then a little longer
    // for a second one to show up if there were one.
    for (let round = 0; round < 200 && calls.length === 0; round += 1) await new Promise((done) => setTimeout(done, 10));
    await new Promise((done) => setTimeout(done, 30));
    expect(calls).toHaveLength(1);
    release(ok("shared"));
    expect(await first).toEqual(await second);
    expect((await first).ok).toBe(true);
  });

  it("maps every reason of the extraction module and keeps its sentence", async () => {
    await writeFile(path.join(files, "a.pdf"), "x");
    const expected: Record<ExtractErrorCode, string> = {
      unreadable: "io",
      "too-large": "too-large",
      "not-a-pdf": "damaged",
      "not-a-pptx": "damaged",
      corrupt: "damaged",
      "no-slides": "damaged",
      encrypted: "encrypted",
      "no-text": "no-text",
      timeout: "timed-out",
      cancelled: "cancelled",
    };
    for (const [code, mapped] of Object.entries(expected) as Array<[ExtractErrorCode, string]>) {
      const { reader } = counted(() => failing(code));
      expect(await reader.read(ref, "a.pdf"), code).toEqual({
        ok: false,
        error: { code: mapped, message: `The sentence for ${code}.` },
      });
    }
  });

  it("remembers a lasting failure but tries again after a passing one", async () => {
    await writeFile(path.join(files, "a.pdf"), "x");
    const lasting = counted(() => failing("no-text"));
    await lasting.reader.read(ref, "a.pdf");
    await lasting.reader.read(ref, "a.pdf");
    expect(lasting.calls).toHaveLength(1);

    for (const code of ["unreadable", "timeout", "cancelled"] as const) {
      const passing = counted(() => failing(code));
      await passing.reader.read(ref, "a.pdf");
      await passing.reader.read(ref, "a.pdf");
      expect(passing.calls, code).toHaveLength(2);
      expect(passing.reader.size, code).toBe(0);
    }
  });

  it("answers a cancelled caller at once and keeps the reading for the next one", async () => {
    await writeFile(path.join(files, "a.pdf"), "x");
    let release: (result: ExtractResult) => void = () => {};
    const { reader, calls } = counted(() => new Promise<ExtractResult>((resolve) => (release = resolve)));

    const controller = new AbortController();
    const waiting = reader.read(ref, "a.pdf", controller.signal);
    await new Promise((done) => setTimeout(done, 30));
    controller.abort();
    const cancelled = await waiting;
    expect(cancelled.ok ? null : cancelled.error.code).toBe("cancelled");

    release(ok("finished anyway"));
    const again = await reader.read(ref, "a.pdf");
    expect(again.ok && again.value.text).toBe("finished anyway");
    expect(calls).toHaveLength(1);

    const already = new AbortController();
    already.abort();
    const never = await reader.read(ref, "a.pdf", already.signal);
    expect(never.ok ? null : never.error.code).toBe("cancelled");
  });

  it("refuses what has no text or is not in the material, with the library's reasons", async () => {
    await writeFile(path.join(files, "essay.docx"), "x");
    const { reader, calls } = counted(() => ok("never"));
    const code = async (r: unknown, name: unknown) => {
      const result = await reader.read(r, name);
      return result.ok ? null : result.error.code;
    };
    expect(await code(ref, "notes")).toBe("unsupported-file");
    expect(await code(ref, "essay.docx")).toBe("unsupported-file");
    expect(await code(ref, "missing.pdf")).toBe("not-found");
    expect(await code(ref, "../../x.pdf")).toBe("outside-library");
    expect(await code(ref, 5)).toBe("invalid-request");
    expect(await code(null, "a.pdf")).toBe("invalid-request");
    expect(await code({ subject: "Biology" }, "a.pdf")).toBe("invalid-request");
    expect(calls).toEqual([]);
  });

  it("forgets the oldest results when it holds too many or too much", async () => {
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await writeFile(path.join(files, name), name);

    const byCount = counted(() => ok("text"), { maxEntries: 2 });
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await byCount.reader.read(ref, name);
    expect(byCount.reader.size).toBe(2);
    await byCount.reader.read(ref, "c.pdf");
    await byCount.reader.read(ref, "b.pdf");
    expect(byCount.calls).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    await byCount.reader.read(ref, "a.pdf");
    expect(byCount.calls).toEqual(["a.pdf", "b.pdf", "c.pdf", "a.pdf"]);

    const bySize = counted(() => ok("x".repeat(60)), { maxChars: 100 });
    for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await bySize.reader.read(ref, name);
    expect(bySize.reader.size).toBe(1);
  });
});

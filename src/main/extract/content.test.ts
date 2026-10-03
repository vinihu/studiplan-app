import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePdf, makePptx, textStream } from "./fixtures";
import {
  PROMPT_MAX_IMAGES,
  PROMPT_MAX_TEXT_CHARS,
  buildPromptContent,
  renderSections,
  shareBudget,
} from "./index";
import type { ExtractResult, ExtractedSection, MaterialFileInput, PromptContentOptions } from "./index";

/** A fake extracted file: `count` pages of `charsPerPage` characters each. */
function fakeDocument(kind: "pdf" | "pptx", count: number, charsPerPage: number, totalCount = count): ExtractResult {
  const unit = kind === "pdf" ? "page" : "slide";
  const sections: ExtractedSection[] = Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: null,
    body: "x".repeat(charsPerPage),
    notes: null,
  }));
  return {
    ok: true,
    value: {
      kind,
      unit,
      totalCount,
      sections,
      stopped: totalCount > count ? "count-limit" : null,
      textlessCount: 0,
      formulasLost: false,
      text: renderSections(unit, sections),
    },
  };
}

function extractorFor(results: Record<string, ExtractResult>): NonNullable<PromptContentOptions["extract"]> {
  return async (_kind, path) => {
    const result = results[path];
    if (!result) throw new Error(`no fake for ${path}`);
    return result;
  };
}

function textChars(content: Awaited<ReturnType<typeof buildPromptContent>>): number {
  return content.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}

let dir: string;
let photos: string[];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studiplan-content-"));
  photos = [];
  for (let page = 1; page <= 30; page += 1) {
    const path = join(dir, `page-${page}.jpg`);
    await writeFile(path, Buffer.alloc(1000, page));
    photos.push(path);
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shareBudget", () => {
  it("keeps everything when it fits", () => {
    expect(shareBudget([10, 20, 30], 100)).toEqual([10, 20, 30]);
  });

  it("keeps short files whole and splits the rest between the long ones", () => {
    expect(shareBudget([1000, 10, 1000, 20], 230)).toEqual([100, 10, 100, 20]);
  });

  it("does not let the first file eat the budget", () => {
    expect(shareBudget([500, 500, 500], 300)).toEqual([100, 100, 100]);
  });

  it("hands out odd units from the front and never exceeds the budget", () => {
    expect(shareBudget([9, 9, 9], 2)).toEqual([1, 1, 0]);
    expect(shareBudget([9, 9, 9], 20)).toEqual([7, 7, 6]);
    expect(shareBudget([5, 0, 5], 0)).toEqual([0, 0, 0]);
    expect(shareBudget([], 10)).toEqual([]);
  });
});

describe("buildPromptContent", () => {
  it("sends a small material whole, labelled by file name, in file order", async () => {
    const pdfPath = join(dir, "chapter.pdf");
    const deckPath = join(dir, "slides.pptx");
    await writeFile(
      pdfPath,
      makePdf([textStream(["Mitosis has four phases: prophase, metaphase, anaphase, telophase."])]),
    );
    await writeFile(
      deckPath,
      await makePptx({
        slides: { 1: { title: "Meiosis", body: ["Meiosis halves the chromosome number of a cell."] } },
        order: [1],
      }),
    );
    const content = await buildPromptContent([
      { name: "chapter.pdf", kind: "pdf", path: pdfPath },
      { name: "notes-2026-10-02", kind: "photo-set", pagePaths: photos.slice(0, 3) },
      { name: "slides.pptx", kind: "pptx", path: deckPath },
    ]);
    expect(content.complete).toBe(true);
    expect(content.notices).toEqual([]);
    expect(content.parts.map((part) => part.name)).toEqual(["chapter.pdf", "notes-2026-10-02", "slides.pptx"]);
    const [pdf, set, deck] = content.parts;
    expect(pdf?.type === "text" && pdf.text).toMatch(
      /^=== File: chapter\.pdf \(PDF, all 1 page\) ===\n\n## Page 1\n\nMitosis has four phases/,
    );
    expect(deck?.type === "text" && deck.text).toMatch(
      /^=== File: slides\.pptx \(PowerPoint, all 1 slide\) ===\n\n## Slide 1: Meiosis\n\nMeiosis halves/,
    );
    expect(set).toEqual({ type: "images", name: "notes-2026-10-02", paths: photos.slice(0, 3), totalCount: 3 });
    expect(content.totals).toEqual({ files: 3, textChars: textChars(content), images: 3, imageBytes: 3000 });
  });

  it("cuts a long file at a page boundary and says how many pages were sent", async () => {
    const files: MaterialFileInput[] = [{ name: "book.pdf", kind: "pdf", path: "book" }];
    const content = await buildPromptContent(files, {
      extract: extractorFor({ book: fakeDocument("pdf", 120, 5_000) }),
    });
    expect(content.complete).toBe(false);
    expect(textChars(content)).toBeLessThanOrEqual(PROMPT_MAX_TEXT_CHARS);
    const part = content.parts[0];
    if (part?.type !== "text") throw new Error("expected text");
    expect(part.sentCount).toBe(23);
    expect(part.totalCount).toBe(120);
    expect(part.truncated).toBe(true);
    expect(part.text.startsWith("=== File: book.pdf (PDF, pages 1-23 of 120) ===")).toBe(true);
    expect(part.text).toContain("## Page 23\n");
    expect(part.text).not.toContain("## Page 24");
    expect(content.notices).toEqual([
      {
        type: "text-cut",
        file: "book.pdf",
        unit: "page",
        sent: 23,
        total: 120,
        partial: false,
        message: 'Only the first 23 of 120 pages of "book.pdf" were sent.',
      },
    ]);
  });

  it("shares the budget fairly: short files whole, long files cut evenly", async () => {
    const files: MaterialFileInput[] = [
      { name: "huge-1.pdf", kind: "pdf", path: "huge-1" },
      { name: "short.pptx", kind: "pptx", path: "short" },
      { name: "huge-2.pdf", kind: "pdf", path: "huge-2" },
    ];
    const content = await buildPromptContent(files, {
      extract: extractorFor({
        "huge-1": fakeDocument("pdf", 300, 2_000),
        short: fakeDocument("pptx", 10, 500),
        "huge-2": fakeDocument("pdf", 300, 2_000),
      }),
    });
    expect(textChars(content)).toBeLessThanOrEqual(PROMPT_MAX_TEXT_CHARS);
    expect(textChars(content)).toBeGreaterThan(PROMPT_MAX_TEXT_CHARS * 0.9);
    const [first, short, second] = content.parts;
    if (first?.type !== "text" || short?.type !== "text" || second?.type !== "text") throw new Error("expected text");
    expect(short.truncated).toBe(false);
    expect(short.sentCount).toBe(10);
    expect(first.sentCount).toBe(second.sentCount);
    expect(first.sentCount).toBeGreaterThan(20);
    expect(content.notices.map((notice) => notice.file)).toEqual(["huge-1.pdf", "huge-2.pdf"]);
  });

  it("reports a file whose reading stopped early, even when all that was read is sent", async () => {
    const content = await buildPromptContent([{ name: "endless.pdf", kind: "pdf", path: "endless" }], {
      extract: extractorFor({ endless: fakeDocument("pdf", 4, 100, 9_000) }),
    });
    expect(content.notices[0]).toMatchObject({ type: "text-cut", sent: 4, total: 9_000 });
  });

  it("sends the start of a first page that alone is larger than the budget", async () => {
    const content = await buildPromptContent([{ name: "wall.pdf", kind: "pdf", path: "wall" }], {
      maxTextChars: 1_000,
      extract: extractorFor({ wall: fakeDocument("pdf", 3, 50_000) }),
    });
    const part = content.parts[0];
    if (part?.type !== "text") throw new Error("expected text");
    expect(part.text.length).toBeLessThanOrEqual(1_000);
    expect(part.text.length).toBeGreaterThan(800);
    expect(content.notices[0]).toMatchObject({ type: "text-cut", sent: 1, total: 3, partial: true });
    expect(content.limits.maxTextChars).toBe(1_000);
  });

  it("lists unreadable files instead of failing, and still sends the rest", async () => {
    const garbage = join(dir, "garbage.pdf");
    await writeFile(garbage, "not a pdf at all");
    const content = await buildPromptContent(
      [
        { name: "garbage.pdf", kind: "pdf", path: garbage },
        { name: "scan.pdf", kind: "pdf", path: "scan" },
        { name: "good.pdf", kind: "pdf", path: "good" },
        { name: "empty-set", kind: "photo-set", pagePaths: [] },
      ],
      {
        extract: async (kind, path, options) => {
          if (path === garbage) return (await import("./extract")).extractText(kind, path, options);
          if (path === "scan") {
            return { ok: false, error: { code: "no-text", message: "This PDF has no readable text." } };
          }
          return fakeDocument("pdf", 2, 100);
        },
      },
    );
    expect(content.parts.map((part) => part.name)).toEqual(["good.pdf"]);
    expect(content.complete).toBe(false);
    expect(content.notices.map((notice) => [notice.type, notice.file, "reason" in notice && notice.reason])).toEqual([
      ["file-skipped", "garbage.pdf", "not-a-pdf"],
      ["file-skipped", "scan.pdf", "no-text"],
      ["file-skipped", "empty-set", "empty"],
    ]);
    expect(content.notices[0]?.message).toMatch(/^"garbage\.pdf" was not sent\. This file is not a PDF/);
    for (const notice of content.notices) expect(notice.message).not.toContain(dir);
  });

  it("caps the photo count, shares it between sets, and says what was left out", async () => {
    const content = await buildPromptContent([
      { name: "lecture-1", kind: "photo-set", pagePaths: photos.slice(0, 25) },
      { name: "lecture-2", kind: "photo-set", pagePaths: photos.slice(25, 30) },
    ]);
    const [first, second] = content.parts;
    if (first?.type !== "images" || second?.type !== "images") throw new Error("expected images");
    expect(second.paths).toEqual(photos.slice(25, 30));
    expect(first.paths).toEqual(photos.slice(0, PROMPT_MAX_IMAGES - 5));
    expect(content.totals.images).toBe(PROMPT_MAX_IMAGES);
    expect(content.notices).toEqual([
      {
        type: "photos-left-out",
        file: "lecture-1",
        sent: 15,
        total: 25,
        message: '10 of 25 photos in "lecture-1" were left out.',
      },
    ]);
  });

  it("caps the photo bytes and skips pages that are gone", async () => {
    const byBytes = await buildPromptContent(
      [{ name: "notes", kind: "photo-set", pagePaths: photos.slice(0, 9) }],
      { maxImageBytes: 6_500 },
    );
    expect(byBytes.totals).toMatchObject({ images: 6, imageBytes: 6_000 });
    expect(byBytes.notices[0]?.message).toBe('3 of 9 photos in "notes" were left out.');

    const missing = await buildPromptContent([
      { name: "notes", kind: "photo-set", pagePaths: [photos[0] ?? "", join(dir, "gone.jpg")] },
    ]);
    expect(missing.notices[0]).toMatchObject({ type: "photos-left-out", sent: 1, total: 2 });

    const none = await buildPromptContent(
      [{ name: "notes", kind: "photo-set", pagePaths: photos.slice(0, 2) }],
      { maxImages: 0 },
    );
    expect(none.parts).toEqual([]);
    expect(none.notices[0]?.message).toBe('None of the 2 photos in "notes" could be sent.');
  });
});

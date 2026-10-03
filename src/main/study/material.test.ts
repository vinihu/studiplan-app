import { describe, expect, it } from "vitest";
import type { ContentNotice, PromptContent, PromptPart } from "../extract";
import type { LocatedMaterial } from "../library/library";
import { MAX_SCANNED_PAGES, MAX_SCANNED_PDF_BYTES, MIN_TEXT_CHARS, nothingReadableSentence, prepareMaterial } from "./material";

const FILES = "C:\\library\\Biology\\Cells\\files";

const material: LocatedMaterial = {
  id: "Cells",
  title: "Cells",
  identity: "1:1",
  filesDirectory: FILES,
  files: [
    { name: "script.pdf", kind: "pdf", path: `${FILES}\\script.pdf`, size: 1000 },
    { name: "scan-a.pdf", kind: "pdf", path: `${FILES}\\scan-a.pdf`, size: 2000 },
    { name: "notes", kind: "photo-set", pagePaths: [`${FILES}\\notes\\page-1.jpg`, `${FILES}\\notes\\page-2.jpg`], size: 500 },
    { name: "scan-b.pdf", kind: "pdf", path: `${FILES}\\scan-b.pdf`, size: 3000 },
    { name: "huge-scan.pdf", kind: "pdf", path: `${FILES}\\huge-scan.pdf`, size: MAX_SCANNED_PDF_BYTES + 1 },
    { name: "locked.pdf", kind: "pdf", path: `${FILES}\\locked.pdf`, size: 10 },
  ],
};

const noText = (file: string): ContentNotice => ({
  type: "file-skipped",
  file,
  reason: "no-text",
  message: `"${file}" was not sent. This PDF has no readable text.`,
});

function content(parts: PromptPart[], notices: ContentNotice[]): PromptContent {
  return {
    parts,
    notices,
    complete: notices.length === 0,
    totals: { files: material.files.length, textChars: 0, images: 0, imageBytes: 0 },
    limits: { maxTextChars: 1, maxImages: 1, maxImageBytes: 1 },
  };
}

const TEXT: PromptPart = {
  type: "text",
  name: "script.pdf",
  kind: "pdf",
  text: "=== File: script.pdf ===\n\nPage one.",
  unit: "page",
  sentCount: 1,
  totalCount: 3,
  truncated: true,
};
const IMAGES: PromptPart = { type: "images", name: "notes", paths: [`${FILES}\\notes\\page-1.jpg`], totalCount: 2 };

const CLAUDE = { label: "Claude Code", readsScannedPdfs: true, readsPdfPageRanges: true };

const NOTICES: ContentNotice[] = [
  { type: "text-cut", file: "script.pdf", unit: "page", sent: 1, total: 3, partial: false, message: 'Only the first 1 of 3 pages of "script.pdf" were sent.' },
  noText("scan-a.pdf"),
  { type: "photos-left-out", file: "notes", sent: 1, total: 2, message: '1 of 2 photos in "notes" was left out.' },
  noText("scan-b.pdf"),
  noText("huge-scan.pdf"),
  { type: "file-skipped", file: "locked.pdf", reason: "encrypted", message: '"locked.pdf" was not sent. This PDF is password-protected.' },
];

const pages: Record<string, number | null> = { "scan-a.pdf": 12, "scan-b.pdf": 30 };
const options = {
  buildContent: async () => content([TEXT, IMAGES], NOTICES),
  countPages: async (path: string) => pages[path.slice(FILES.length + 1)] ?? null,
};

describe("prepareMaterial", () => {
  it("sends text inline, photos as images and scans as files to an AI that can read them", async () => {
    const prepared = await prepareMaterial(material, CLAUDE, options);
    expect(prepared.parts).toEqual([
      { type: "text", text: TEXT.text },
      { type: "image", path: `${FILES}\\notes\\page-1.jpg` },
      { type: "file", path: `${FILES}\\scan-a.pdf` },
      { type: "file", path: `${FILES}\\scan-b.pdf` },
    ]);
    // The folder the tool may read is files/, not the material: no material.json, no sets/.
    expect(prepared.workingDirectory).toBe(FILES);
    expect(prepared.complete).toBe(false);
    expect(prepared.notices).toEqual([
      'Only the first 1 of 3 pages of "script.pdf" were sent.',
      '1 of 2 photos in "notes" was left out.',
      `Only the first ${MAX_SCANNED_PAGES - 12} of 30 pages of "scan-b.pdf" were sent. It is a scan, so Claude Code has to look at each page as a picture.`,
      '"huge-scan.pdf" was not sent. It is a scan (pages stored as pictures) and too large for Claude Code to read. Add photos of the pages instead.',
      '"locked.pdf" was not sent. This PDF is password-protected.',
    ]);
    expect(prepared.delivery).toMatch(/Scanned PDFs/);
    // The added instructions name no file: file names are the student's text.
    expect(prepared.delivery).not.toMatch(/scan-a|scan-b/);
    expect(prepared.counts).toMatchObject({ files: 6, images: 1, scannedPdfs: 2, notices: 5 });
  });

  it("leaves scans out for an AI that cannot read them, and says so", async () => {
    const prepared = await prepareMaterial(material, { label: "Ollama" }, options);
    expect(prepared.parts.map((part) => part.type)).toEqual(["text", "image"]);
    expect(prepared.notices).toEqual(NOTICES.map((notice) => notice.message));
    expect(prepared.delivery).toBeNull();
  });

  it("needs no folder when everything is text", async () => {
    const prepared = await prepareMaterial(material, CLAUDE, {
      buildContent: async () => content([{ ...TEXT, truncated: false }], []),
    });
    expect(prepared.workingDirectory).toBeUndefined();
    expect(prepared).toMatchObject({ complete: true, notices: [], delivery: null });
  });

  describe("a PDF that is mostly a scan", () => {
    const mostly = (file: string, textless: number, total: number): ContentNotice => ({
      type: "pages-without-text",
      file,
      textless,
      total,
      mostly: true,
      message: `"${file}" is mostly a scan: ${textless} of the ${total} pages have no readable text.`,
    });
    const notice = (text: PromptPart, notices: ContentNotice[]) => ({ buildContent: async () => content([text, IMAGES], notices), countPages: options.countPages });
    const SCAN_TEXT: PromptPart = { ...TEXT, name: "scan-a.pdf", text: "=== File: scan-a.pdf ===\n\nA library's notice.", truncated: false };

    it("goes to an AI that reads scans as the file itself, without its page of text", async () => {
      const prepared = await prepareMaterial(material, { label: "Claude Code", readsScannedPdfs: true }, notice(SCAN_TEXT, [mostly("scan-a.pdf", 11, 12)]));
      expect(prepared.parts).toEqual([
        { type: "image", path: `${FILES}\\notes\\page-1.jpg` },
        { type: "file", path: `${FILES}\\scan-a.pdf` },
      ]);
      expect(prepared.notices).toEqual([]);
      expect(prepared.complete).toBe(true);
      expect(prepared.delivery).toMatch(/Scanned PDFs/);
      expect(prepared.counts).toMatchObject({ scannedPdfs: 1, textChars: 0 });
    });

    it("is not sent at all to an AI that cannot read a scan: its page of text is not the material", async () => {
      const prepared = await prepareMaterial(material, { label: "Codex" }, notice(SCAN_TEXT, [mostly("scan-a.pdf", 11, 12)]));
      expect(prepared.parts.map((part) => part.type)).toEqual(["image"]);
      expect(prepared.notices).toEqual([
        '"scan-a.pdf" was not sent. It is a scan: 11 of its 12 pages are pictures with no readable text, and Codex cannot read scanned pages. Add photos of the pages you need instead.',
      ]);
      expect(prepared.complete).toBe(false);
      expect(prepared.delivery).toBeNull();
    });

    it("is not sent at all when it has more pages than a request may carry", async () => {
      const big: PromptPart = { ...SCAN_TEXT, name: "scan-b.pdf" };
      const prepared = await prepareMaterial(material, { label: "Claude Code", readsScannedPdfs: true }, notice(big, [mostly("scan-b.pdf", 29, 30)]));
      expect(prepared.parts.map((part) => part.type)).toEqual(["image"]);
      expect(prepared.notices).toEqual([
        '"scan-b.pdf" was not sent. It is a scan: 29 of its 30 pages are pictures with no readable text, and one request can take 20 scanned pages at most. Add photos of the pages you need instead.',
      ]);
    });

    it("goes as its text with the notice when a good part of it is text after all", async () => {
      const half: PromptPart = { ...SCAN_TEXT, name: "scan-b.pdf" };
      const prepared = await prepareMaterial(material, { label: "Codex" }, notice(half, [mostly("scan-b.pdf", 18, 30)]));
      expect(prepared.parts.map((part) => part.type)).toEqual(["text", "image"]);
      expect(prepared.notices).toEqual(['"scan-b.pdf" is mostly a scan: 18 of the 30 pages have no readable text.']);
    });

    it("says what was not sent when only some pages are pictures, and sends the rest", async () => {
      const some: ContentNotice = { type: "pages-without-text", file: "script.pdf", textless: 3, total: 10, mostly: false, message: "3 of the 10 pages have no readable text." };
      const lost: ContentNotice = { type: "formulas-lost", file: "script.pdf", message: "The formulas could not be read." };
      const prepared = await prepareMaterial(material, { label: "Claude Code", readsScannedPdfs: true }, notice({ ...TEXT, truncated: false }, [some, lost]));
      expect(prepared.parts.map((part) => part.type)).toEqual(["text", "image"]);
      expect(prepared.notices).toEqual(["3 of the 10 pages have no readable text.", "The formulas could not be read."]);
      expect(prepared.complete).toBe(false);
    });
  });

  it("does not hand over a scan whose pages cannot be counted, or one past the page limit", async () => {
    const prepared = await prepareMaterial(material, CLAUDE, {
      buildContent: async () => content([], [noText("scan-a.pdf"), noText("scan-b.pdf")]),
      countPages: async (path) => (path.endsWith("scan-a.pdf") ? MAX_SCANNED_PAGES : null),
    });
    expect(prepared.parts).toEqual([{ type: "file", path: `${FILES}\\scan-a.pdf` }]);
    expect(prepared.notices).toEqual([`"scan-b.pdf" was not sent. It is a scan, and one request can take ${MAX_SCANNED_PAGES} scanned pages at most.`]);
  });

  it("sends a scan whole to an AI that cannot read a page range, or not at all", async () => {
    const prepared = await prepareMaterial(material, { label: "API key", readsScannedPdfs: true }, options);
    // 12 pages fit; 30 do not, and the file cannot be cut.
    expect(prepared.parts.filter((part) => part.type === "file")).toEqual([{ type: "file", path: `${FILES}\\scan-a.pdf` }]);
    expect(prepared.notices).toContain(
      `"scan-b.pdf" was not sent. It is a scan with 30 pages, and one request can take ${MAX_SCANNED_PAGES} scanned pages at most. Add photos of the pages you need instead.`,
    );
    expect(prepared.delivery).toMatch(/Look at the pages yourself/);
    // Reading a page range needs software a student does not have: the whole file, or nothing.
    expect(prepared.delivery).toMatch(/do not ask for a page range/);
  });

  it("asks the AI how much it can take, and cuts the material to that", async () => {
    const asked: unknown[] = [];
    const built: unknown[] = [];
    const prepared = await prepareMaterial(
      material,
      {
        label: "Ollama",
        maxTextChars: async (model, input) => {
          asked.push(["text", model, input]);
          return 9_000;
        },
        maxAttachmentBytes: async (model) => {
          asked.push(["bytes", model]);
          return 5_000_000;
        },
      },
      {
        model: "gemma4",
        instructionChars: 7_000,
        buildContent: async (_files, contentOptions) => {
          built.push({ maxTextChars: contentOptions.maxTextChars, maxImageBytes: contentOptions.maxImageBytes });
          return content([TEXT], [NOTICES[0] as ContentNotice]);
        },
      },
    );
    expect(asked).toEqual([
      ["bytes", "gemma4"],
      ["text", "gemma4", { images: 2, instructionChars: 7_000 }],
    ]);
    expect(built).toEqual([{ maxTextChars: 9_000, maxImageBytes: 5_000_000 }]);
    expect(prepared.notices).toEqual(['Only the first 1 of 3 pages of "script.pdf" were sent.']);
  });

  it("uses the app's own limits when the AI reports none, a tiny one or fails to say", async () => {
    const built: unknown[] = [];
    const buildContent = async (_files: unknown, contentOptions: { maxTextChars?: number; maxImageBytes?: number }) => {
      built.push({ ...("maxTextChars" in contentOptions ? { maxTextChars: contentOptions.maxTextChars } : {}), ...("maxImageBytes" in contentOptions ? { maxImageBytes: contentOptions.maxImageBytes } : {}) });
      return content([TEXT], []);
    };
    await prepareMaterial(material, { label: "A", maxTextChars: async () => undefined, maxAttachmentBytes: async () => undefined }, { buildContent });
    await prepareMaterial(
      material,
      {
        label: "B",
        maxTextChars: async () => {
          throw new Error("down");
        },
        maxAttachmentBytes: async () => Number.NaN,
      },
      { buildContent },
    );
    await prepareMaterial(material, { label: "C", maxTextChars: async () => 12 }, { buildContent });
    expect(built).toEqual([{}, {}, { maxTextChars: MIN_TEXT_CHARS }]);
  });

  it("counts a scan against the bytes the AI can take", async () => {
    const prepared = await prepareMaterial(
      material,
      { ...CLAUDE, maxAttachmentBytes: async () => 2_500 },
      { ...options, buildContent: async () => content([], [noText("scan-a.pdf"), noText("scan-b.pdf")]) },
    );
    // scan-a (2,000 bytes) fits; scan-b (3,000) no longer does.
    expect(prepared.parts).toEqual([{ type: "file", path: `${FILES}\\scan-a.pdf` }]);
    expect(prepared.notices[0]).toMatch(/"scan-b\.pdf" was not sent\. It is a scan .* too large for Claude Code/);
  });

  it("has nothing to send for an empty material", async () => {
    const empty = { ...material, files: [] };
    const prepared = await prepareMaterial(empty, { label: "Claude Code" }, { buildContent: async () => content([], []) });
    expect(prepared.parts).toEqual([]);
    expect(nothingReadableSentence(0)).toMatch(/no files yet/);
    expect(nothingReadableSentence(2)).toMatch(/Nothing in this material could be read/);
  });
});

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentProxy } from "unpdf";
import type { LibraryResult, MaterialRef } from "@shared/library";
import { countPdfPages, extractPdfText } from "../extract";
import { createLibrary, MAX_FILE_BYTES } from "./library";
import type { LibraryService } from "./library";
import { pageSize, pdfOverheadBytes, PhotoPdfFailure, readJpegInfo, writePhotoPdf } from "./photo-pdf";

/** A JPEG as far as its markers go: JFIF, an optional Exif orientation, one frame header, a scan. */
function jpeg(options: { width?: number; height?: number; components?: number; frame?: number; precision?: number; orientation?: number; filler?: number } = {}): Buffer {
  const { width = 1200, height = 1600, components = 3, frame = 0xc0, precision = 8, orientation, filler = 64 } = options;
  const u16 = (value: number): number[] => [value >> 8, value & 0xff];
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  if (orientation !== undefined) {
    // "Exif\0\0", a big-endian TIFF header, one directory with the orientation tag.
    const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, ...u16(orientation), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    parts.push(0xff, 0xe1, ...u16(exif.length + 2), ...exif);
  }
  const perComponent = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0x00]).flat();
  parts.push(0xff, frame, ...u16(8 + components * 3), precision, ...u16(height), ...u16(width), components, ...perComponent);
  parts.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  return Buffer.concat([Buffer.from(parts), Buffer.alloc(filler, 0x55), Buffer.from([0xff, 0xd9])]);
}

async function pdfOf(pages: Buffer[]): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const result = await writePhotoPdf(pages.length, async (index) => pages[index] as Buffer, async (chunk) => void chunks.push(chunk));
  const pdf = Buffer.concat(chunks);
  expect(result).toEqual({ pages: pages.length, bytes: pdf.length });
  return pdf;
}

describe("reading a JPEG's header", () => {
  it("finds the size and the colours of baseline, extended and progressive pictures", () => {
    expect(readJpegInfo(jpeg())).toEqual({ width: 1200, height: 1600, components: 3, rotate: 0 });
    expect(readJpegInfo(jpeg({ frame: 0xc1, components: 1, width: 640, height: 480 }))).toEqual({ width: 640, height: 480, components: 1, rotate: 0 });
    expect(readJpegInfo(jpeg({ frame: 0xc2 }))).toMatchObject({ width: 1200, height: 1600, components: 3 });
  });

  it("reads how the camera held the picture", () => {
    expect(readJpegInfo(jpeg({ orientation: 1 })).rotate).toBe(0);
    expect(readJpegInfo(jpeg({ orientation: 6 })).rotate).toBe(90);
    expect(readJpegInfo(jpeg({ orientation: 3 })).rotate).toBe(180);
    expect(readJpegInfo(jpeg({ orientation: 8 })).rotate).toBe(270);
    expect(readJpegInfo(jpeg({ orientation: 99 })).rotate).toBe(0);
  });

  it("refuses CMYK, more than 8 bits, lossless and arithmetic pictures, each with a sentence", () => {
    const message = (bytes: Uint8Array): string => {
      try {
        readJpegInfo(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(PhotoPdfFailure);
        return (error as Error).message;
      }
      throw new Error("was not refused");
    };
    expect(message(jpeg({ components: 4 }))).toMatch(/CMYK picture .* wrong colours/);
    expect(message(jpeg({ precision: 12 }))).toMatch(/more than 8 bits/);
    expect(message(jpeg({ frame: 0xc3 }))).toMatch(/kind of JPEG a PDF cannot hold/);
    expect(message(jpeg({ frame: 0xc9 }))).toMatch(/kind of JPEG a PDF cannot hold/);
    expect(message(jpeg({ components: 2 }))).toMatch(/not a photo this app can read/);
    expect(message(jpeg({ width: 0 }))).toMatch(/not a photo this app can read/);
  });

  it("refuses what is not a JPEG, is cut short, or has no picture in it", () => {
    const whole = jpeg();
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("%PDF-1.4"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      whole.subarray(0, 12),
      whole.subarray(0, 24),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14, 7), Buffer.from([0xff, 0xd9])]),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200_000, 0xff)]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
    ]) {
      expect(() => readJpegInfo(bytes)).toThrow(PhotoPdfFailure);
    }
  });
});

describe("the page for a photo", () => {
  it("is as wide as A4 and as high as the photo's proportions make it", () => {
    expect(pageSize(1200, 1600)).toEqual({ width: 595.28, height: 793.71 });
    expect(pageSize(1000, 1000)).toEqual({ width: 595.28, height: 595.28 });
    // Wider than tall: A4 on its side.
    expect(pageSize(1600, 1200)).toEqual({ width: 841.89, height: 631.42 });
    // A4 itself comes out as A4.
    expect(pageSize(2480, 3508)).toEqual({ width: 595.28, height: 842.03 });
  });

  it("stays a page for a strip or a sliver", () => {
    const strip = pageSize(100, 60_000);
    expect(strip.height).toBe(14_400);
    expect(strip.width).toBeCloseTo(24, 0);
    expect(pageSize(60_000, 10).height).toBeGreaterThanOrEqual(3);
  });
});

describe("the PDF", () => {
  it("opens in the app's own PDF reader with one page per photo, each the size of its photo", async () => {
    const pages = [jpeg(), jpeg({ width: 1600, height: 1200, components: 1 }), jpeg({ orientation: 6, frame: 0xc2 })];
    const pdf = await pdfOf(pages);
    expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.subarray(-6).toString("latin1")).toBe("%%EOF\n");

    const document = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
    try {
      expect(document.numPages).toBe(3);
      const boxes = [];
      for (let number = 1; number <= 3; number += 1) {
        const page = await document.getPage(number);
        boxes.push({ view: page.view.map((value) => Math.round(value * 100) / 100), rotate: page.rotate });
        // The page draws one image and has no text.
        const operators = await page.getOperatorList();
        expect(operators.fnArray.length).toBeGreaterThan(0);
        expect((await page.getTextContent()).items).toEqual([]);
      }
      expect(boxes).toEqual([
        { view: [0, 0, 595.28, 793.71], rotate: 0 },
        { view: [0, 0, 841.89, 631.42], rotate: 0 },
        { view: [0, 0, 595.28, 793.71], rotate: 90 },
      ]);
    } finally {
      await document.loadingTask.destroy();
    }
    // To the app it is a scan: pages, and no text.
    expect(await countPdfPages(new Uint8Array(pdf))).toBe(3);
    expect(await extractPdfText(new Uint8Array(pdf))).toMatchObject({ ok: false, error: { code: "no-text" } });
  });

  it("holds every photo's bytes exactly as they are, in order, with the right colours declared", async () => {
    const pages = [jpeg({ filler: 300 }), jpeg({ components: 1, filler: 5_000 }), jpeg({ filler: 17 })];
    const pdf = await pdfOf(pages);
    let from = 0;
    for (const page of pages) {
      const at = pdf.indexOf(page, from);
      expect(at).toBeGreaterThan(from);
      from = at + page.length;
    }
    const text = pdf.toString("latin1");
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    expect(text.match(/\/ColorSpace \/DeviceRGB/g)).toHaveLength(2);
    expect(text.match(/\/ColorSpace \/DeviceGray/g)).toHaveLength(1);
    expect(text).toContain(`/Length ${pages[1]?.length} >>`);
    // The table at the end points at where each object really starts.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(2 + 3 * 3);
    offsets.forEach((offset, index) => expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
    expect(Number(/startxref\n(\d+)\n/.exec(text)?.[1])).toBe(text.lastIndexOf("xref\n0 "));
    expect(pdf.length).toBeLessThanOrEqual(pages.reduce((sum, page) => sum + page.length, 0) + pdfOverheadBytes(3));
  });

  it("works for one page and for a hundred, asking for one photo at a time", async () => {
    expect(await countPdfPages(new Uint8Array(await pdfOf([jpeg()])))).toBe(1);

    const asked: number[] = [];
    let bytes = 0;
    const result = await writePhotoPdf(
      100,
      async (index) => {
        asked.push(index);
        return jpeg({ filler: 1_000 });
      },
      async (chunk) => void (bytes += chunk.length),
    );
    expect(asked).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(result).toEqual({ pages: 100, bytes });
    expect(bytes).toBeLessThanOrEqual(100 * jpeg({ filler: 1_000 }).length + pdfOverheadBytes(100));
  });

  it("says which photo cannot be used, and stops", async () => {
    const asked: number[] = [];
    const attempt = writePhotoPdf(
      3,
      async (index) => {
        asked.push(index);
        return index === 1 ? jpeg({ components: 4 }) : jpeg();
      },
      async () => {},
    );
    await expect(attempt).rejects.toMatchObject({ name: "PhotoPdfFailure", pageNumber: 2 });
    expect(asked).toEqual([0, 1]);
    await expect(writePhotoPdf(0, async () => jpeg(), async () => {})).rejects.toBeInstanceOf(PhotoPdfFailure);
  });
});

describe("turning a photo set into a PDF", () => {
  let sandbox: string;
  let root: string;
  let library: LibraryService;
  let ref: MaterialRef;
  let trashed: string[];

  const value = <T>(result: LibraryResult<T>): T => {
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  const failure = <T>(result: LibraryResult<T>) => {
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.message).not.toContain(sandbox);
    return result.error;
  };
  const files = (): string => path.join(root, ref.subject, ref.material, "files");
  const onDisk = async (): Promise<string[]> => (await readdir(files())).sort();
  const meta = async (): Promise<{ files: string[]; madeFrom?: Record<string, string> }> =>
    JSON.parse(await readFile(path.join(root, ref.subject, ref.material, "material.json"), "utf8")) as never;

  beforeEach(async () => {
    sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-photopdf-")));
    root = path.join(sandbox, "library");
    trashed = [];
    library = createLibrary({
      root: () => ({ root, isDefault: false, fixedByEnvironment: false }),
      trash: async (target) => {
        trashed.push(target);
        await rm(target, { recursive: true });
      },
      log: () => {},
      now: () => new Date(2026, 9, 3, 9, 0),
    });
    value(await library.createSubject("Biology"));
    ref = { subject: "Biology", material: value(await library.createMaterial("Biology", "Cells")).id };
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("makes one PDF of the pages, in order, next to the photos, and links the two", async () => {
    const source = path.join(sandbox, "chapter.pdf");
    await writeFile(source, "%PDF-1.4\n%%EOF\n");
    value(await library.addFiles(ref, [source]));
    const pages = [jpeg({ filler: 100 }), jpeg({ filler: 200, components: 1 }), jpeg({ filler: 300 })];
    value(await library.addPhotoSet(ref, pages));
    const second = path.join(sandbox, "later.pdf");
    await writeFile(second, "%PDF-1.4\n%%EOF\n");
    value(await library.addFiles(ref, [second]));

    const outcome = value(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    expect(outcome.rejected).toEqual([]);
    expect(outcome.added).toEqual([{ name: "notes-2026-10-03.pdf", kind: "pdf", size: expect.any(Number) as number, madeFrom: "notes-2026-10-03" }]);
    // Directly after its photos, before what was added later.
    expect(outcome.material.files.map((file) => file.name)).toEqual(["chapter.pdf", "notes-2026-10-03", "notes-2026-10-03.pdf", "later.pdf"]);
    expect(outcome.material.files[1]).toMatchObject({ kind: "photo-set", pdf: "notes-2026-10-03.pdf", pages: ["page-1.jpg", "page-2.jpg", "page-3.jpg"] });
    expect(outcome.material.files[0]).not.toHaveProperty("madeFrom");
    expect(outcome.material.fileCount).toBe(4);

    // The photos are untouched, the PDF holds them in order, and no temporary file is left.
    expect(await onDisk()).toEqual(["chapter.pdf", "later.pdf", "notes-2026-10-03", "notes-2026-10-03.pdf"]);
    expect(await readdir(path.join(files(), "notes-2026-10-03"))).toEqual(["page-1.jpg", "page-2.jpg", "page-3.jpg"]);
    const pdf = await readFile(path.join(files(), "notes-2026-10-03.pdf"));
    expect(await countPdfPages(new Uint8Array(pdf))).toBe(3);
    let from = 0;
    for (const page of pages) {
      const at = pdf.indexOf(page, from);
      expect(at).toBeGreaterThan(from);
      from = at;
    }
    expect(await meta()).toMatchObject({
      files: ["chapter.pdf", "notes-2026-10-03", "notes-2026-10-03.pdf", "later.pdf"],
      madeFrom: { "notes-2026-10-03.pdf": "notes-2026-10-03" },
    });
    // The list and a fresh read agree.
    expect(value(await library.getMaterial(ref)).files).toEqual(outcome.material.files);
    // What generation is told: the PDF, with where it came from.
    const located = value(await library.locateMaterial(ref));
    expect(located.files.find((file) => file.name === "notes-2026-10-03.pdf")).toMatchObject({ kind: "pdf", madeFrom: "notes-2026-10-03" });
  });

  it("refuses to make it twice, and points at the one that is there", async () => {
    value(await library.addPhotoSet(ref, [jpeg()]));
    value(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    const error = failure(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    expect(error).toEqual({ code: "already-exists", message: 'These photos already have their PDF: "notes-2026-10-03.pdf". It holds the same pages as the photos.' });
    expect(await onDisk()).toEqual(["notes-2026-10-03", "notes-2026-10-03.pdf"]);
  });

  it("takes the next free name when a file of that name is already there", async () => {
    value(await library.addPhotoSet(ref, [jpeg()]));
    await writeFile(path.join(files(), "NOTES-2026-10-03.pdf"), "%PDF-1.4 someone else's");
    const outcome = value(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    expect(outcome.added[0]).toMatchObject({ name: "notes-2026-10-03-2.pdf", madeFrom: "notes-2026-10-03" });
    expect(await readFile(path.join(files(), "NOTES-2026-10-03.pdf"), "utf8")).toBe("%PDF-1.4 someone else's");
    expect(value(await library.getMaterial(ref)).files.find((file) => file.name === "NOTES-2026-10-03.pdf")).not.toHaveProperty("madeFrom");
  });

  it("makes the PDF an ordinary file when the photos are removed, and leaves the photos alone when the PDF is", async () => {
    value(await library.addPhotoSet(ref, [jpeg()]));
    value(await library.photoSetToPdf(ref, "notes-2026-10-03"));

    const withoutSet = value(await library.removeFile(ref, "notes-2026-10-03"));
    expect(withoutSet.files).toEqual([{ name: "notes-2026-10-03.pdf", kind: "pdf", size: expect.any(Number) as number }]);
    expect(await meta()).not.toHaveProperty("madeFrom");

    // A new set on the same day takes the old name: it is not the PDF's set.
    const again = value(await library.addPhotoSet(ref, [jpeg(), jpeg()]));
    expect(again.added[0]?.name).toBe("notes-2026-10-03");
    expect(again.material.files.map((file) => [file.name, file.madeFrom, file.pdf])).toEqual([
      ["notes-2026-10-03.pdf", undefined, undefined],
      ["notes-2026-10-03", undefined, undefined],
    ]);
    // And it can have a PDF of its own.
    const own = value(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    expect(own.added[0]).toMatchObject({ name: "notes-2026-10-03-2.pdf", madeFrom: "notes-2026-10-03" });

    const withoutPdf = value(await library.removeFile(ref, "notes-2026-10-03-2.pdf"));
    expect(withoutPdf.files.find((file) => file.name === "notes-2026-10-03")).toEqual({ name: "notes-2026-10-03", kind: "photo-set", size: expect.any(Number) as number, pages: ["page-1.jpg", "page-2.jpg"] });
    expect(await meta()).not.toHaveProperty("madeFrom");
    // With its PDF gone, the set can be turned into one again.
    expect(value(await library.photoSetToPdf(ref, "notes-2026-10-03")).added[0]?.name).toBe("notes-2026-10-03-2.pdf");
  });

  it("ignores a link whose other end was renamed or deleted by hand, and what a hand wrote into the file", async () => {
    value(await library.addPhotoSet(ref, [jpeg()]));
    value(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    const { rename } = await import("node:fs/promises");
    await rename(path.join(files(), "notes-2026-10-03"), path.join(files(), "my photos"));
    expect(value(await library.getMaterial(ref)).files.map((file) => [file.name, file.kind, file.madeFrom, file.pdf])).toEqual([
      ["notes-2026-10-03.pdf", "pdf", undefined, undefined],
      ["my photos", "photo-set", undefined, undefined],
    ]);

    // material.json is a hint from anyone: paths, other kinds, two PDFs claiming one set.
    const other = path.join(sandbox, "other.pdf");
    await writeFile(other, "%PDF-1.4\n%%EOF\n");
    value(await library.addFiles(ref, [other]));
    const file = path.join(root, ref.subject, ref.material, "material.json");
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(
      file,
      JSON.stringify({
        ...current,
        madeFrom: {
          "notes-2026-10-03.pdf": "my photos",
          "other.pdf": "my photos",
          "../../outside.pdf": "my photos",
          "my photos": "notes-2026-10-03.pdf",
          "gone.pdf": "my photos",
          "other.pdf ": 7,
        },
      }),
    );
    const listed = value(await library.getMaterial(ref)).files;
    expect(listed.map((entry) => [entry.name, entry.madeFrom, entry.pdf])).toEqual([
      ["notes-2026-10-03.pdf", "my photos", undefined],
      ["my photos", undefined, "notes-2026-10-03.pdf"],
      ["other.pdf", undefined, undefined],
    ]);
    await writeFile(file, JSON.stringify({ ...current, madeFrom: ["notes-2026-10-03.pdf"] }));
    expect(value(await library.getMaterial(ref)).files.every((entry) => entry.madeFrom === undefined && entry.pdf === undefined)).toBe(true);
  });

  it("fails as a whole on a damaged page and leaves nothing behind", async () => {
    value(await library.addPhotoSet(ref, [jpeg(), jpeg(), jpeg()]));
    // The second page is replaced by something that only starts like a JPEG.
    await writeFile(path.join(files(), "notes-2026-10-03", "page-2.jpg"), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]));
    const error = failure(await library.photoSetToPdf(ref, "notes-2026-10-03"));
    expect(error).toEqual({ code: "unsupported-file", message: 'Photo 2 of "notes-2026-10-03" is not a photo this app can read. It may be damaged. No PDF was made.' });
    expect(await onDisk()).toEqual(["notes-2026-10-03"]);
    expect(await meta()).not.toHaveProperty("madeFrom");
    expect(value(await library.getMaterial(ref)).files).toHaveLength(1);

    await writeFile(path.join(files(), "notes-2026-10-03", "page-2.jpg"), jpeg({ components: 4 }));
    expect(failure(await library.photoSetToPdf(ref, "notes-2026-10-03")).message).toMatch(/^Photo 2 of "notes-2026-10-03" is a CMYK picture .* No PDF was made\.$/);
    expect(await onDisk()).toEqual(["notes-2026-10-03"]);
  });

  it("refuses photos that add up to more than one file may weigh, before writing anything", async () => {
    // A set put together by hand in the file manager: eleven pages of ten megabytes.
    const set = path.join(files(), "scans");
    await mkdir(set);
    const pageBytes = Math.ceil(MAX_FILE_BYTES / 11) + 1_024;
    for (let number = 1; number <= 11; number += 1) {
      const file = path.join(set, `page-${number}.jpg`);
      const handle = await open(file, "w");
      await handle.write(jpeg());
      await handle.close();
      await truncate(file, pageBytes);
    }
    const error = failure(await library.photoSetToPdf(ref, "scans"));
    expect(error.code).toBe("too-large");
    expect(error.message).toBe("These photos add up to more than 100 MB, which is more than one file may weigh. Split them into smaller sets and turn each into a PDF.");
    expect(await onDisk()).toEqual(["scans"]);
  });

  it("refuses what is not a photo set of this material", async () => {
    const source = path.join(sandbox, "chapter.pdf");
    await writeFile(source, "%PDF-1.4\n%%EOF\n");
    value(await library.addFiles(ref, [source]));
    await mkdir(path.join(files(), "empty"));

    expect(failure(await library.photoSetToPdf(ref, "chapter.pdf")).code).toBe("unsupported-file");
    expect(failure(await library.photoSetToPdf(ref, "empty")).message).toBe("This photo set has no photos in it.");
    expect(failure(await library.photoSetToPdf(ref, "gone")).code).toBe("not-found");
    for (const name of ["..", "../Cells", "a/b", "C:\\x", "", "notes.", null, 7, ["notes"]]) {
      const error = failure(await library.photoSetToPdf(ref, name as never));
      expect(["outside-library", "not-found", "invalid-request"]).toContain(error.code);
    }
    expect(failure(await library.photoSetToPdf({ subject: "..", material: "x" }, "notes")).code).toBe("outside-library");
    expect(existsSync(path.join(files(), "chapter.pdf"))).toBe(true);
    expect(trashed).toEqual([]);
  });
});

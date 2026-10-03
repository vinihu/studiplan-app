import { describe, expect, it } from "vitest";
import type { AddFilesOutcome, LibraryResult, Material, MaterialRef } from "@shared/library";
import { growthOf } from "@shared/test-scaling";
import { addToMaterial, UNREADABLE_PHOTO_REASON } from "./add-to-material";
import type { AddDeps } from "./add-to-material";
import { imageSize } from "./image-size";
import {
  isTooManyPixels,
  MAX_PHOTO_FILE_BYTES,
  MAX_PHOTOS,
  PHOTO_FILE_TOO_LARGE_REASON,
  PhotoRefused,
  tooManyPhotosReason,
  tooManyPixelsReason,
} from "./page-size";
import type { PickedFile } from "./split";

/* What is refused before a photo is decoded: too many, too large a file, too many pixels. */

const ref: MaterialRef = { subject: "Biology", material: "Cell division" };
const material: Material = {
  id: "Cell division",
  subject: "Biology",
  title: "Cell division",
  created: "2026-10-02T09:30:00.000Z",
  fileCount: 0,
  setCount: 0,
  files: [],
};

function harness(toJpeg: AddDeps<PickedFile>["toJpeg"] = async (f) => new TextEncoder().encode(f.name)) {
  const decoded: string[] = [];
  const sets: number[] = [];
  const saved = (): LibraryResult<AddFilesOutcome> => ({ ok: true, value: { material, added: [], rejected: [] } });
  const deps: AddDeps<PickedFile> = {
    pathFor: (f) => `C:\\Users\\student\\${f.name}`,
    toJpeg: async (f) => {
      decoded.push(f.name);
      return toJpeg(f);
    },
    addFiles: async () => saved(),
    addPhotoSet: async (_ref, pages) => {
      sets.push(pages.length);
      return saved();
    },
  };
  return { deps, decoded, sets };
}

const photos = (count: number): PickedFile[] =>
  Array.from({ length: count }, (_, i) => ({ name: `photo-${i + 1}.jpg`, type: "image/jpeg", size: 1_000 }));

describe("addToMaterial: limits on photos, before any is opened", () => {
  it("takes a full set of 100", async () => {
    const { deps, decoded, sets } = harness();
    const report = await addToMaterial(ref, photos(MAX_PHOTOS), deps);
    expect(decoded.length).toBe(100);
    expect(sets).toEqual([100]);
    expect(report.failures).toEqual([]);
  });

  it("refuses more than 100 in one go with a sentence, and opens none of them", async () => {
    const { deps, decoded, sets } = harness();
    const report = await addToMaterial(ref, photos(101), deps);
    expect(decoded).toEqual([]);
    expect(sets).toEqual([]);
    expect(report.failures).toEqual([tooManyPhotosReason(101)]);
    expect(report.failures[0]).toBe("You picked 101 photos. A photo set can have up to 100 pages. Add them in smaller groups.");
  });

  it("still adds the documents of the same action", async () => {
    const { deps, decoded } = harness();
    let copied: string[] = [];
    const report = await addToMaterial(ref, [{ name: "chapter.pdf", type: "application/pdf" }, ...photos(5_000)], {
      ...deps,
      addFiles: async (_ref, paths) => {
        copied = paths;
        return { ok: true, value: { material, added: [], rejected: [] } };
      },
    });
    expect(copied).toEqual(["C:\\Users\\student\\chapter.pdf"]);
    expect(decoded).toEqual([]);
    expect(report.failures.length).toBe(1);
  });

  it("refuses a file that is too large without reading it, and keeps the others", async () => {
    const { deps, decoded, sets } = harness();
    const report = await addToMaterial(
      ref,
      [
        { name: "a.jpg", type: "image/jpeg", size: 4_000_000 },
        { name: "huge.png", type: "image/png", size: MAX_PHOTO_FILE_BYTES + 1 },
        { name: "b.jpg", type: "image/jpeg", size: MAX_PHOTO_FILE_BYTES },
      ],
      deps,
    );
    expect(decoded).toEqual(["a.jpg", "b.jpg"]);
    expect(sets).toEqual([2]);
    expect(report.rejected).toEqual([{ name: "huge.png", reason: PHOTO_FILE_TOO_LARGE_REASON }]);
    expect(PHOTO_FILE_TOO_LARGE_REASON).toBe("This photo's file is larger than 64 MB. Save a smaller copy and add that.");
  });

  it("shows the reason of a photo refused for its pixels, and the usual sentence for one that cannot be read", async () => {
    const { deps, sets } = harness(async (f) => {
      if (f.name === "poster.png") throw new PhotoRefused(tooManyPixelsReason(30_000, 30_000));
      if (f.name === "broken.jpg") throw new Error("decode failed");
      return new Uint8Array([1]);
    });
    const report = await addToMaterial(ref, [{ name: "poster.png", type: "" }, { name: "broken.jpg", type: "" }, { name: "ok.jpg", type: "" }], deps);
    expect(sets).toEqual([1]);
    expect(report.rejected).toEqual([
      {
        name: "poster.png",
        reason: "This photo is too large to open (30000 × 30000 pixels). Save a smaller copy, up to about 120 megapixels, and add that.",
      },
      { name: "broken.jpg", reason: UNREADABLE_PHOTO_REASON },
    ]);
  });

  it("opens one photo at a time", async () => {
    let open = 0;
    let most = 0;
    const { deps } = harness(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((done) => setTimeout(done, 1));
      open -= 1;
      return new Uint8Array([1]);
    });
    await addToMaterial(ref, photos(12), deps);
    expect(most).toBe(1);
  });
});

describe("isTooManyPixels", () => {
  it("lets a phone's largest photos through and stops what would not fit in memory", () => {
    expect(isTooManyPixels(4_000, 3_000)).toBe(false);
    expect(isTooManyPixels(12_000, 9_000)).toBe(false); // 108 megapixels
    expect(isTooManyPixels(16_320, 12_240)).toBe(true); // 200 megapixels
    expect(isTooManyPixels(30_000, 30_000)).toBe(true);
    expect(isTooManyPixels(65_535, 65_535)).toBe(true);
  });
});

describe("imageSize: the pixels of a picture, from its first bytes", () => {
  const bytes = (...parts: Array<number[] | string>): Uint8Array =>
    Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));
  const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const be16 = (n: number) => [n >>> 8, n & 255];
  const le16 = (n: number) => [n & 255, n >>> 8];
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];

  it("reads a PNG", () => {
    const png = bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(30_000), be32(20_000), [8, 2, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 30_000, height: 20_000 });
  });

  it("reads a JPEG, past the camera's own data in front of the frame header", () => {
    const exif = [0xff, 0xe1, ...be16(2 + 300), ...new Array<number>(300).fill(0x41)];
    const tables = [0xff, 0xdb, ...be16(2 + 64), ...new Array<number>(64).fill(1)];
    const frame = [0xff, 0xc2, ...be16(17), 8, ...be16(3_000), ...be16(4_000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(imageSize(bytes([0xff, 0xd8], exif, tables, frame))).toEqual({ width: 4_000, height: 3_000 });
    // A table marker in the frame headers' range is not one.
    const huffman = [0xff, 0xc4, ...be16(2 + 20), ...new Array<number>(20).fill(9)];
    expect(imageSize(bytes([0xff, 0xd8], huffman, frame))).toEqual({ width: 4_000, height: 3_000 });
  });

  it("reads a GIF, a BMP and the three kinds of WebP", () => {
    expect(imageSize(bytes("GIF89a", le16(640), le16(480), [0, 0, 0]))).toEqual({ width: 640, height: 480 });
    const bmp = bytes("BM", new Array<number>(16).fill(0), le32(1_024), le32(0x100000000 - 768), [1, 0, 24, 0]);
    expect(imageSize(bmp)).toEqual({ width: 1_024, height: 768 });
    const riff = (chunk: number[] | string, rest: number[]) => bytes("RIFF", le32(100), "WEBP", chunk, rest);
    const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16];
    expect(imageSize(riff("VP8X", [...le32(10), 0, 0, 0, 0, ...le24(4_999), ...le24(2_999)]))).toEqual({ width: 5_000, height: 3_000 });
    expect(imageSize(riff("VP8 ", [...le32(30), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600)]))).toEqual({ width: 800, height: 600 });
    const lossless = (800 - 1) | ((600 - 1) << 14);
    expect(imageSize(riff("VP8L", [...le32(30), 0x2f, ...le32(lossless), 0, 0, 0, 0, 0]))).toEqual({ width: 800, height: 600 });
  });

  it("says nothing about what it does not know, or what is cut short or empty", () => {
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(imageSize(bytes("not a picture at all, just text"))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xda, 0, 4, 0, 0], new Array<number>(40).fill(0)))).toBeNull();
    expect(imageSize(bytes([0x89], "PNG", [13, 10, 26, 10], be32(13), "IHDR", be32(0), be32(0), [8, 2, 0, 0, 0]))).toBeNull();
    expect(imageSize(bytes("GIF89a"))).toBeNull();
  });

  it("reads a header in one pass, whatever is in it", () => {
    // A header of nothing but marker bytes, at a quarter of the most it is given and at all of it.
    const junk = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size).fill(0xff);
      bytes[1] = 0xd8;
      return bytes;
    };
    expect(imageSize(junk(512 * 1024))).toBeNull();
    const growth = growthOf((size) => imageSize(junk(size)), 128 * 1024);
    expect(growth.linear, JSON.stringify(growth)).toBe(true);
  });
});

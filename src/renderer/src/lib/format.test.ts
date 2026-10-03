import { describe, expect, it } from "vitest";
import type { MaterialFile } from "@shared/library";
import {
  count,
  countInline,
  describeAdded,
  describeFile,
  fileRemoval,
  formatDate,
  formatDateTime,
  formatDatesApart,
  formatSize,
  materialDeletion,
  pageCount,
  subjectDeletion,
  trashName,
} from "./format";

const pdf: MaterialFile = { name: "chapter-3.pdf", kind: "pdf", size: 2_500_000 };
const slides: MaterialFile = { name: "slides.pptx", kind: "pptx", size: 900_000 };
const photos = (pages: number): MaterialFile => ({
  name: "notes-2026-10-02",
  kind: "photo-set",
  size: pages * 500_000,
  pages: Array.from({ length: pages }, (_, index) => `page-${index + 1}.jpg`),
});

describe("formatSize", () => {
  it("never shows bytes and never shows 0 KB for a file that has content", () => {
    expect(formatSize(1)).toBe("1 KB");
    expect(formatSize(1023)).toBe("1 KB");
    expect(formatSize(1536)).toBe("2 KB");
  });

  it("uses one decimal below 10 and none from 10 up", () => {
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(2_500_000)).toBe("2.4 MB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatSize(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  it("stays in KB up to the megabyte", () => {
    expect(formatSize(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("treats nonsense as empty", () => {
    expect(formatSize(0)).toBe("0 KB");
    expect(formatSize(-5)).toBe("0 KB");
    expect(formatSize(Number.NaN)).toBe("0 KB");
  });
});

describe("count", () => {
  it("picks singular and plural", () => {
    expect(count(1, "file")).toBe("1 file");
    expect(count(3, "file")).toBe("3 files");
  });

  it("says No instead of 0 on its own, and 0 inside a sentence", () => {
    expect(count(0, "material")).toBe("No materials");
    expect(countInline(0, "material")).toBe("0 materials");
  });
});

describe("formatDate", () => {
  it("formats an ISO timestamp as a short date", () => {
    // Local time: built from local parts so the test holds in every time zone.
    expect(formatDate(new Date(2026, 9, 2, 9, 30).toISOString())).toBe("2 Oct 2026");
    expect(formatDate(new Date(2026, 8, 30, 23, 59).toISOString())).toBe("30 Sep 2026");
  });

  it("adds the time on a 24-hour clock where it is needed", () => {
    expect(formatDateTime(new Date(2026, 9, 2, 19, 40).toISOString())).toBe("2 Oct 2026, 19:40");
    expect(formatDateTime(new Date(2026, 9, 2, 7, 5).toISOString())).toBe("2 Oct 2026, 07:05");
    expect(formatDateTime("nonsense")).toBe("");
  });

  it("tells items of one day apart by their time, and leaves the others as dates", () => {
    const a = new Date(2026, 9, 2, 19, 40).toISOString();
    const b = new Date(2026, 9, 2, 8, 0).toISOString();
    const c = new Date(2026, 9, 1, 12, 0).toISOString();
    expect(formatDatesApart([a, b, c, "x"])).toEqual(["2 Oct 2026, 19:40", "2 Oct 2026, 08:00", "1 Oct 2026", ""]);
  });

  it("returns nothing for a timestamp it cannot read", () => {
    expect(formatDate("not a date")).toBe("");
    expect(formatDate("")).toBe("");
  });
});

describe("describing files", () => {
  it("names the kind, and the pages of a photo set", () => {
    expect(describeFile(pdf)).toBe("PDF");
    expect(describeFile(slides)).toBe("PowerPoint");
    expect(describeFile(photos(5))).toBe("Photos · 5 pages");
    expect(describeFile(photos(1))).toBe("Photos · 1 page");
  });

  it("counts pages only for photo sets", () => {
    expect(pageCount(pdf)).toBeNull();
    expect(pageCount(photos(3))).toBe(3);
    expect(pageCount({ name: "empty", kind: "photo-set", size: 0 })).toBe(0);
  });

  it("says what one add action brought in", () => {
    expect(describeAdded([])).toBe("");
    expect(describeAdded([pdf])).toBe("1 file");
    expect(describeAdded([pdf, slides, photos(5)])).toBe("2 files and 5 photos");
    expect(describeAdded([photos(1)])).toBe("1 photo");
  });
});

describe("deletion sentences", () => {
  const bin = "Recycle Bin";

  it("names the bin by platform and promises nothing before the platform is known", () => {
    expect(trashName("win32")).toBe("Recycle Bin");
    expect(trashName("darwin")).toBe("Trash");
    expect(trashName("linux")).toBe("Trash");
    expect(trashName(null)).toBeNull();
    expect(subjectDeletion(0, 0, null)).toBe("This empty subject will be removed from your library.");
    expect(subjectDeletion(0, 0, "Trash")).toContain("moved to the Trash");
  });

  it("names what is inside a subject and where it goes", () => {
    expect(subjectDeletion(0, 0, bin)).toBe(
      "This empty subject will be moved to the Recycle Bin. You can restore it from there.",
    );
    expect(subjectDeletion(3, 7, bin)).toContain(
      "(3 materials with 7 files) will be moved to the Recycle Bin",
    );
    expect(subjectDeletion(1, 0, bin)).toContain("(1 material with 0 files)");
    expect(subjectDeletion(2, null, bin)).toContain("(2 materials)");
  });

  it("names what is inside a material", () => {
    expect(materialDeletion({ fileCount: 0, setCount: 0 }, bin)).toMatch(
      /^This empty material will be moved/,
    );
    expect(materialDeletion({ fileCount: 4, setCount: 0 }, bin)).toContain("(4 files)");
    expect(materialDeletion({ fileCount: 1, setCount: 2 }, bin)).toContain("(1 file and 2 results)");
  });

  it("says the original stays when a file is removed", () => {
    expect(fileRemoval(pdf, bin)).toBe(
      "The copy in this material will be moved to the Recycle Bin. You can restore it from there. Your original file stays where it is.",
    );
    expect(fileRemoval(photos(5), bin)).toContain("The 5 photos in this material will be moved");
    expect(fileRemoval(photos(5), bin)).toContain("restore them");
    expect(fileRemoval(photos(1), bin)).toContain("The photo in this material");
  });
});

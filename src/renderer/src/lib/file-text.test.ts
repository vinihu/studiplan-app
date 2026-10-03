import { describe, expect, it } from "vitest";
import type { FileText } from "@shared/preview";
import { coverageNote, formatDuration, splitSections, textErrorTitle, textlessNote } from "./file-text";

describe("splitSections", () => {
  it("cuts at slide headings and keeps titles", () => {
    const text = "## Slide 1: Phases of mitosis\n\nProphase\nMetaphase\n\n## Slide 2\n\n(no text)";
    expect(splitSections(text)).toEqual([
      { heading: "Slide 1: Phases of mitosis", body: "Prophase\nMetaphase", notes: null },
      { heading: "Slide 2", body: "(no text)", notes: null },
    ]);
  });

  it("separates speaker notes from the body", () => {
    const text = "## Slide 1: Title\n\nBody line\n\nSpeaker notes:\nSay this\nand this\n\n## Slide 2: Only notes\n\nSpeaker notes:\nJust notes";
    expect(splitSections(text)).toEqual([
      { heading: "Slide 1: Title", body: "Body line", notes: "Say this\nand this" },
      { heading: "Slide 2: Only notes", body: "", notes: "Just notes" },
    ]);
  });

  it("does not treat other lines starting with ## as headings", () => {
    const text = "## Page 1\n\n## Not a heading\n<b>kept as text</b>";
    expect(splitSections(text)).toEqual([
      { heading: "Page 1", body: "## Not a heading\n<b>kept as text</b>", notes: null },
    ]);
  });

  it("keeps text before the first heading and returns nothing for nothing", () => {
    expect(splitSections("loose\n\n## Page 1\n\ntext")).toEqual([
      { heading: null, body: "loose", notes: null },
      { heading: "Page 1", body: "text", notes: null },
    ]);
    expect(splitSections("")).toEqual([]);
  });
});

describe("coverageNote", () => {
  const base: FileText = {
    name: "slides.pptx",
    kind: "pptx",
    unit: "slide",
    totalCount: 10,
    readCount: 10,
    stopped: null,
    text: "",
  };

  it("says nothing when the whole file was read", () => {
    expect(coverageNote(base)).toBeNull();
  });

  it("says how much is shown and why", () => {
    expect(coverageNote({ ...base, readCount: 4, stopped: "text-limit" })).toBe(
      "Only the first 4 of 10 slides are shown. The file has more text than Studiplan reads from one file.",
    );
    expect(coverageNote({ ...base, totalCount: 500, readCount: 200, stopped: "count-limit" })).toBe(
      "Only the first 200 of 500 slides are shown. The file has more slides than Studiplan reads from one file.",
    );
    expect(coverageNote({ ...base, unit: "page", readCount: 3, stopped: "time-limit" })).toBe(
      "Only the first 3 of 10 pages are shown. Reading took too long, so Studiplan stopped there.",
    );
  });

  it("covers a short count without a reason, and a reason without a short count", () => {
    expect(coverageNote({ ...base, readCount: 9 })).toBe(
      "Only the first 9 of 10 slides are shown. The rest could not be read.",
    );
    expect(coverageNote({ ...base, stopped: "text-limit" })).toBe(
      "The text stops before the end of the last slide. The file has more text than Studiplan reads from one file.",
    );
  });
});

describe("textlessNote", () => {
  const pdf: FileText = { name: "a.pdf", kind: "pdf", unit: "page", totalCount: 106, readCount: 106, stopped: null, text: "" };

  it("says nothing for an ordinary file or a few picture pages", () => {
    expect(textlessNote(pdf)).toBeNull();
    expect(textlessNote({ ...pdf, textlessCount: 0 })).toBeNull();
    expect(textlessNote({ ...pdf, textlessCount: 2 })).toBeNull();
    // Three pages or more, but under a tenth of the file.
    expect(textlessNote({ ...pdf, textlessCount: 10 })).toBeNull();
    expect(textlessNote({ ...pdf, readCount: 4, textlessCount: 2 })).toBeNull();
  });

  it("counts the pages from a tenth upward, and calls it mostly a scan from half upward", () => {
    expect(textlessNote({ ...pdf, textlessCount: 12 })?.title).toBe("12 of 106 pages are pictures with no readable text.");
    expect(textlessNote({ ...pdf, textlessCount: 96 })?.title).toBe(
      "Mostly a scan: 96 of 106 pages are pictures with no readable text.",
    );
    expect(textlessNote({ ...pdf, kind: "pptx", unit: "slide", readCount: 6, textlessCount: 3 })?.title).toBe(
      "Mostly pictures: 3 of 6 slides are pictures with no readable text.",
    );
  });
});

describe("textErrorTitle", () => {
  it("names each failure", () => {
    expect(textErrorTitle({ code: "no-text", message: "" }, "slide")).toBe("These slides have no text");
    expect(textErrorTitle({ code: "encrypted", message: "" }, "slide")).toBe("This file is password-protected");
    expect(textErrorTitle({ code: "io", message: "" }, "slide")).toBe("The text could not be read");
  });
});

describe("formatDuration", () => {
  it("words short and long waits", () => {
    expect(formatDuration(400)).toBe("under a second");
    expect(formatDuration(3240)).toBe("3.2 s");
    expect(formatDuration(14_600)).toBe("15 s");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
  });
});

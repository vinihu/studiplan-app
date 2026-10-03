import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  compareNames,
  firstFreeName,
  folderNameFromTitle,
  isHiddenName,
  isReservedDeviceName,
  isSafeSegment,
  MAX_FOLDER_NAME,
  nameKey,
  sanitiseName,
  storedFileName,
  truncate,
} from "./names";

describe("sanitiseName", () => {
  it("keeps ordinary names and Unicode as they are", () => {
    for (const name of ["Biology", "Maths 2", "Física", "Математика", "数学", "العربية", "Übungen (Teil 1)", "C++ & C#"]) {
      expect(sanitiseName(name), name).toBe(name);
    }
  });

  it("turns separators into dashes and drops the other forbidden characters", () => {
    expect(sanitiseName("Maths: Algebra")).toBe("Maths- Algebra");
    expect(sanitiseName("a/b\\c|d")).toBe("a-b-c-d");
    expect(sanitiseName('What is "DNA"?')).toBe("What is DNA");
    expect(sanitiseName("<b>*bold*</b>")).toBe("bbold-b");
  });

  it("removes control characters, collapses whitespace and trims dots and spaces at the ends", () => {
    expect(sanitiseName("  Cell \t\n division  ")).toBe("Cell division");
    expect(sanitiseName("a\u0000b\u001fc")).toBe("a b c");
    expect(sanitiseName("Biology...")).toBe("Biology");
    expect(sanitiseName("Biology. . ")).toBe("Biology");
    expect(sanitiseName("..hidden")).toBe("hidden");
    expect(sanitiseName("v1.2 notes")).toBe("v1.2 notes");
  });

  it("gives an empty string when nothing usable is left", () => {
    for (const name of ["", "   ", "...", "???", '<>"*', " . . ", "\u0000\u0001"]) {
      expect(sanitiseName(name), JSON.stringify(name)).toBe("");
    }
  });

  it("normalises to NFC so the same word typed two ways is one name", () => {
    expect(sanitiseName("Cafe\u0301")).toBe("Caf\u00e9");
    expect(nameKey("CAFE\u0301")).toBe(nameKey("caf\u00e9"));
  });
});

describe("reserved and hidden names", () => {
  it("recognises Windows device names in any case, with or without an extension", () => {
    for (const name of ["CON", "con", "PRN", "AUX", "nul", "COM1", "com9", "LPT1", "lpt0", "NUL.txt", "con.tar.gz", "COM¹", "aux .pdf"]) {
      expect(isReservedDeviceName(name), name).toBe(true);
    }
    for (const name of ["CONTENT", "COM", "COM10", "LPT", "console", "nulls", "a.con", "Biology"]) {
      expect(isReservedDeviceName(name), name).toBe(false);
    }
  });

  it("recognises files the system leaves behind", () => {
    for (const name of ["desktop.ini", "Desktop.ini", "Thumbs.db", ".DS_Store", ".git", "~$slides.pptx", "$RECYCLE.BIN"]) {
      expect(isHiddenName(name), name).toBe(true);
    }
    expect(isHiddenName("Biology")).toBe(false);
  });
});

describe("isSafeSegment", () => {
  it("accepts clean single names", () => {
    for (const name of ["Biology", "Cell division", "chapter-3.pdf", "notes-2026-10-02", "数学", ".incoming-ab12.part", "a.b.c"]) {
      expect(isSafeSegment(name), name).toBe(true);
    }
  });

  it("rejects anything that is not exactly one clean segment", () => {
    const bad: unknown[] = [
      "", ".", "..", "a/b", "a\\b", "../x", "..\\x", "/etc", "C:", "C:\\Windows", "C:x", "a:stream",
      "\\\\server\\share", "a\u0000b", "a\nb", "name.", "name ", " name", "name..", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b",
      "CON", "nul.txt", "x".repeat(256), null, undefined, 7, {}, ["a"],
    ];
    for (const value of bad) expect(isSafeSegment(value), JSON.stringify(value)).toBe(false);
  });
});

describe("derived names", () => {
  it("derives a material's folder from its title", () => {
    expect(folderNameFromTitle("Cell division")).toBe("Cell division");
    expect(folderNameFromTitle("What is DNA? (part 1/2)")).toBe("What is DNA (part 1-2)");
    expect(folderNameFromTitle("CON")).toBe("_CON");
    expect(folderNameFromTitle("???")).toBe("");
  });

  it("shortens a long title to a folder name that still ends cleanly", () => {
    const folder = folderNameFromTitle(`${"a".repeat(MAX_FOLDER_NAME - 1)} . tail`);
    expect(folder.length).toBeLessThanOrEqual(MAX_FOLDER_NAME);
    expect(folder).toBe("a".repeat(MAX_FOLDER_NAME - 1));
    expect(isSafeSegment(folder)).toBe(true);
  });

  it("never cuts a character in half", () => {
    expect(truncate("ab😀cd", 3)).toBe("ab");
    expect(truncate("ab😀cd", 4)).toBe("ab😀");
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("cleans a title without changing its characters", () => {
    expect(cleanTitle("  What is\n\t DNA?  ")).toBe("What is DNA?");
    expect(cleanTitle("\u0000")).toBe("");
  });

  it("builds a stored file name that is always a safe segment", () => {
    expect(storedFileName("chapter-3.PDF", ".pdf")).toBe("chapter-3.pdf");
    expect(storedFileName("My: slides?.pptx", ".pptx")).toBe("My- slides.pptx");
    expect(storedFileName("???.pdf", ".pdf")).toBe("file.pdf");
    expect(storedFileName(".pdf", ".pdf")).toBe("pdf.pdf");
    expect(storedFileName("con.pdf", ".pdf")).toBe("_con.pdf");
    expect(storedFileName("~$lock.pptx", ".pptx")).toBe("_~$lock.pptx");
    expect(storedFileName("report . .pdf", ".pdf")).toBe("report.pdf");

    const long = storedFileName(`${"é".repeat(300)}.pdf`, ".pdf");
    expect(long.length).toBe(80);
    expect(long.endsWith(".pdf")).toBe(true);
    for (const name of ["a/../../b.pdf", "..\\..\\x.pdf", "nul.pdf", " . .pdf"]) {
      expect(isSafeSegment(storedFileName(name, ".pdf")), name).toBe(true);
    }
  });

  it("finds the first free name, ignoring case", () => {
    const taken = new Set(["notes.pdf", "notes-2.pdf"].map(nameKey));
    expect(firstFreeName("other", ".pdf", taken)).toBe("other.pdf");
    expect(firstFreeName("Notes", ".pdf", taken)).toBe("Notes-3.pdf");
    expect(firstFreeName("notes-2026-10-02", "", new Set(["notes-2026-10-02"]))).toBe("notes-2026-10-02-2");
  });

  it("sorts names the way a person would", () => {
    expect(["Lecture 10", "lecture 2", "Lecture 1"].sort(compareNames)).toEqual(["Lecture 1", "lecture 2", "Lecture 10"]);
  });
});

import { describe, expect, it } from "vitest";
import type { AddFilesOutcome, LibraryResult, Material, MaterialFile, MaterialRef } from "@shared/library";
import {
  addToMaterial,
  hasProblems,
  NO_PATH_REASON,
  UNREADABLE_PHOTO_REASON,
} from "./add-to-material";
import { findSecondCopies } from "./add-to-material";
import type { AddDeps, AddProgress } from "./add-to-material";
import { fitWithin } from "./page-size";
import { classify, extensionOf, splitFiles, unsupportedReason } from "./split";
import type { PickedFile } from "./split";

const file = (name: string, type = ""): PickedFile => ({ name, type });

describe("extensionOf", () => {
  it("reads the last extension, lower-cased", () => {
    expect(extensionOf("Chapter 3.PDF")).toBe("pdf");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("returns nothing for names without one", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});

describe("classify", () => {
  it("takes PDFs and .pptx as documents whatever the reported type", () => {
    expect(classify(file("a.pdf", "application/pdf"))).toBe("document");
    expect(classify(file("A.PDF"))).toBe("document");
    expect(classify(file("slides.pptx"))).toBe("document");
  });

  it("takes images as photos, by extension or by type", () => {
    expect(classify(file("IMG_0012.JPG", "image/jpeg"))).toBe("photo");
    expect(classify(file("scan.png"))).toBe("photo");
    expect(classify(file("IMG_0013.HEIC"))).toBe("photo");
    expect(classify(file("pasted", "image/png"))).toBe("photo");
  });

  it("turns away everything else, including drawings and old PowerPoint", () => {
    expect(classify(file("logo.svg", "image/svg+xml"))).toBe("unsupported");
    expect(classify(file("old.ppt", "application/vnd.ms-powerpoint"))).toBe("unsupported");
    expect(classify(file("essay.docx"))).toBe("unsupported");
    expect(classify(file("A folder"))).toBe("unsupported");
  });
});

describe("splitFiles", () => {
  it("separates documents, photos and the rest, keeping the order", () => {
    const picked = [
      file("2.jpg"),
      file("notes.pdf"),
      file("1.jpg"),
      file("song.mp3"),
      file("slides.pptx"),
      file("3.png"),
    ];
    const split = splitFiles(picked);
    expect(split.documents.map((f) => f.name)).toEqual(["notes.pdf", "slides.pptx"]);
    expect(split.photos.map((f) => f.name)).toEqual(["2.jpg", "1.jpg", "3.png"]);
    expect(split.unsupported).toEqual([{ name: "song.mp3", reason: unsupportedReason("song.mp3") }]);
  });

  it("explains each refusal in a sentence that says what to do", () => {
    expect(unsupportedReason("song.mp3")).toMatch(/^\.mp3 files cannot be added\./);
    expect(unsupportedReason("old.ppt")).toContain("save it as .pptx");
    expect(unsupportedReason("essay.docx")).toContain("Save it as a PDF");
    expect(unsupportedReason("A folder")).toMatch(/^This cannot be added\./);
  });
});

describe("fitWithin", () => {
  it("scales the long side down to the limit and keeps the proportions", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1500, height: 2000 });
  });

  it("never enlarges and never returns zero", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1)).toEqual({ width: 2000, height: 1 });
  });
});

describe("addToMaterial", () => {
  const ref: MaterialRef = { subject: "Biology", material: "Cell division" };

  const emptyMaterial: Material = {
    id: "Cell division",
    subject: "Biology",
    title: "Cell division",
    created: "2026-10-02T09:30:00.000Z",
    fileCount: 0,
    setCount: 0,
    files: [],
  };

  /** A fake main process that records what it was asked to save. */
  function fakeLibrary(overrides: Partial<AddDeps<PickedFile>> = {}) {
    const calls: Array<{ call: string; detail: unknown }> = [];
    let material = emptyMaterial;
    const save = (added: Material["files"]): LibraryResult<AddFilesOutcome> => {
      material = { ...material, files: [...material.files, ...added], fileCount: material.fileCount + added.length };
      return { ok: true, value: { material, added, rejected: [] } };
    };
    const deps: AddDeps<PickedFile> = {
      pathFor: (f) => `C:\\Users\\student\\${f.name}`,
      toJpeg: async (f) => new TextEncoder().encode(f.name),
      addFiles: async (_ref, paths) => {
        calls.push({ call: "addFiles", detail: paths });
        return save(paths.map((path) => ({ name: path.split("\\").pop() ?? path, kind: "pdf", size: 1 })));
      },
      addPhotoSet: async (_ref, pages) => {
        calls.push({ call: "addPhotoSet", detail: pages.map((page) => new TextDecoder().decode(page)) });
        return save([
          { name: "notes-2026-10-02", kind: "photo-set", size: pages.length, pages: pages.map((_, i) => `page-${i + 1}.jpg`) },
        ]);
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it("copies documents by path and saves all photos as one set, in the user's order", async () => {
    const { deps, calls } = fakeLibrary();
    const report = await addToMaterial(
      ref,
      [file("b.jpg"), file("notes.pdf"), file("a.jpg"), file("slides.pptx"), file("c.png")],
      deps,
    );

    expect(calls).toEqual([
      { call: "addFiles", detail: ["C:\\Users\\student\\notes.pdf", "C:\\Users\\student\\slides.pptx"] },
      { call: "addPhotoSet", detail: ["b.jpg", "a.jpg", "c.png"] },
    ]);
    expect(report.added.map((f) => f.kind)).toEqual(["pdf", "pdf", "photo-set"]);
    expect(report.material?.files).toHaveLength(3);
    expect(hasProblems(report)).toBe(false);
  });

  it("makes no call for a kind that was not in the action", async () => {
    const { deps, calls } = fakeLibrary();
    await addToMaterial(ref, [file("notes.pdf")], deps);
    expect(calls.map((c) => c.call)).toEqual(["addFiles"]);

    const photosOnly = fakeLibrary();
    await addToMaterial(ref, [file("a.jpg")], photosOnly.deps);
    expect(photosOnly.calls.map((c) => c.call)).toEqual(["addPhotoSet"]);
  });

  it("reports unsupported files and still adds the rest", async () => {
    const { deps } = fakeLibrary();
    const report = await addToMaterial(ref, [file("song.mp3"), file("notes.pdf")], deps);
    expect(report.added).toHaveLength(1);
    expect(report.rejected).toEqual([{ name: "song.mp3", reason: unsupportedReason("song.mp3") }]);
    expect(hasProblems(report)).toBe(true);
  });

  it("skips a photo that cannot be read and keeps the others in order", async () => {
    const { deps, calls } = fakeLibrary({
      toJpeg: async (f) => {
        if (f.name === "broken.heic") throw new Error("cannot decode");
        return new TextEncoder().encode(f.name);
      },
    });
    const report = await addToMaterial(ref, [file("1.jpg"), file("broken.heic"), file("2.jpg")], deps);
    expect(calls).toEqual([{ call: "addPhotoSet", detail: ["1.jpg", "2.jpg"] }]);
    expect(report.rejected).toEqual([{ name: "broken.heic", reason: UNREADABLE_PHOTO_REASON }]);
  });

  it("saves no photo set when no photo could be read", async () => {
    const { deps, calls } = fakeLibrary({
      toJpeg: async () => {
        throw new Error("cannot decode");
      },
    });
    const report = await addToMaterial(ref, [file("a.heic")], deps);
    expect(calls).toEqual([]);
    expect(report.material).toBeNull();
    expect(report.rejected).toHaveLength(1);
  });

  it("turns away a document that has no place on disk", async () => {
    const { deps, calls } = fakeLibrary({ pathFor: () => "" });
    const report = await addToMaterial(ref, [file("notes.pdf")], deps);
    expect(calls).toEqual([]);
    expect(report.rejected).toEqual([{ name: "notes.pdf", reason: NO_PATH_REASON }]);
  });

  it("passes on what the library itself rejected", async () => {
    const { deps } = fakeLibrary({
      addFiles: async () => ({
        ok: true,
        value: {
          material: emptyMaterial,
          added: [],
          rejected: [{ name: "huge.pdf", reason: "This file is larger than Studiplan can take." }],
        },
      }),
    });
    const report = await addToMaterial(ref, [file("huge.pdf")], deps);
    expect(report.rejected).toEqual([
      { name: "huge.pdf", reason: "This file is larger than Studiplan can take." },
    ]);
    expect(report.material).toBe(emptyMaterial);
  });

  it("keeps the photos when copying the documents failed, and says what failed", async () => {
    const { deps } = fakeLibrary({
      addFiles: async () => ({ ok: false, error: { code: "io", message: "The disk is full." } }),
    });
    const report = await addToMaterial(ref, [file("notes.pdf"), file("a.jpg")], deps);
    expect(report.failures).toEqual(["The disk is full."]);
    expect(report.added.map((f) => f.kind)).toEqual(["photo-set"]);
    expect(report.material?.files).toHaveLength(1);
    expect(hasProblems(report)).toBe(true);
  });

  it("reports progress for every photo, then saving", async () => {
    const { deps } = fakeLibrary();
    const seen: AddProgress[] = [];
    await addToMaterial(ref, [file("a.jpg"), file("b.jpg")], deps, (p) => seen.push(p));
    expect(seen).toEqual([
      { step: "photos", done: 0, total: 2 },
      { step: "photos", done: 1, total: 2 },
      { step: "photos", done: 2, total: 2 },
      { step: "saving" },
    ]);
  });
});

describe("findSecondCopies", () => {
  const file = (name: string): MaterialFile => ({ name, kind: name.endsWith(".pptx") ? "pptx" : "pdf", size: 1 });

  it("finds a file that was saved under a numbered name because it was already there", () => {
    expect(findSecondCopies(["chapter.pdf", "slides.pptx"], [file("chapter-2.pdf"), file("slides.pptx")])).toEqual([
      { original: "chapter.pdf", savedAs: "chapter-2.pdf" },
    ]);
  });

  it("does not mistake a file whose own name ends in a number", () => {
    expect(findSecondCopies(["notes-2.pdf"], [file("notes-2.pdf")])).toEqual([]);
    expect(findSecondCopies(["notes.pdf", "notes-2.pdf"], [file("notes.pdf"), file("notes-2.pdf")])).toEqual([]);
    expect(findSecondCopies(["other.pdf"], [file("chapter-2.pdf")])).toEqual([]);
  });

  it("leaves photo sets alone", () => {
    expect(findSecondCopies(["notes.pdf"], [{ name: "notes-2", kind: "photo-set", size: 1, pages: [] }])).toEqual([]);
  });
});

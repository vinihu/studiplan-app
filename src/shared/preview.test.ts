import { describe, expect, it } from "vitest";
import { parsePreviewUrl, PREVIEW_SCHEME, previewUrl } from "./preview";

const ref = { subject: "Biology", material: "Cell division" };

describe("previewUrl", () => {
  it("builds the URL of a PDF and of a photo page", () => {
    expect(previewUrl(ref, "chapter-3.pdf")).toBe("studiplan-file://library/Biology/Cell%20division/chapter-3.pdf");
    expect(previewUrl(ref, "notes-2026-10-02", "page-1.jpg")).toBe(
      "studiplan-file://library/Biology/Cell%20division/notes-2026-10-02/page-1.jpg",
    );
  });

  it("round-trips names with spaces, non-ASCII letters, percent signs, hashes and plus signs", () => {
    const odd = { subject: "Bio & Chem 100%", material: "Ćwiczenie #3 (a+b) é 数学" };
    for (const [name, page] of [["Notes 50% done #2.pdf", undefined], ["notes x", "page-10.jpg"]] as const) {
      const url = previewUrl(odd, name, page);
      expect(url.startsWith(`${PREVIEW_SCHEME}://library/`)).toBe(true);
      expect(parsePreviewUrl(url)).toEqual({ ref: odd, name, ...(page === undefined ? {} : { page }) });
    }
  });

  it("keeps a name that tries to be a path inside one segment", () => {
    // The builder never produces a separator; the main process then refuses the name itself.
    const url = previewUrl({ subject: "..", material: "a/b" }, "..\\x.pdf");
    expect(url).toBe("studiplan-file://library/../a%2Fb/..%5Cx.pdf");
    expect(parsePreviewUrl(url)).toBeNull();
  });
});

describe("parsePreviewUrl", () => {
  it("accepts a fragment, which never reaches the handler anyway", () => {
    expect(parsePreviewUrl("studiplan-file://library/a/b/c.pdf#page=2")).toEqual({
      ref: { subject: "a", material: "b" },
      name: "c.pdf",
    });
  });

  it("refuses everything that is not exactly a preview URL", () => {
    const refused = [
      "",
      "not a url",
      "file:///C:/Windows/win.ini",
      "https://library/a/b/c.pdf",
      "studiplan-file://elsewhere/a/b/c.pdf",
      "studiplan-file://library:8080/a/b/c.pdf",
      "studiplan-file://user@library/a/b/c.pdf",
      "studiplan-file://library/a/b/c.pdf?download=1",
      // Too few and too many segments.
      "studiplan-file://library/",
      "studiplan-file://library/a",
      "studiplan-file://library/a/b",
      "studiplan-file://library/a/b/c/d/e.jpg",
      // Empty segments.
      "studiplan-file://library/a//c.pdf",
      "studiplan-file://library/a/b/c.pdf/",
      // Dot segments are folded away by URL parsing, which leaves too few segments.
      "studiplan-file://library/a/b/../c.pdf",
      "studiplan-file://library/a/b/%2e%2e/c.pdf",
      "studiplan-file://library/../../../a/b",
      // Encoded separators, control characters and bytes that do not decode.
      "studiplan-file://library/a/b/..%2F..%2Fsecret.pdf",
      "studiplan-file://library/a/b/..%5C..%5Csecret.pdf",
      "studiplan-file://library/a/b/c%00.pdf",
      "studiplan-file://library/a/b/c%0A.pdf",
      "studiplan-file://library/a/b/%E0%A4%A.pdf",
      "studiplan-file://library/a/b/%ff.pdf",
    ];
    for (const url of refused) expect(parsePreviewUrl(url), url).toBeNull();
  });

  it("hands on names it cannot judge, for the library's path check to refuse", () => {
    // `%2e%2e` that survives as its own segment, a drive letter, a device name: these are
    // syntactically one segment each. `resolveInside` is what refuses them.
    expect(parsePreviewUrl("studiplan-file://library/a/b/C%3A")?.name).toBe("C:");
    expect(parsePreviewUrl("studiplan-file://library/a/b/NUL.pdf")?.name).toBe("NUL.pdf");
  });
});

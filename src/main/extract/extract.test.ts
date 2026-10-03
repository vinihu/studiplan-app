import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { growthOfAsync } from "@shared/test-scaling";

import { PICTURE_ONLY_STREAM, lieAboutSizes, makePdf, makePptx, textStream } from "./fixtures";
import { extractPdfText, extractPptxText, extractText } from "./index";
import type { ExtractErrorCode, ExtractResult, ExtractedDocument } from "./index";

function value(result: ExtractResult): ExtractedDocument {
  if (!result.ok) throw new Error(`expected a document, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function failure(result: ExtractResult, code: ExtractErrorCode): string {
  if (result.ok) throw new Error(`expected ${code}, got a document`);
  expect(result.error.code).toBe(code);
  // A sentence for a student: no paths, no stack frames, no error class names.
  expect(result.error.message).not.toMatch(/[\\/]|Error|Exception|\bat\b .*:\d+/);
  expect(result.error.message.length).toBeGreaterThan(20);
  return result.error.message;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studiplan-extract-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PAGE_ONE = ["Mitosis has four phases: prophase, metaphase,", "anaphase and telophase."];
const PAGE_TWO = ["Meiosis halves the chromosome number."];

describe("extractPdfText", () => {
  it("reads every page in order, one section per page", async () => {
    const document = value(await extractPdfText(makePdf([textStream(PAGE_ONE), textStream(PAGE_TWO)])));
    expect(document.kind).toBe("pdf");
    expect(document.unit).toBe("page");
    expect(document.totalCount).toBe(2);
    expect(document.stopped).toBeNull();
    expect(document.sections.map((section) => section.number)).toEqual([1, 2]);
    expect(document.sections[0]?.body).toContain("Mitosis has four phases");
    expect(document.sections[0]?.body).toContain("anaphase and telophase.");
    expect(document.sections[1]?.body).toBe("Meiosis halves the chromosome number.");
    expect(document.text).toMatch(/^## Page 1\n\nMitosis[\s\S]*\n\n## Page 2\n\nMeiosis/);
  });

  it("reads a file from a path on disk and leaves the caller's bytes usable", async () => {
    const bytes = makePdf([textStream(PAGE_ONE)]);
    const path = join(dir, "chapter.pdf");
    await writeFile(path, bytes);
    expect(value(await extractPdfText(path)).totalCount).toBe(1);
    expect(value(await extractPdfText(bytes)).totalCount).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(value(await extractText("pdf", path)).sections).toHaveLength(1);
  });

  it("reports a PDF with no text layer distinctly", async () => {
    const message = failure(await extractPdfText(makePdf([PICTURE_ONLY_STREAM, PICTURE_ONLY_STREAM])), "no-text");
    expect(message).toMatch(/no readable text/);
  });

  it("refuses garbage bytes with a .pdf name", async () => {
    const path = join(dir, "garbage.pdf");
    await writeFile(path, Buffer.from("this is certainly not a pdf \u0000\u0001\u0002".repeat(50)));
    failure(await extractPdfText(path), "not-a-pdf");
    failure(await extractPdfText(new Uint8Array(0)), "not-a-pdf");
  });

  it("reports a PDF that starts right and is broken after that as damaged", async () => {
    const junk = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4000, 0x41)]);
    failure(await extractPdfText(junk), "corrupt");
    const whole = makePdf([textStream(PAGE_ONE)]);
    const result = await extractPdfText(whole.subarray(0, 120));
    expect(result.ok).toBe(false);
  });

  it("reports a password-protected PDF", async () => {
    const encrypted = makePdf(
      [textStream(PAGE_ONE)],
      `/Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >> ` +
        `/ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`,
    );
    const message = failure(await extractPdfText(encrypted), "encrypted");
    expect(message).toMatch(/password/);
  });

  it("reports a missing file without naming its path", async () => {
    failure(await extractPdfText(join(dir, "gone.pdf")), "unreadable");
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    failure(await extractPdfText(makePdf([textStream(PAGE_ONE)]), { signal: controller.signal }), "cancelled");
  });

  it("gives up at the time cap instead of hanging", async () => {
    failure(await extractPdfText(makePdf([textStream(PAGE_ONE)]), { timeoutMs: 0 }), "timeout");
  });
});

const LONG = "The cell membrane controls what enters and leaves the cell.";

describe("extractPptxText", () => {
  it("reads slides in presentation order, not file-name order, with titles and notes", async () => {
    const deck = await makePptx({
      slides: {
        1: { title: "Second: Mitosis", body: ["Prophase", "Metaphase"] },
        2: { title: "Third: Meiosis", body: [LONG] },
        3: { title: "First: The cell", body: ["Nucleus & <cytoplasm>"], notes: ["Remember to mention ribosomes."] },
      },
      order: [3, 1, 2],
    });
    const document = value(await extractPptxText(deck));
    expect(document.unit).toBe("slide");
    expect(document.totalCount).toBe(3);
    expect(document.sections.map((section) => section.title)).toEqual([
      "First: The cell",
      "Second: Mitosis",
      "Third: Meiosis",
    ]);
    expect(document.sections[0]).toEqual({
      number: 1,
      title: "First: The cell",
      body: "Nucleus & <cytoplasm>",
      notes: "Remember to mention ribosomes.",
    });
    expect(document.sections[1]?.body).toBe("Prophase\nMetaphase");
    expect(document.sections[1]?.notes).toBeNull();
    expect(document.text).toContain(
      "## Slide 1: First: The cell\n\nNucleus & <cytoplasm>\n\nSpeaker notes:\nRemember to mention ribosomes.\n\n## Slide 2: Second: Mitosis",
    );
    expect(value(await extractText("pptx", deck)).totalCount).toBe(3);
  });

  it("falls back to file-name order when the deck has no presentation part", async () => {
    const deck = await makePptx({ slides: { 10: { title: "Ten", body: [LONG] }, 2: { title: "Two", body: [LONG] } } });
    const document = value(await extractPptxText(deck));
    expect(document.sections.map((section) => section.title)).toEqual(["Two", "Ten"]);
  });

  it("never follows a relationship out of the archive's slide folder", async () => {
    const deck = await makePptx({
      slides: { 1: { title: "Real slide", body: [LONG] } },
      order: [1],
      extraPresentationRels: [
        { id: "rIdA", target: "../../../../secret.xml" },
        { id: "rIdB", target: "../docProps/secret.xml" },
        { id: "rIdC", target: "file:///C:/Windows/win.ini", external: true },
        { id: "rIdD", target: "https://example.com/slide.xml", external: true },
        { id: "rIdE", target: "/docProps/secret.xml" },
      ],
      extraFiles: {
        "docProps/secret.xml": `<a:p><a:t>SECRET OUTSIDE SLIDES</a:t></a:p>`,
        "secret.xml": `<a:p><a:t>SECRET OUTSIDE SLIDES</a:t></a:p>`,
      },
    });
    const document = value(await extractPptxText(deck));
    expect(document.totalCount).toBe(1);
    expect(document.text).not.toContain("SECRET");
    expect(document.sections[0]?.title).toBe("Real slide");
  });

  it("does not expand entities a slide defines for itself", async () => {
    const deck = await makePptx({
      slides: {
        1: {
          title: "Entities",
          prolog:
            '<!DOCTYPE p:sld [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
            '<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>',
          rawBody: ["&lol2; and &xxe; stay as written, &amp; &#65;&#x42; are decoded, &#xD800;&#0; are not."],
        },
      },
      order: [1],
    });
    const document = value(await extractPptxText(deck));
    expect(document.sections[0]?.body).toBe(
      "&lol2; and &xxe; stay as written, & AB are decoded, &#xD800; are not.",
    );
  });

  it("reads unclosed and nested-looking markup in linear time", async () => {
    const hostileDeck = (size: number): Promise<Uint8Array> =>
      makePptx({
        slides: { 1: { title: "Fine", body: [LONG] } },
        order: [1],
        extraFiles: {
          "ppt/slides/slide1.xml": `<p:sld>${"<a:p ".repeat(size)}${"<a:t>".repeat(size)}${"<p:sp ".repeat(size)}<a:p><a:t>${LONG}</a:t></a:p>`,
        },
      });
    const result = await extractPptxText(await hostileDeck(200_000));
    expect(result.ok || result.error.code === "no-text").toBe(true);
    // Four times the markup takes about four times as long, not sixteen: no bound in milliseconds.
    expect(await growthOfAsync(hostileDeck, extractPptxText, 50_000)).toMatchObject({ linear: true });
  }, 120_000);

  it("refuses a file that is not a zip", async () => {
    failure(await extractPptxText(Buffer.from("just some text pretending to be slides")), "not-a-pptx");
    failure(await extractPptxText(makePdf([textStream(PAGE_ONE)])), "not-a-pptx");
  });

  it("reports a zip that is cut off as damaged", async () => {
    const deck = await makePptx({ slides: { 1: { title: "One", body: [LONG] } }, order: [1] });
    failure(await extractPptxText(deck.subarray(0, Math.floor(deck.length / 2))), "corrupt");
  });

  it("reports an old or password-protected PowerPoint file", async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    failure(await extractPptxText(ole), "encrypted");
  });

  it("reports a zip with no slides, and slides with no text", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a deck");
    failure(await extractPptxText(await zip.generateAsync({ type: "uint8array" })), "no-slides");

    const pictures = await makePptx({ slides: { 1: {}, 2: {} }, order: [1, 2] });
    failure(await extractPptxText(pictures), "no-text");
  });

  it("refuses a zip bomb by its declared size", async () => {
    const bomb = await makePptx({
      slides: { 1: { title: "One", body: [LONG] } },
      order: [1],
      extraFiles: { "ppt/slides/slide1.xml": new Uint8Array(40 * 1024 * 1024).fill(0x20) },
    });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    failure(await extractPptxText(bomb), "too-large");
  });

  it("refuses a zip bomb that lies about its size, by counting what comes out", async () => {
    const bomb = lieAboutSizes(
      await makePptx({
        slides: { 1: { title: "One", body: [LONG] } },
        order: [1],
        extraFiles: { "ppt/slides/slide1.xml": new Uint8Array(40 * 1024 * 1024).fill(0x20) },
      }),
      1024 * 1024,
      512,
    );
    failure(await extractPptxText(bomb), "too-large");
  });

  it("refuses many medium parts that add up to too much", async () => {
    const slides: Record<number, { title: string }> = {};
    const extraFiles: Record<string, Uint8Array> = {};
    const filler = new Uint8Array(7 * 1024 * 1024).fill(0x20);
    for (let number = 1; number <= 12; number += 1) {
      slides[number] = { title: `Slide ${number}` };
      extraFiles[`ppt/slides/slide${number}.xml`] = filler;
    }
    const bomb = await makePptx({ slides, order: Object.keys(slides).map(Number), extraFiles });
    failure(await extractPptxText(bomb), "too-large");
    // Packing 84 MB for the fixture takes seconds on a busy machine: this is no test of speed.
  }, 120_000);

  it("refuses an archive with an absurd number of entries", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 10_050; index += 1) zip.file(`ppt/slides/slide${index}.xml`, "");
    const archive = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    failure(await extractPptxText(archive), "too-large");
  }, 120_000);
});

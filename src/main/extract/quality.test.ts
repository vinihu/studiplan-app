/**
 * What real files taught the extractor: scans behind a page of text, running headers, look-alike
 * characters, lost formulas, hidden slides.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PICTURE_ONLY_STREAM, makePdf, makePptx, textStream } from "./fixtures";
import { buildPromptContent, extractPdfText, extractPptxText } from "./index";
import type { ExtractResult, ExtractedDocument, ExtractedSection } from "./index";
import { formulasWereLost, hasText, plainCharacters, stripRepeatedEdgeLines, tidy } from "./shared";

function value(result: ExtractResult): ExtractedDocument {
  if (!result.ok) throw new Error(`expected a document, got ${result.error.code}`);
  return result.value;
}

const page = (body: string, number = 1): ExtractedSection => ({ number, title: null, body, notes: null });

const TEXT_PAGE = textStream(["Cellular respiration turns glucose into ATP in three stages.", "Glycolysis happens in the cytoplasm."]);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studiplan-quality-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pdfFile(name: string, pages: string[]): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, makePdf(pages));
  return file;
}

describe("look-alike characters", () => {
  it("turns Kangxi radicals into the characters they stand for", () => {
    // 用 ⽤ (U+2F64), 光 ⽔… as a PDF font may map them.
    expect(plainCharacters("作⽤")).toBe("作用");
    expect(plainCharacters("⼀⼈⽤⿕")).toBe("一人用龠");
    expect([...plainCharacters("⽤")].map((c) => c.codePointAt(0)?.toString(16))).toEqual(["7528"]);
    // The radicals supplement, where it has an ordinary form.
    expect(plainCharacters("⺟⻳")).toBe("母龟");
    expect(tidy("光合作⽤  是")).toBe("光合作用 是");
    // The supplement's radicals that Unicode's normalisation leaves alone: 可⻅光, 生⻓, ⻝物.
    expect(plainCharacters("可⻅光 生⻓ ⻝物 卡⻔ ⻢库斯 ⻚面 ⻨ 视⻩醛 周云⻰")).toBe(
      "可见光 生长 食物 卡门 马库斯 页面 麦 视黄醛 周云龙",
    );
    // A radical that is only a component has no ordinary form and stays.
    expect(plainCharacters("⺡⻌")).toBe("⺡⻌");
  });

  it("opens Latin ligatures", () => {
    expect(plainCharacters("eﬃcient ﬁlter, ﬂow, oﬀer, ﬄe")).toBe("efficient filter, flow, offer, ffle");
  });

  it("leaves everything a blanket normalisation would damage", () => {
    const kept = "x² + y³ = ½ · 10⁻³ m/s², H₂O, ™, ①, ｆｕｌｌ, é, ß, Å, 用, ㎏";
    expect(plainCharacters(kept)).toBe(kept);
    expect(kept.normalize("NFKC")).not.toBe(kept);
  });
});

describe("pages without text", () => {
  it("counts them, and says nothing when the whole file has text", async () => {
    const document = value(await extractPdfText(await pdfFile("text.pdf", [TEXT_PAGE, TEXT_PAGE, TEXT_PAGE])));
    expect(document.textlessCount).toBe(0);
    expect(hasText(page("x".repeat(19)))).toBe(false);
    expect(hasText(page("x".repeat(20)))).toBe(true);
    expect(hasText(page("  12  \n"))).toBe(false);
  });

  it("sees a scan behind one page of text for what it is", async () => {
    const file = await pdfFile("google-scan.pdf", [TEXT_PAGE, ...Array.from({ length: 9 }, () => PICTURE_ONLY_STREAM)]);
    const document = value(await extractPdfText(file));
    expect(document.textlessCount).toBe(9);

    const content = await buildPromptContent([{ name: "google-scan.pdf", kind: "pdf", path: file }]);
    expect(content.complete).toBe(false);
    expect(content.notices).toEqual([
      {
        type: "pages-without-text",
        file: "google-scan.pdf",
        textless: 9,
        total: 10,
        mostly: true,
        message:
          '"google-scan.pdf" is mostly a scan: 9 of the 10 pages have no readable text (they are pictures), so only the rest was sent. Add photos of the pages you need.',
      },
    ]);
    // The text there is still goes, for an AI that cannot be handed the file.
    expect(content.parts).toHaveLength(1);
  });

  it("mentions more than a few picture pages among text pages, without calling the file a scan", async () => {
    const pages = [...Array.from({ length: 7 }, () => TEXT_PAGE), ...Array.from({ length: 3 }, () => PICTURE_ONLY_STREAM)];
    const file = await pdfFile("partly.pdf", pages);
    const content = await buildPromptContent([{ name: "partly.pdf", kind: "pdf", path: file }]);
    expect(content.notices).toHaveLength(1);
    expect(content.notices[0]).toMatchObject({ type: "pages-without-text", textless: 3, total: 10, mostly: false });
    expect(content.notices[0]?.message).toBe(
      '3 of the 10 pages of "partly.pdf" have no readable text (they are pictures) and were not sent. Add photos of those pages if they matter.',
    );
  });

  it("stays quiet about a figure page or two in a chapter", async () => {
    const pages = [...Array.from({ length: 24 }, () => TEXT_PAGE), PICTURE_ONLY_STREAM, PICTURE_ONLY_STREAM];
    const file = await pdfFile("chapter.pdf", pages);
    expect(value(await extractPdfText(file)).textlessCount).toBe(2);
    const content = await buildPromptContent([{ name: "chapter.pdf", kind: "pdf", path: file }]);
    expect(content.notices).toEqual([]);
    expect(content.complete).toBe(true);

    // Three, but in a long file: under a tenth of it.
    const long = await pdfFile("long.pdf", [...Array.from({ length: 40 }, () => TEXT_PAGE), ...Array.from({ length: 3 }, () => PICTURE_ONLY_STREAM)]);
    expect((await buildPromptContent([{ name: "long.pdf", kind: "pdf", path: long }])).notices).toEqual([]);
  });

  it("does not count picture-only slides against a deck", async () => {
    const deck = join(dir, "deck.pptx");
    await writeFile(
      deck,
      await makePptx({
        order: [1, 2, 3, 4],
        slides: {
          1: { title: "Cellular respiration", body: ["Glycolysis, the citric acid cycle and oxidative phosphorylation."] },
          2: {},
          3: {},
          4: {},
        },
      }),
    );
    expect(value(await extractPptxText(deck)).textlessCount).toBe(3);
    expect((await buildPromptContent([{ name: "deck.pptx", kind: "pptx", path: deck }])).notices).toEqual([]);
  });
});

describe("running headers and footers", () => {
  const WORDS = ["glucose", "pyruvate", "acetyl", "citrate", "oxygen", "proton", "electron", "enzyme", "membrane", "gradient"];
  const body = (n: number): string =>
    `The ${WORDS[n]} step comes first here.\nThen ${WORDS[n]} is changed again.\nA third line about ${WORDS[n]}.\nA fourth line about ${WORDS[n]}.\nThe ${WORDS[n]} part ends here.`;

  it("removes a line that repeats at the edge of many pages, numbers aside", () => {
    const sections = Array.from({ length: 10 }, (_, index) =>
      page(
        index % 2 === 0
          ? `Access for free at openstax.org\n${body(index)}\n${190 + index} 7 • Cellular Respiration`
          : `${body(index)}\n7.${index} • Glycolysis ${190 + index}\nAccess for free at openstax.org`,
        index + 1,
      ),
    );
    const removed = stripRepeatedEdgeLines(sections);
    // "Access for free…" on all ten, "# # • Cellular Respiration" on five and
    // "#.# • Glycolysis #" on five: each is one line, numbers aside.
    expect(removed).toBe(20);
    for (const [index, section] of sections.entries()) {
      expect(section.body).toBe(body(index));
    }
  });

  it("leaves a line that repeats inside the text, a short file, and a line on few pages", () => {
    const L = "abcdefghij";
    const inside = Array.from({ length: 10 }, (_, index) => page(`First ${L[index]} line\nSecond ${L[index]} word\nRemember: energy is conserved.\nFourth ${L[index]} word\nFifth ${L[index]} word\nLast ${L[index]} word`, index + 1));
    const before = inside.map((section) => section.body);
    expect(stripRepeatedEdgeLines(inside)).toBe(0);
    expect(inside.map((section) => section.body)).toEqual(before);

    const short = Array.from({ length: 5 }, (_, index) => page(`Header\nText ${L[index]} alpha\nMore ${L[index]} beta\nAnd ${L[index]} gamma\nThen ${L[index]} delta\nFooter`, index + 1));
    expect(stripRepeatedEdgeLines(short)).toBe(0);

    // A page of a few lines is all edges: left alone.
    const tiny = Array.from({ length: 10 }, () => page("Header line of the deck\nOne point on this slide\nFooter line of the deck"));
    expect(stripRepeatedEdgeLines(tiny)).toBe(0);

    const few = Array.from({ length: 10 }, (_, index) => page(`${index < 3 ? "Chapter opener" : `Unique top ${L[index]}`}\nNext ${L[index]}\nText ${L[index]}\nMore ${L[index]}\nEnd ${L[index]}\nLast ${L[index]}`, index + 1));
    expect(stripRepeatedEdgeLines(few)).toBe(0);
    expect(few[0]?.body).toContain("Chapter opener");
  });

  it("is applied to a real PDF's pages, and never turns a text file into an empty one", async () => {
    const STEPS = ["citrate", "isocitrate", "ketoglutarate", "succinyl", "succinate", "fumarate", "malate", "oxaloacetate"];
    const pages = STEPS.map((step, index) =>
      textStream([
        "Lecture notes by A. Author",
        `Now ${step} is formed in the cycle.`,
        `An enzyme acts on ${step}.`,
        `Energy leaves ${step} as NADH.`,
        `What follows ${step} is next.`,
        `- ${index + 1} -`,
      ]),
    );
    const document = value(await extractPdfText(await pdfFile("notes.pdf", pages)));
    expect(document.text).not.toContain("Lecture notes by A. Author");
    expect(document.text).not.toMatch(/^- \d -$/m);
    expect(document.text).toContain("Now oxaloacetate is formed in the cycle.");
    expect(document.text).toContain("What follows citrate is next.");
    expect(document.textlessCount).toBe(0);

    // Pages that are all alike (a form printed eight times) keep their text.
    const same = value(await extractPdfText(await pdfFile("same.pdf", Array.from({ length: 8 }, () => textStream(["Name:", "Date:", "Answer the five questions below.", "Question one", "Question two", "Sign here"])))));
    expect(same.textlessCount).toBe(0);
    expect(same.text).toContain("Answer the five questions below.");
  });
});

describe("lost formulas", () => {
  it("recognises what is left of formulas the PDF has no characters for", () => {
    const lines = ["The equation of motion is", "( ( ) ) (2.1)", "where", "( )", "is the stiffness and", "( ) ( ) (2.58)", "follows."];
    const sections = [page(Array.from({ length: 4 }, () => lines.join("\n")).join("\n"))];
    expect(formulasWereLost(sections)).toBe(true);
  });

  it("is not fooled by equation numbers, lists, tables of numbers or a few stray brackets", () => {
    const ordinary = [
      "(2.5)",
      "(a) first, (b) second",
      "1) 2) 3)",
      "12.5  13.0  14.2",
      "f(x) = x^2 + 1",
      "v = s / t (3.1)",
      "E = m c^2",
      "( )",
      "( ) ( )",
      "10.6).",
      "2023]).",
      "= 110",
    ];
    expect(formulasWereLost([page(Array.from({ length: 8 }, () => ordinary.join("\n")).join("\n"))])).toBe(true);
    // The two empty-bracket lines above repeat 8 times = 16: that many are no accident. Fewer are.
    expect(formulasWereLost([page(Array.from({ length: 4 }, () => ordinary.join("\n")).join("\n"))])).toBe(false);
    expect(formulasWereLost([page(ordinary.filter((line) => !/\(\s*\)/.test(line)).join("\n").repeat(50))])).toBe(false);
  });

  it("puts a notice on the request, with the file still sent", async () => {
    const leftovers = Array.from({ length: 12 }, (_, index) => `( ( ) ) (2.${index + 1})`);
    const file = await pdfFile("formulas.pdf", [textStream(["The equations of motion of the wing section follow."]), textStream(leftovers.map((line) => line.replace(/[()]/g, "\\$&")))]);
    const document = value(await extractPdfText(file));
    expect(document.formulasLost).toBe(true);
    const content = await buildPromptContent([{ name: "formulas.pdf", kind: "pdf", path: file }]);
    expect(content.parts).toHaveLength(1);
    expect(content.notices.map((notice) => notice.type)).toEqual(["formulas-lost"]);
    expect(content.notices[0]?.message).toBe(
      'The formulas in "formulas.pdf" could not be read as text, so what is made from it may miss them or get them wrong. Add photos of the pages with the formulas.',
    );
  });
});

describe("hidden slides", () => {
  it("are read and marked", async () => {
    const deck = join(dir, "hidden.pptx");
    await writeFile(
      deck,
      await makePptx({
        order: [1, 2],
        slides: {
          1: { title: "Shown", body: ["This slide is part of the talk and has enough text."] },
          2: { title: "Backup", body: ["This slide was hidden by the presenter."], hidden: true },
        },
      }),
    );
    const document = value(await extractPptxText(deck));
    expect(document.sections.map((section) => section.hidden === true)).toEqual([false, true]);
    expect(document.text).toContain("## Slide 1: Shown");
    expect(document.text).toContain("## Slide 2 (hidden): Backup");
    expect(document.text).toContain("hidden by the presenter");
  });
});

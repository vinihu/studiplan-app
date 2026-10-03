/**
 * Files built to be slow. Reading one must not hold the process up: the time limit has to end
 * it and a cancel has to arrive. Each test fails on a reader that computes without a pause.
 *
 * The bounds are generous on purpose: they tell "stopped when told" from "ran to the end",
 * which for these files is tens of seconds to hours.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { growthOfAsync } from "@shared/test-scaling";
import { extractPdfText } from "./pdf";
import { extractPptxText } from "./pptx";
import { makePdf, makePptx, slideXml, textStream } from "./fixtures";
import { createIsolatedExtractor } from "./isolated";
import type { ExtractAnswer, ExtractJob, RunningJob } from "./isolated";
import { MAX_PAGE_CHARS } from "./limits";
import { startExtractWorker } from "./worker-host";

/** A PDF from raw objects (1-based), with a correct cross-reference table. */
function rawPdf(objects: string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/**
 * One page that draws a form `fanOut` times, which draws the next form `fanOut` times, and so
 * on for `levels` levels; the last one writes a word. A couple of kilobytes that stand for
 * `fanOut ** levels` pieces of text.
 */
function nestedFormsPdf(levels: number, fanOut: number): Uint8Array {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Count 1 /Kids [4 0 R] >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const form = (level: number): number => 6 + level;
  const page = `${"/X Do ".repeat(fanOut)}`;
  objects[4] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /X ${form(0)} 0 R >> >> /Contents 5 0 R >>`;
  objects[5] = `<< /Length ${page.length} >>\nstream\n${page}\nendstream`;
  for (let level = 0; level < levels; level += 1) {
    const last = level === levels - 1;
    const stream = last ? "BT /F1 12 Tf 72 720 Td (word) Tj ET" : "/X Do ".repeat(fanOut);
    const resources = last ? "/Font << /F1 3 0 R >>" : `/XObject << /X ${form(level + 1)} 0 R >>`;
    objects[form(level)] =
      `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${resources} >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  return rawPdf(objects);
}

/** Counts how often a timer gets its turn while `work` runs. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 5);
  const started = Date.now();
  try {
    const value = await work();
    return { value, ticks, ms: Date.now() - started };
  } finally {
    clearInterval(timer);
  }
}

describe("reading a PDF leaves room for everything else", () => {
  it("lets timers run between the pages of a long file", async () => {
    const pages = Array.from({ length: 120 }, (_, index) => textStream([`Page ${index + 1} has a line of text.`]));
    const { value, ticks } = await ticksDuring(() => extractPdfText(makePdf(pages)));
    expect(value.ok).toBe(true);
    expect(ticks).toBeGreaterThan(5);
  });

  it("stops a page with hundreds of thousands of text operations when cancelled", async () => {
    const page = `BT /F1 12 Tf 72 720 Td ${"(a) Tj ".repeat(400_000)}ET`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { value, ms } = await ticksDuring(() => extractPdfText(makePdf([page]), { signal: controller.signal, timeoutMs: 20_000 }));
    expect(value).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  it("does not run to the end of a tiny file that stands for millions of pieces of text", async () => {
    // 2 KB; five levels of thirty: 24 million words, minutes of computing if read to the end.
    const bytes = nestedFormsPdf(5, 30);
    expect(bytes.length).toBeLessThan(4_000);
    const { ms, ticks } = await ticksDuring(() => extractPdfText(bytes, { timeoutMs: 300 }));
    expect(ms).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(5);
  }, 60_000);

  it("stops at the time limit inside one enormous page, and keeps no more than a page's worth of text", async () => {
    const page = `BT /F1 12 Tf 72 720 Td ${"(abcdefghij) Tj ".repeat(30_000)}ET`;
    const { value, ms } = await ticksDuring(() => extractPdfText(makePdf([page]), { timeoutMs: 30_000 }));
    expect(ms).toBeLessThan(20_000);
    expect(value.ok).toBe(true);
    if (value.ok) expect(value.value.sections[0]?.body.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
  }, 40_000);

});

describe("reading a deck does not slow down on a file built for it", () => {
  it("reads a slide made of nothing but opening tags in no time", async () => {
    // Under 1 KB packed. A pattern that starts over at every `<p:sld` took seconds here, and
    // hours at the size a slide may have.
    const deck = await makePptx({ slides: { 1: { title: "x" } }, order: [1], extraFiles: { "ppt/slides/slide1.xml": "<p:sld".repeat(40_000) } });
    expect((await extractPptxText(deck)).ok).toBe(false);
    // Four times the tags take about four times as long, not sixteen: no bound in milliseconds.
    const deckOf = (size: number) => makePptx({ slides: { 1: { title: "x" } }, order: [1], extraFiles: { "ppt/slides/slide1.xml": "<p:sld".repeat(size) } });
    expect(await growthOfAsync(deckOf, extractPptxText, 40_000)).toMatchObject({ linear: true });
  }, 30_000);

  it("reads a title with tens of thousands of unusual line separators in no time", async () => {
    const deck = await makePptx({ slides: { 1: { title: `${"\u2028".repeat(40_000)}Cell division`, body: ["Mitosis makes two identical cells, each with the same chromosomes."] } }, order: [1] });
    const value = await extractPptxText(deck);
    const separator = String.fromCharCode(0x2028);
    const deckOf = (size: number) =>
      makePptx({ slides: { 1: { title: `${separator.repeat(size)}Cell division`, body: ["Mitosis makes two identical cells, each with the same chromosomes."] } }, order: [1] });
    expect(await growthOfAsync(deckOf, extractPptxText, 40_000)).toMatchObject({ linear: true });
    expect(value.ok).toBe(true);
    if (value.ok) expect(value.value.sections[0]?.title).toContain("Cell division");
  }, 30_000);

  it("keeps a title on one line", async () => {
    const xml = slideXml({ body: ["Body text of the slide, long enough to count as text."] }, 1).replace(
      "<p:spTree>",
      '<p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>First line</a:t></a:r></a:p><a:p><a:r><a:t>second line</a:t></a:r></a:p></p:txBody></p:sp>',
    );
    const result = await extractPptxText(await makePptx({ slides: { 1: {} }, order: [1], extraFiles: { "ppt/slides/slide1.xml": xml } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sections[0]?.title).toBe("First line second line");
  });

  it("refuses an archive that carries far more directory records than it declares, before indexing it", async () => {
    const deck = Buffer.from(await makePptx({ slides: { 1: { title: "x", body: ["y"] } }, order: [1] }));
    const end = deck.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const directoryAt = deck.readUInt32LE(end + 16);
    const directory = deck.subarray(directoryAt, end);
    const records = deck.readUInt16LE(end + 10);
    // The same directory 4,000 times over; the end record still says what it said.
    const bloated = Buffer.concat([deck.subarray(0, directoryAt), ...Array.from({ length: 4_000 }, () => directory), deck.subarray(end)]);
    expect(records * 4_000).toBeGreaterThan(10_000);
    // Refused from what the directory says, before anything is indexed: that it is refused is the test.
    expect(await extractPptxText(new Uint8Array(bloated))).toMatchObject({ ok: false, error: { code: "too-large" } });
  });

  it("refuses a zip64 archive", async () => {
    const deck = Buffer.from(await makePptx({ slides: { 1: { title: "x", body: ["y"] } }, order: [1] }));
    const end = deck.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const locator = Buffer.alloc(20);
    locator.set([0x50, 0x4b, 0x06, 0x07]);
    const zip64 = Buffer.concat([deck.subarray(0, end), locator, deck.subarray(end)]);
    expect(await extractPptxText(new Uint8Array(zip64))).toMatchObject({ ok: false, error: { code: "too-large" } });
    // The ordinary one is still read.
    expect((await extractPptxText(new Uint8Array(deck))).ok).toBe(false);
    expect(await extractPptxText(new Uint8Array(deck))).not.toMatchObject({ error: { code: "too-large" } });
  });
});

describe("a file that cannot be stopped from inside is stopped from outside", () => {
  // The real worker script, built the way the app's is (dependencies stay outside it), and the
  // real host that starts and ends it.
  const built = path.join(import.meta.dirname, "../../../node_modules/.cache/studiplan-worker-test");
  let start: (job: ExtractJob) => RunningJob;

  beforeAll(async () => {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: path.join(import.meta.dirname, "worker.ts"),
        outDir: built,
        emptyOutDir: true,
        rollupOptions: { output: { format: "es", entryFileNames: "worker.mjs" } },
      },
    });
    start = startExtractWorker(path.join(built, "worker.mjs"));
  }, 60_000);

  afterAll(async () => {
    await rm(built, { recursive: true, force: true });
  });

  it("reads an ordinary file in the worker", async () => {
    const extractor = createIsolatedExtractor({ start });
    const result = await extractor.extractText("pdf", makePdf([textStream(["Mitosis makes two identical cells, each with the same chromosomes."])]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toContain("Mitosis makes two identical cells,");
    expect(await extractor.countPdfPages(makePdf([textStream(["one"]), textStream(["two"])]))).toBe(2);
  }, 30_000);

  it("ends a tiny file that stands for millions of pieces of text at the time limit, while timers keep running", async () => {
    // 2 KB; five levels of thirty: 24 million words. Read in this thread it computes for minutes
    // without a pause, and neither a time limit nor a cancel gets through.
    const bytes = nestedFormsPdf(5, 30);
    expect(bytes.length).toBeLessThan(4_000);
    const extractor = createIsolatedExtractor({ start, graceMs: 300 });
    const { value, ticks, ms } = await ticksDuring(() => extractor.extractText("pdf", bytes, { timeoutMs: 300 }));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(10_000);
    // The thread that asked was free the whole time.
    expect(ticks).toBeGreaterThan(10);
  }, 60_000);

  it("ends the same file at once when cancelled", async () => {
    const extractor = createIsolatedExtractor({ start });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { value, ms } = await ticksDuring(() => extractor.extractText("pdf", nestedFormsPdf(5, 30), { signal: controller.signal }));
    expect(value).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});

describe("the stoppable worker", () => {
  const TEXT: ExtractAnswer = { type: "text", result: { ok: false, error: { code: "no-text", message: "x" } } };

  /** A stand-in for the worker: answers when told to, and records being ended. */
  function fakeWorker(behave: (job: ExtractJob) => Promise<ExtractAnswer>) {
    const jobs: Array<{ job: ExtractJob; terminated: boolean }> = [];
    const start = (job: ExtractJob): RunningJob => {
      const entry = { job, terminated: false };
      jobs.push(entry);
      return { answer: behave(job), terminate: () => (entry.terminated = true) };
    };
    return { jobs, start };
  }
  const never = (): Promise<ExtractAnswer> => new Promise(() => {});

  it("hands back the worker's answer and ends the worker", async () => {
    const worker = fakeWorker(async () => TEXT);
    const extractor = createIsolatedExtractor({ start: worker.start });
    expect(await extractor.extractText("pdf", "C:/x.pdf")).toEqual((TEXT as { result: unknown }).result);
    expect(worker.jobs).toHaveLength(1);
    expect(worker.jobs[0]).toMatchObject({ terminated: true, job: { type: "text", kind: "pdf", input: "C:/x.pdf", timeoutMs: 30_000 } });
    expect(extractor.pending).toBe(0);
  });

  it("ends a worker that never answers when its time is over, and says so", async () => {
    const worker = fakeWorker(never);
    const extractor = createIsolatedExtractor({ start: worker.start, graceMs: 50 });
    const started = Date.now();
    expect(await extractor.extractText("pdf", "C:/x.pdf", { timeoutMs: 100 })).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(worker.jobs[0]?.terminated).toBe(true);
    expect(await extractor.countPdfPages("C:/x.pdf", { timeoutMs: 50 })).toBeNull();
    expect(worker.jobs[1]?.terminated).toBe(true);
  });

  it("ends the worker at once when the caller cancels", async () => {
    const worker = fakeWorker(never);
    const extractor = createIsolatedExtractor({ start: worker.start });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    expect(await extractor.extractText("pptx", "C:/x.pptx", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(worker.jobs[0]?.terminated).toBe(true);
    // Cancelled before it started: no worker at all.
    expect(await extractor.extractText("pdf", "C:/y.pdf", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(worker.jobs).toHaveLength(1);
  });

  it("reports a worker that dies, or answers something else, as an unreadable file", async () => {
    const dying = createIsolatedExtractor({ start: fakeWorker(() => Promise.reject(new Error("out of memory"))).start });
    expect(await dying.extractText("pdf", "C:/x.pdf")).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(await dying.countPdfPages("C:/x.pdf")).toBeNull();
    const confused = createIsolatedExtractor({ start: fakeWorker(async () => ({ type: "count", result: 3 })).start });
    expect(await confused.extractText("pdf", "C:/x.pdf")).toMatchObject({ ok: false, error: { code: "corrupt" } });
    const broken = createIsolatedExtractor({
      start: () => {
        throw new Error("cannot start");
      },
    });
    expect(await broken.extractText("pdf", "C:/x.pdf")).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(broken.pending).toBe(0);
  });

  it("reads only a few files at a time; the rest wait, and a waiting one can be cancelled", async () => {
    const release: Array<() => void> = [];
    const worker = fakeWorker(() => new Promise((resolve) => release.push(() => resolve(TEXT))));
    const extractor = createIsolatedExtractor({ start: worker.start, maxConcurrent: 2 });
    const controller = new AbortController();
    const results = [
      extractor.extractText("pdf", "C:/1.pdf"),
      extractor.extractText("pdf", "C:/2.pdf"),
      extractor.extractText("pdf", "C:/3.pdf", { signal: controller.signal }),
      extractor.extractText("pdf", "C:/4.pdf"),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.jobs).toHaveLength(2);
    expect(extractor.pending).toBe(4);
    controller.abort();
    expect(await results[2]).toMatchObject({ ok: false, error: { code: "cancelled" } });
    release[0]?.();
    await results[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The fourth took the free place; the cancelled third never started.
    expect(worker.jobs.map((entry) => entry.job.input)).toEqual(["C:/1.pdf", "C:/2.pdf", "C:/4.pdf"]);
    release[1]?.();
    release[2]?.();
    await Promise.all(results);
    expect(extractor.pending).toBe(0);
  });
});

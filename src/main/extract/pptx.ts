/**
 * PowerPoint (.pptx) text through `jszip`: slides in presentation order, each with its title
 * and its speaker notes.
 *
 * A .pptx is a zip of XML parts, and both layers are treated as hostile here:
 *
 *  - The archive. Nothing is unpacked to disk. Only the handful of parts that hold text are
 *    read, each through a stream that counts the bytes that actually come out and stops at a
 *    cap, so a small file that unpacks to gigabytes (a zip bomb) is refused whatever sizes it
 *    declares. The number of entries is capped before the archive is indexed.
 *  - The XML. It is never given to an XML parser, so a DOCTYPE, entity definitions and external
 *    references are inert text: only the five predefined entities and numeric character
 *    references are decoded. The scanners below are plain `indexOf` walks, linear in the input,
 *    so no crafted document can make them backtrack.
 *  - Relationships. A target is only followed when it resolves to a slide or notes part inside
 *    this archive (`ppt/slides/*.xml`, `ppt/notesSlides/*.xml`). External targets and anything
 *    that climbs out of those folders are ignored. Nothing is fetched or executed.
 */

import { posix } from "node:path";

import JSZip from "jszip";

import {
  MAX_EXTRACT_CHARS,
  MAX_SLIDES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
} from "./limits";
import {
  Clock,
  ExtractFailure,
  TIMEOUT_SENTENCE,
  buildDocument,
  fail,
  hasNoRealText,
  readInput,
  sectionChars,
  tidy,
  toResult,
} from "./shared";
import type {
  ExtractInput,
  ExtractOptions,
  ExtractResult,
  ExtractedDocument,
  ExtractedSection,
} from "./types";

const CORRUPT = "This presentation is damaged and cannot be read. Try saving it again as .pptx.";
const TOO_LARGE = "This presentation unpacks to far more data than a real one would, so Studiplan did not read it.";

export function looksLikeZip(bytes: Uint8Array): boolean {
  // "PK\x03\x04"
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** An OLE compound file: an old .ppt, or a .pptx that PowerPoint encrypted with a password. */
function looksLikeOle(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * How many entries the archive says it has, read from its end-of-central-directory record
 * without indexing anything. `null` when there is no such record.
 */
function declaredEntryCount(bytes: Uint8Array): { count: number; zip64: boolean } | null {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06) {
      // A zip64 archive keeps its real numbers in another record, announced by a locator
      // ("PK\x06\x07") in the 20 bytes right before this one.
      const locator = at - 20;
      const zip64 =
        locator >= 0 && bytes[locator] === 0x50 && bytes[locator + 1] === 0x4b && bytes[locator + 2] === 0x06 && bytes[locator + 3] === 0x07;
      return { count: (bytes[at + 10] ?? 0) | ((bytes[at + 11] ?? 0) << 8), zip64 };
    }
  }
  return null;
}

const CENTRAL_RECORD = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/**
 * Whether the archive holds more directory records ("PK\x01\x02") than `most`. The number an
 * archive declares can be a lie: the zip reader keeps reading records for as long as they come,
 * so a file that says "1 entry" and carries a million would be indexed in full. Counting the
 * records' signatures is a plain search and takes milliseconds. The same four bytes may also
 * occur by chance inside packed data, which only makes the count a little too high.
 */
function hasMoreRecordsThan(bytes: Uint8Array, most: number): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  for (let at = buffer.indexOf(CENTRAL_RECORD); at !== -1; at = buffer.indexOf(CENTRAL_RECORD, at + 4)) {
    count += 1;
    if (count > most) return true;
  }
  return false;
}

// ── Reading parts within the caps ───────────────────────────────────────────────────────────

type Budget = { used: number };

/** One part's bytes as text, counted as they are unpacked. `null` when the part does not exist. */
async function readPart(zip: JSZip, path: string, budget: Budget): Promise<string | null> {
  const file = zip.file(path);
  if (!file || file.dir) return null;

  // The declared size is a cheap first refusal. It is not trusted: the stream below counts.
  const declared = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > MAX_ZIP_ENTRY_BYTES) fail("too-large", TOO_LARGE);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = file.nodeStream("nodebuffer");
    let size = 0;
    let done = false;
    const finish = (error?: unknown): void => {
      if (done) return;
      done = true;
      stream.removeAllListeners("data");
      stream.pause();
      if (error === undefined) resolve();
      else reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      budget.used += chunk.length;
      if (size > MAX_ZIP_ENTRY_BYTES || budget.used > MAX_ZIP_TOTAL_BYTES) {
        finish(new ExtractFailure("too-large", TOO_LARGE));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () => finish(new ExtractFailure("corrupt", CORRUPT)));
    stream.on("end", () => finish());
  });
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

// ── Linear XML scanning ─────────────────────────────────────────────────────────────────────

/** A tag longer than this is not a tag anyone wrote; it is skipped. */
const MAX_TAG_CHARS = 4_096;

type ElementRange = { start: number; end: number; open: string; inner: string };

/**
 * Every `<name …>` opening tag in document order, with the element's content when it has a
 * closing tag. Elements of the same name are assumed not to nest (true for every name used
 * here). One forward pass: when a `>` or a closing tag is missing, the scan ends.
 */
function* elements(xml: string, name: string, withContent = true): Generator<ElementRange> {
  const opener = `<${name}`;
  const closer = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(opener, at);
    if (start === -1) return;
    const after = xml[start + opener.length];
    if (after !== ">" && after !== "/" && after !== " " && after !== "\n" && after !== "\r" && after !== "\t") {
      at = start + opener.length;
      continue;
    }
    const openEnd = xml.indexOf(">", start);
    if (openEnd === -1) return;
    const open = xml.slice(start, Math.min(openEnd + 1, start + MAX_TAG_CHARS));
    if (xml[openEnd - 1] === "/" || !withContent) {
      yield { start, end: openEnd + 1, open, inner: "" };
      at = openEnd + 1;
      continue;
    }
    const close = xml.indexOf(closer, openEnd + 1);
    if (close === -1) return;
    yield { start, end: close + closer.length, open, inner: xml.slice(openEnd + 1, close) };
    at = close + closer.length;
  }
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The five predefined entities and numeric character references. Anything else (an entity a
 * DOCTYPE defined, for instance) is left exactly as written: it is never expanded.
 */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,4});/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Each `<a:p>` paragraph on its own line: its `<a:t>` runs joined, `<a:br/>` as a line break. */
function paragraphsText(xml: string): string {
  const lines: string[] = [];
  for (const paragraph of elements(xml, "a:p")) {
    const line = paragraph.inner
      .split("<a:br")
      .map((piece) => {
        let runs = "";
        for (const run of elements(piece, "a:t")) runs += decodeXml(run.inner);
        return runs;
      })
      .join("\n");
    if (line.trim() !== "") lines.push(line);
  }
  return tidy(lines.join("\n"));
}

const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);
/** Placeholders that repeat on every slide and say nothing: slide number, date, footer, … */
const NOISE_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"]);

/**
 * A slide's (or notes page's) XML split into its title and everything else. Text outside
 * shapes (tables, grouped shapes) stays in the body, in document order.
 */
function slideText(xml: string): { title: string; body: string } {
  const titles: string[] = [];
  let rest = "";
  let cursor = 0;
  for (const shape of elements(xml, "p:sp")) {
    let type: string | null = null;
    for (const placeholder of elements(shape.inner, "p:ph", false)) {
      type = attribute(placeholder.open, "type");
      break;
    }
    if (type === null) continue;
    const isTitle = TITLE_PLACEHOLDERS.has(type);
    if (!isTitle && !NOISE_PLACEHOLDERS.has(type)) continue;
    rest += xml.slice(cursor, shape.start);
    cursor = shape.end;
    // The text is tidied already: a line break has no blanks around it. (`\s*\n\s*` would
    // take quadratic time on a long run of other white space, which a file can contain.)
    if (isTitle) titles.push(paragraphsText(shape.inner).replace(/\n+/g, " "));
  }
  rest += xml.slice(cursor);
  return { title: titles.filter((title) => title !== "").join(" / "), body: paragraphsText(rest) };
}

// ── Relationships, kept inside the archive ──────────────────────────────────────────────────

/**
 * Where a relationship target points, as a path inside the archive, or `null` when it leaves
 * the folder it is allowed to point into.
 */
function resolveTarget(baseDir: string, target: string, allowed: RegExp): string | null {
  if (target.includes("\\") || target.includes(":") || target.includes("\0")) return null;
  const path = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(`${baseDir}/${target}`);
  return allowed.test(path) ? path : null;
}

const SLIDE_PART = /^ppt\/slides\/[^/]+\.xml$/;
const NOTES_PART = /^ppt\/notesSlides\/[^/]+\.xml$/;

/** The internal relationships in a `.rels` part: id, type and target. */
function relationships(relsXml: string): { id: string; type: string; target: string }[] {
  const found: { id: string; type: string; target: string }[] = [];
  for (const rel of elements(relsXml, "Relationship", false)) {
    if (attribute(rel.open, "TargetMode") === "External") continue;
    const id = attribute(rel.open, "Id");
    const target = attribute(rel.open, "Target");
    if (id && target) found.push({ id, type: attribute(rel.open, "Type") ?? "", target });
    if (found.length >= MAX_ZIP_ENTRIES) break;
  }
  return found;
}

/**
 * Slide part paths in presentation order.
 *
 * The order a deck is shown in is `<p:sldIdLst>` in `ppt/presentation.xml`, resolved through
 * `ppt/_rels/presentation.xml.rels`. `slideN.xml` numbering drifts from it as soon as someone
 * reorders slides. When either part is missing or names no slide, fall back to
 * `ppt/slides/slideN.xml` in numeric order.
 */
async function slidePathsInOrder(zip: JSZip, budget: Budget): Promise<string[]> {
  const numeric = Object.keys(zip.files)
    .map((path) => ({ path, match: /^ppt\/slides\/slide(\d{1,9})\.xml$/.exec(path) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]))
    .map((entry) => entry.path);

  const presentationXml = await readPart(zip, "ppt/presentation.xml", budget);
  const relsXml = await readPart(zip, "ppt/_rels/presentation.xml.rels", budget);
  if (presentationXml === null || relsXml === null) return numeric;

  const targets = new Map<string, string>();
  for (const rel of relationships(relsXml)) targets.set(rel.id, rel.target);

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const list of elements(presentationXml, "p:sldIdLst")) {
    for (const slide of elements(list.inner, "p:sldId", false)) {
      const target = targets.get(attribute(slide.open, "r:id") ?? "");
      const path = target === undefined ? null : resolveTarget("ppt", target, SLIDE_PART);
      if (path === null || seen.has(path) || !zip.file(path)) continue;
      seen.add(path);
      ordered.push(path);
    }
    break;
  }
  return ordered.length > 0 ? ordered : numeric;
}

/** The speaker notes that belong to one slide, or `null`. */
async function notesFor(zip: JSZip, slidePath: string, budget: Budget): Promise<string | null> {
  const relsXml = await readPart(
    zip,
    `ppt/slides/_rels/${posix.basename(slidePath)}.rels`,
    budget,
  );
  if (relsXml === null) return null;
  for (const rel of relationships(relsXml)) {
    if (!rel.type.endsWith("/notesSlide")) continue;
    const path = resolveTarget("ppt/slides", rel.target, NOTES_PART);
    if (path === null) continue;
    const xml = await readPart(zip, path, budget);
    if (xml === null) continue;
    const { title, body } = slideText(xml);
    const notes = [title, body].filter((part) => part !== "").join("\n");
    return notes === "" ? null : notes;
  }
  return null;
}

/** `<p:sld show="0">`: the slide is skipped when the deck is presented. */
function isHiddenSlide(xml: string): boolean {
  // The first `<p:sld …>` tag, found with the file's own linear scanner. (A regular expression
  // here would start over at every `<p:sld` in a file made of nothing else.)
  for (const root of elements(xml, "p:sld", false)) {
    const show = attribute(root.open, "show");
    return show === "0" || show === "false";
  }
  return false;
}

async function readPptx(input: ExtractInput, options: ExtractOptions): Promise<ExtractedDocument> {
  const clock = new Clock(options);
  clock.checkCancelled();
  const bytes = await readInput(input);
  if (looksLikeOle(bytes)) {
    fail(
      "encrypted",
      "This presentation is password-protected or saved in the old .ppt format. Save it as .pptx without a password and add that instead.",
    );
  }
  if (!looksLikeZip(bytes)) {
    fail("not-a-pptx", "This file is not a PowerPoint presentation, even though its name says so. Open it in PowerPoint, save it as .pptx, and add that.");
  }
  const declared = declaredEntryCount(bytes);
  if (declared === null) fail("corrupt", CORRUPT);
  // 0xFFFF, or a zip64 locator, means "see the zip64 record": more entries, or more bytes, than
  // any deck has.
  if (declared.count > MAX_ZIP_ENTRIES || declared.count === 0xffff || declared.zip64) fail("too-large", TOO_LARGE);
  // What the archive really carries, before anything indexes it.
  if (hasMoreRecordsThan(bytes, MAX_ZIP_ENTRIES)) fail("too-large", TOO_LARGE);

  let zip: JSZip;
  try {
    // Indexes the archive's directory only; no entry is unpacked here.
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch {
    fail("corrupt", CORRUPT);
  }
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) fail("too-large", TOO_LARGE);

  const budget: Budget = { used: 0 };
  const paths = await slidePathsInOrder(zip, budget);
  if (paths.length === 0) {
    fail("no-slides", "This file has no slides in it. It may not be a PowerPoint presentation.");
  }

  const sections: ExtractedSection[] = [];
  let stopped: ExtractedDocument["stopped"] = null;
  let chars = 0;
  for (const [index, path] of paths.entries()) {
    clock.checkCancelled();
    if (index >= MAX_SLIDES) {
      stopped = "count-limit";
      break;
    }
    if (chars > MAX_EXTRACT_CHARS) {
      stopped = "text-limit";
      break;
    }
    if (clock.expired) {
      stopped = "time-limit";
      break;
    }
    const xml = await readPart(zip, path, budget);
    const { title, body } = slideText(xml ?? "");
    const section: ExtractedSection = {
      number: index + 1,
      title: title === "" ? null : title,
      body,
      notes: await notesFor(zip, path, budget),
      // A slide the presenter hid is still part of the file a student was given: it is read,
      // and marked, so a result can be traced to it.
      ...(isHiddenSlide(xml ?? "") ? { hidden: true } : {}),
    };
    sections.push(section);
    chars += sectionChars(section);
    // Unpacking is synchronous work; let the app breathe between slides.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (sections.length === 0) fail("timeout", TIMEOUT_SENTENCE);
  if (hasNoRealText(sections)) {
    fail("no-text", "This presentation has no readable text. Its slides seem to hold only pictures.");
  }
  return buildDocument("pptx", paths.length, sections, stopped);
}

/** Every slide's text. Never throws: a file that cannot be read comes back as `ok: false`. */
export function extractPptxText(input: ExtractInput, options: ExtractOptions = {}): Promise<ExtractResult> {
  return toResult(() => readPptx(input, options), { code: "corrupt", message: CORRUPT });
}

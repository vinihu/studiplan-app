/**
 * Test fixtures built in code, so no binary files live in the repo: hand-written PDFs and
 * .pptx archives assembled with `jszip`. Only the tests import this file.
 */

import JSZip from "jszip";

/**
 * A minimal, valid PDF: one page per content stream, Helvetica as `/F1`, a correct
 * cross-reference table. `trailerExtra` is added to the trailer dictionary.
 */
export function makePdf(pageStreams: readonly string[], trailerExtra = ""): Uint8Array {
  const objects: string[] = [];
  const pageCount = pageStreams.length;
  const pageObject = (index: number): number => 4 + index * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageStreams
    .map((_, index) => `${pageObject(index)} 0 R`)
    .join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageStreams.forEach((stream, index) => {
    const id = pageObject(index);
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** A content stream that writes each line of text with Helvetica. No parentheses in `lines`. */
export function textStream(lines: readonly string[]): string {
  return `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
}

/** A content stream that only draws a grey rectangle: what a scanned page looks like to a reader. */
export const PICTURE_ONLY_STREAM = "0.5 g 72 72 468 648 re f";

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function shape(placeholder: string, paragraphs: readonly string[], raw = false): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraphs
      .map((text) => `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en"/><a:t>${raw ? text : escapeXml(text)}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp>`
  );
}

export interface SlideSpec {
  title?: string;
  body?: string[];
  /** Body paragraphs written into the XML as they are (for entity tricks). */
  rawBody?: string[];
  notes?: string[];
  /** Put before the root element (a DOCTYPE, for instance). */
  prolog?: string;
  /** A slide that is hidden in the presentation. */
  hidden?: boolean;
}

export function slideXml(spec: SlideSpec, slideNumber: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${spec.prolog ?? ""}<p:sld ${NAMESPACES}${spec.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>` +
    (spec.title === undefined ? "" : shape('<p:ph type="title"/>', [spec.title])) +
    (spec.body ? shape('<p:ph type="body" idx="1"/>', spec.body) : "") +
    (spec.rawBody ? shape("", spec.rawBody, true) : "") +
    shape('<p:ph type="sldNum" idx="12"/>', [String(slideNumber)]) +
    `</p:spTree></p:cSld></p:sld>`
  );
}

function notesXml(notes: readonly string[], slideNumber: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NAMESPACES}><p:cSld><p:spTree>` +
    shape('<p:ph type="sldImg"/>', []) +
    shape('<p:ph type="body" idx="1"/>', notes) +
    shape('<p:ph type="sldNum" idx="10"/>', [String(slideNumber)]) +
    `</p:spTree></p:cSld></p:notes>`
  );
}

function rels(entries: readonly string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join("")}</Relationships>`
  );
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface DeckSpec {
  /** Keyed by file number: `slides[3]` becomes `ppt/slides/slide3.xml`. */
  slides: Record<number, SlideSpec>;
  /** File numbers in the order the deck is presented. Omit to leave out `presentation.xml`. */
  order?: number[];
  /** Extra `<Relationship>` elements for `presentation.xml.rels`, listed first in `<p:sldIdLst>`. */
  extraPresentationRels?: { id: string; target: string; external?: boolean }[];
  /** Extra archive entries. */
  extraFiles?: Record<string, string | Uint8Array>;
}

/** A small but real .pptx archive. */
export async function makePptx(spec: DeckSpec): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  );
  for (const [key, slide] of Object.entries(spec.slides)) {
    const number = Number(key);
    zip.file(`ppt/slides/slide${number}.xml`, slideXml(slide, number));
    if (slide.notes) {
      zip.file(`ppt/notesSlides/notesSlide${number}.xml`, notesXml(slide.notes, number));
      zip.file(
        `ppt/slides/_rels/slide${number}.xml.rels`,
        rels([
          `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
          `<Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${number}.xml"/>`,
        ]),
      );
    }
  }
  if (spec.order) {
    const extra = spec.extraPresentationRels ?? [];
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      rels([
        ...extra.map(
          (rel) =>
            `<Relationship Id="${rel.id}" Type="${REL}/slide" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ""}/>`,
        ),
        ...spec.order.map(
          (number) => `<Relationship Id="rId${number}" Type="${REL}/slide" Target="slides/slide${number}.xml"/>`,
        ),
      ]),
    );
    zip.file(
      "ppt/presentation.xml",
      `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NAMESPACES}><p:sldMasterIdLst/><p:sldIdLst>` +
        [...extra.map((rel) => rel.id), ...spec.order.map((number) => `rId${number}`)]
          .map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`)
          .join("") +
        `</p:sldIdLst></p:presentation>`,
    );
  }
  for (const [path, content] of Object.entries(spec.extraFiles ?? {})) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * Rewrites every size above `threshold` that the archive declares for an unpacked entry to
 * `claimed`, in both the local headers and the central directory: an archive that lies about
 * how much it unpacks to.
 */
export function lieAboutSizes(archive: Uint8Array, threshold: number, claimed: number): Uint8Array {
  const bytes = Buffer.from(archive);
  for (let at = 0; at + 30 < bytes.length; at += 1) {
    if (bytes[at] !== 0x50 || bytes[at + 1] !== 0x4b) continue;
    const local = bytes[at + 2] === 0x03 && bytes[at + 3] === 0x04;
    const central = bytes[at + 2] === 0x01 && bytes[at + 3] === 0x02;
    if (!local && !central) continue;
    const field = at + (local ? 22 : 24);
    if (bytes.readUInt32LE(field) > threshold) bytes.writeUInt32LE(claimed, field);
  }
  return new Uint8Array(bytes);
}

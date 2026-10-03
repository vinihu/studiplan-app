/**
 * One PDF from the pages of a photo set, written by hand.
 *
 * A PDF page can hold a JPEG exactly as it is: an image object whose data is the file's own
 * bytes, with `/Filter /DCTDecode`. Nothing is decoded or encoded again, so the PDF's pages are
 * the photos, bit for bit, and no library is needed.
 *
 * ## The file
 *
 * ```
 * 1  Catalog
 * 2  Pages            (the list of every page object: their numbers follow from the page count)
 * 3  Page 1           4  its content stream ("draw the image over the whole page")   5  its image
 * 6  Page 2           7  …                                                           8  …
 * xref, trailer
 * ```
 *
 * It is written front to back in one pass, one photo in memory at a time: the offsets for the
 * cross-reference table are noted as each object goes out.
 *
 * ## Page size
 *
 * A page is as wide as A4 (595.28 pt; 841.89 pt for a photo that is wider than tall) and as
 * high as the photo's own proportions make it, so nothing is cropped, stretched or letterboxed
 * and the pages print on A4 without scaling surprises. A photo taken sideways is turned upright
 * by the page's `/Rotate`, from the orientation the camera stored in the picture (photos added
 * through the app are already upright and carry none).
 *
 * ## What a page may be
 *
 * A baseline, extended or progressive JPEG with 8 bits per sample, in grey (1 component) or
 * colour (3 components). A CMYK picture (4 components) is refused: its colours are stored
 * inverted by some programs and not by others, and a PDF made from it would show wrong colours
 * in some viewers. Lossless and arithmetic-coded JPEGs, which PDF readers do not take, are
 * refused too.
 *
 * No Electron and no file access: the pages come in as bytes and the PDF goes out through `write`.
 */

/** Why a page cannot go into a PDF. `message` is a sentence about "this photo". */
export class PhotoPdfFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoPdfFailure";
  }
}

export interface JpegInfo {
  width: number;
  height: number;
  /** 1: grey. 3: colour. */
  components: 1 | 3;
  /** Degrees the picture has to be turned clockwise to stand upright: 0, 90, 180 or 270. */
  rotate: 0 | 90 | 180 | 270;
}

const NOT_A_PHOTO = "is not a photo this app can read. It may be damaged.";
/** Markers that are followed by no length and no data. */
const isStandalone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
/** Start-of-frame markers a PDF's DCTDecode takes: baseline, extended sequential, progressive. */
const isUsableFrame = (marker: number): boolean => marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
/** Every other start of frame: lossless, hierarchical, arithmetic coding. */
const isOtherFrame = (marker: number): boolean =>
  marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** The camera's orientation tag (1–8) from an Exif segment, or 1 when there is none. */
function exifOrientation(segment: Uint8Array): number {
  // "Exif\0\0", then a TIFF header: byte order, 42, the offset of the first directory.
  if (segment.length < 14 || String.fromCharCode(...segment.subarray(0, 4)) !== "Exif") return 1;
  const tiff = segment.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return 1;
  const directory = view.getUint32(4, little);
  if (directory + 2 > tiff.length) return 1;
  const entries = Math.min(view.getUint16(directory, little), 200);
  for (let index = 0; index < entries; index += 1) {
    const at = directory + 2 + index * 12;
    if (at + 12 > tiff.length) return 1;
    if (view.getUint16(at, little) !== 0x0112) continue;
    const value = view.getUint16(at + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** Orientation 6 is "turn 90° clockwise", 3 is upside down, 8 is "turn 270°". Mirrored ones are rare: treated as their turn. */
const ROTATION: Readonly<Record<number, JpegInfo["rotate"]>> = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/**
 * What a PDF needs to know about a JPEG, read from its markers. Throws `PhotoPdfFailure` for
 * anything that is not a JPEG a PDF page can hold.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new PhotoPdfFailure(NOT_A_PHOTO);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rotate: JpegInfo["rotate"] = 0;
  let at = 2;
  // A photo has a few dozen segments before its picture data; the bound is against a file made to loop.
  for (let segments = 0; segments < 10_000 && at + 4 <= bytes.length; segments += 1) {
    if (bytes[at] !== 0xff) throw new PhotoPdfFailure(NOT_A_PHOTO);
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (isStandalone(marker)) {
      at += 2;
      continue;
    }
    // Start of scan or end of image before any frame: there is no picture in it.
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) throw new PhotoPdfFailure(NOT_A_PHOTO);
    const data = bytes.subarray(at + 4, at + 2 + length);

    if (marker === 0xe1) rotate = ROTATION[exifOrientation(data)] ?? rotate;
    if (isOtherFrame(marker)) {
      throw new PhotoPdfFailure("is saved in a kind of JPEG a PDF cannot hold. Open it in an image program, save it as an ordinary JPEG and add it again.");
    }
    if (isUsableFrame(marker)) {
      if (data.length < 6) throw new PhotoPdfFailure(NOT_A_PHOTO);
      const precision = data[0] as number;
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      const components = data[5] as number;
      if (width === 0 || height === 0) throw new PhotoPdfFailure(NOT_A_PHOTO);
      if (precision !== 8) {
        throw new PhotoPdfFailure("has more than 8 bits per colour, which a PDF page cannot hold. Save it as an ordinary JPEG and add it again.");
      }
      if (components === 4) {
        throw new PhotoPdfFailure("is a CMYK picture (made for printing), which would come out in wrong colours. Save it as an RGB JPEG and add it again.");
      }
      if (components !== 1 && components !== 3) throw new PhotoPdfFailure(NOT_A_PHOTO);
      return { width, height, components, rotate };
    }
    at += 2 + length;
  }
  throw new PhotoPdfFailure(NOT_A_PHOTO);
}

/** A4 in points, short and long side. */
const A4_SHORT = 595.28;
const A4_LONG = 841.89;
/** The largest page a PDF may have, and the smallest that is still a page. */
const MAX_SIDE = 14_400;
const MIN_SIDE = 3;

/** The page for a photo of these pixel dimensions, in points, before any turn. */
export function pageSize(width: number, height: number): { width: number; height: number } {
  let pageWidth = width > height ? A4_LONG : A4_SHORT;
  let pageHeight = (pageWidth * height) / width;
  // A strip so long that it passes what a PDF page may be: the whole photo is scaled down.
  if (pageHeight > MAX_SIDE) {
    pageWidth = (pageWidth * MAX_SIDE) / pageHeight;
    pageHeight = MAX_SIDE;
  }
  const round = (value: number): number => Math.max(MIN_SIDE, Math.round(value * 100) / 100);
  return { width: round(pageWidth), height: round(pageHeight) };
}

/** Bytes a PDF of `pages` photos has besides the photos themselves: a careful upper bound. */
export function pdfOverheadBytes(pages: number): number {
  return 1_024 + pages * 640;
}

export interface PhotoPdfResult {
  pages: number;
  bytes: number;
}

/**
 * Writes one PDF with one page per photo. `count` is how many photos there are; `page(index)`
 * gives the bytes of one (called once each, in order, and the bytes are let go before the next);
 * `write` takes the PDF piece by piece. Throws `PhotoPdfFailure` naming the page (`pageNumber`
 * is set) when a photo cannot be used; what was written so far is then the caller's to remove.
 */
export async function writePhotoPdf(
  count: number,
  page: (index: number) => Promise<Uint8Array>,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<PhotoPdfResult> {
  if (!Number.isInteger(count) || count < 1) throw new PhotoPdfFailure("has no photos in it.");
  const encoder = new TextEncoder();
  const offsets: number[] = [];
  let position = 0;

  const put = async (chunk: Uint8Array): Promise<void> => {
    position += chunk.length;
    await write(chunk);
  };
  const text = (value: string): Promise<void> => put(encoder.encode(value));
  /** Starts object `id` at the current position. */
  const object = async (id: number, body: string): Promise<void> => {
    offsets[id] = position;
    await text(`${id} 0 obj\n${body}`);
  };

  const pageId = (index: number): number => 3 + index * 3;

  // The second line is four bytes above 127: it tells programs the file is binary.
  await put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  await object(1, "<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = Array.from({ length: count }, (_, index) => `${pageId(index)} 0 R`).join(" ");
  await object(2, `<< /Type /Pages /Count ${count} /Kids [${kids}] >>\nendobj\n`);

  for (let index = 0; index < count; index += 1) {
    const bytes = await page(index);
    let info: JpegInfo;
    try {
      info = readJpegInfo(bytes);
    } catch (error) {
      if (error instanceof PhotoPdfFailure) throw Object.assign(error, { pageNumber: index + 1 });
      throw error;
    }
    const size = pageSize(info.width, info.height);
    const id = pageId(index);
    const draw = `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`;

    await object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}]` +
        (info.rotate === 0 ? "" : ` /Rotate ${info.rotate}`) +
        ` /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>\nendobj\n`,
    );
    await object(id + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`);
    await object(
      id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}` +
        ` /ColorSpace ${info.components === 1 ? "/DeviceGray" : "/DeviceRGB"} /BitsPerComponent 8` +
        ` /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
    );
    await put(bytes);
    await text("\nendstream\nendobj\n");
  }

  const total = 3 + count * 3;
  const xrefAt = position;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id += 1) xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  await text(`${xref}trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return { pages: count, bytes: position };
}

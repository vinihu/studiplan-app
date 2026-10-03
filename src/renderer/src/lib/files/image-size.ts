/**
 * How many pixels a picture has, read from the first bytes of its file, without decoding it.
 *
 * Decoding is what costs memory: a picture of 30,000 × 30,000 pixels is a small file and a
 * bitmap of several gigabytes. So the size is read first, and a picture that is too large is
 * turned away before any of it is decoded. Pure functions over bytes, no DOM.
 *
 * Knows PNG, JPEG, GIF, WebP and BMP. Anything else (and a file cut short or damaged) gives
 * `null`, and the caller checks the size after decoding instead.
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** As much of a file as `imageSize` needs: a JPEG's size can sit behind a large block of camera data. */
export const IMAGE_HEADER_BYTES = 512 * 1024;

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

const u8 = (bytes: Uint8Array, at: number): number => bytes[at] ?? 0;
const u16be = (bytes: Uint8Array, at: number): number => u8(bytes, at) * 256 + u8(bytes, at + 1);
const u16le = (bytes: Uint8Array, at: number): number => u8(bytes, at) + u8(bytes, at + 1) * 256;
const u24le = (bytes: Uint8Array, at: number): number => u16le(bytes, at) + u8(bytes, at + 2) * 65_536;
const u32be = (bytes: Uint8Array, at: number): number => u16be(bytes, at) * 65_536 + u16be(bytes, at + 2);
const u32le = (bytes: Uint8Array, at: number): number => u16le(bytes, at) + u16le(bytes, at + 2) * 65_536;

function size(width: number, height: number): PixelSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(bytes: Uint8Array): PixelSize | null {
  let at = 2;
  // Each step moves on by at least two bytes, so this ends.
  while (at + 9 < bytes.length) {
    if (u8(bytes, at) !== 0xff) return null;
    const marker = u8(bytes, at + 1);
    if (marker === 0xff) {
      at += 1; // padding between segments
      continue;
    }
    // The frame headers (SOF0 … SOF15), which are not the tables that share their range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return size(u16be(bytes, at + 7), u16be(bytes, at + 5));
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the picture's data: no frame header came
    at += 2 + Math.max(2, u16be(bytes, at + 2));
  }
  return null;
}

function webpSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 12, "VP8X")) return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (ascii(bytes, 12, "VP8L")) {
    const bits = u32le(bytes, 21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(bytes, 12, "VP8 ")) return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  return null;
}

export function imageSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length >= 24 && u32be(bytes, 0) === 0x89504e47 && ascii(bytes, 12, "IHDR")) {
    return size(u32be(bytes, 16), u32be(bytes, 20));
  }
  if (bytes.length >= 4 && u8(bytes, 0) === 0xff && u8(bytes, 1) === 0xd8) return jpegSize(bytes);
  if (bytes.length >= 10 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
    return size(u16le(bytes, 6), u16le(bytes, 8));
  }
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpSize(bytes);
  if (bytes.length >= 26 && ascii(bytes, 0, "BM")) {
    // A height below zero means the rows are stored top to bottom; the size is the same.
    const height = u32le(bytes, 22);
    return size(u32le(bytes, 18), height > 0x7fffffff ? 0x100000000 - height : height);
  }
  return null;
}

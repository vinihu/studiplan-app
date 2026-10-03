/** The numbers a photo page is made with. No DOM here, so they can be tested on their own. */

/** Long side of a page image, in pixels. Legible handwriting, a modest file. */
export const MAX_LONG_SIDE = 2000;
export const JPEG_QUALITY = 0.85;

/** The size a photo is drawn at: never enlarged, long side at most `maxLongSide`. */
export function fitWithin(
  width: number,
  height: number,
  maxLongSide: number = MAX_LONG_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/*
 * What is turned away before a photo is decoded. Decoding happens in the window, and a window
 * has only so much memory: the limits are checked on the way in, not after the damage.
 */

/** Photos in one go. A photo set holds this many pages (the library's own limit). */
export const MAX_PHOTOS = 100;
/** A photo file. A phone's largest pictures are well under this; nothing larger is a page of notes. */
export const MAX_PHOTO_FILE_BYTES = 64 * 1024 * 1024;
/** A photo's pixels. 120 megapixels is about half a gigabyte once decoded, one photo at a time. */
export const MAX_PHOTO_PIXELS = 120_000_000;

export function tooManyPhotosReason(count: number): string {
  return `You picked ${count} photos. A photo set can have up to ${MAX_PHOTOS} pages. Add them in smaller groups.`;
}

export const PHOTO_FILE_TOO_LARGE_REASON = `This photo's file is larger than ${MAX_PHOTO_FILE_BYTES / (1024 * 1024)} MB. Save a smaller copy and add that.`;

export function isTooManyPixels(width: number, height: number): boolean {
  return width * height > MAX_PHOTO_PIXELS;
}

export function tooManyPixelsReason(width: number, height: number): string {
  return `This photo is too large to open (${width} × ${height} pixels). Save a smaller copy, up to about ${MAX_PHOTO_PIXELS / 1_000_000} megapixels, and add that.`;
}

/** A photo that was turned away for a reason worth telling: its message is the sentence to show. */
export class PhotoRefused extends Error {}

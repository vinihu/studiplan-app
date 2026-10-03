/**
 * One photo -> one upright, downscaled JPEG, entirely in the page.
 *
 * 0. Its size in pixels is read from the first bytes of the file. A picture with more than
 *    `MAX_PHOTO_PIXELS` is refused before any of it is decoded (see `image-size.ts`); for a
 *    format whose header this cannot read, the same check is made right after decoding, before
 *    anything is drawn.
 * 1. Decoded with `createImageBitmap(file, { imageOrientation: "from-image" })`, so a portrait
 *    photo whose pixels are stored sideways (EXIF orientation) comes out upright. There is no
 *    `<img>` fallback: the page's Content-Security-Policy does not load `blob:` images, and
 *    what this cannot decode (HEIC, for one) an `<img>` in the same browser cannot either.
 * 2. Drawn onto a canvas no larger than `MAX_LONG_SIDE` on its long side, over white, so a
 *    transparent PNG does not become a black page.
 * 3. Encoded as JPEG at `JPEG_QUALITY`. A page this size is typically 300–900 KB.
 *
 * One photo at a time: the bitmap and the canvas are released before the next one is touched.
 *
 * A phone photo is often 4–12 MB and 4000px on its long side; this keeps handwriting legible
 * while a set of thirty pages stays small enough to send to a model.
 */

import { IMAGE_HEADER_BYTES, imageSize } from "./image-size";
import { fitWithin, isTooManyPixels, JPEG_QUALITY, PhotoRefused, tooManyPixelsReason } from "./page-size";

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decode(file: File): Promise<Drawable> {
  const header = new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
  const declared = imageSize(header);
  if (declared && isTooManyPixels(declared.width, declared.height)) {
    throw new PhotoRefused(tooManyPixelsReason(declared.width, declared.height));
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (isTooManyPixels(bitmap.width, bitmap.height)) {
    const { width, height } = bitmap;
    bitmap.close();
    throw new PhotoRefused(tooManyPixelsReason(width, height));
  }
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode a page."))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

/** Throws when the file cannot be read as an image; a `PhotoRefused` when it is too large to open. */
export async function photoToJpeg(file: File): Promise<Uint8Array> {
  const image = await decode(file);
  try {
    if (image.width < 1 || image.height < 1) throw new Error("The image is empty.");
    const { width, height } = fitWithin(image.width, image.height);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas is available.");
    // The page background of a photo is white whatever the theme: it is content, not chrome.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image.source, 0, 0, width, height);
    const jpeg = await canvasToJpeg(canvas);
    // Release the canvas's backing store now rather than at the next GC.
    canvas.width = 0;
    canvas.height = 0;
    return new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    image.close();
  }
}

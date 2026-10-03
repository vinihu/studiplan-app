import { open } from "node:fs/promises";

export type DocumentKind = "pdf" | "pptx";

/** The extension the app accepts for each kind, lower case, with the dot. */
export const EXTENSION: Record<DocumentKind, string> = { pdf: ".pdf", pptx: ".pptx" };

export function kindFromName(name: string): DocumentKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".pptx")) return "pptx";
  return null;
}

/**
 * Does the start of the file look like what its extension says?
 *
 * PDF: the `%PDF-` header, which readers accept anywhere in the first 1024 bytes.
 * .pptx: a zip archive, which starts with a local file header (`PK\x03\x04`). Whether the
 * archive really holds a presentation is found out when its text is extracted.
 */
export function matchesSignature(kind: DocumentKind, head: Uint8Array): boolean {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (kind === "pdf") return bytes.subarray(0, 1024).includes("%PDF-", 0, "latin1");
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function readHead(filePath: string, length = 1024): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A JPEG starts with the start-of-image marker followed by another marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

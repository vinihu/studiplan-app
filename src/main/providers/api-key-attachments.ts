/**
 * Reading the `file` and `image` parts of a request from disk, for the providers that send them
 * as bytes (the API-key provider and Ollama).
 *
 * Two checks keep a request inside the material's folder: the path check shared with the CLI
 * providers (`toWorkingDirectoryParts`), and — because here the app itself opens the file — a
 * check of where the path really leads once links and junctions are followed.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PROMPT_MAX_IMAGE_BYTES, PROMPT_MAX_IMAGES } from "../extract/limits";
import { ProviderFailure, sentenceFor } from "./errors";
import { toWorkingDirectoryParts } from "./paths";
import type { Part } from "./provider";

export type AttachmentMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "application/pdf";

export interface LoadedAttachment {
  kind: "image" | "pdf";
  mediaType: AttachmentMediaType;
  /** The file's bytes, base64, without line breaks or a `data:` prefix. */
  base64: string;
  bytes: number;
  /** The file's own name, without folders. Material, not instructions. */
  name: string;
}

/** PDFs sent whole in one request. Photos have their own budget in `extract/limits.ts`. */
export const MAX_PDF_FILES = 5;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

function invalid(): ProviderFailure {
  return new ProviderFailure("invalid-request", sentenceFor("invalid-request", ""));
}

function startsWith(data: Buffer, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => data[offset + index] === byte);
}

/** What the first bytes say the file is. The extension is not trusted. */
export function sniffMediaType(data: Buffer): AttachmentMediaType | undefined {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return undefined;
}

export interface LoadOptions {
  /** `false` for a provider that cannot take a PDF (Ollama): a `file` part is then refused. */
  allowPdf: boolean;
  label: string;
}

/**
 * The attachments of one request, in order. Throws a `ProviderFailure`:
 * `invalid-request` for a path outside the folder or a file that is not what its part says,
 * `too-large` when the request budget is exceeded, `failed` when a file cannot be read.
 */
export async function loadAttachments(
  parts: readonly Part[],
  workingDirectory: string | undefined,
  options: LoadOptions,
): Promise<LoadedAttachment[]> {
  const files = parts.filter((part) => part.type !== "text");
  if (files.length === 0) return [];

  // Throws `invalid-request` when a path leaves the folder, or there is no folder.
  const relative = toWorkingDirectoryParts(files, workingDirectory);
  if (workingDirectory === undefined) throw invalid();

  if (files.filter((part) => part.type === "image").length > PROMPT_MAX_IMAGES) {
    throw new ProviderFailure("too-large", sentenceFor("too-large", options.label));
  }
  if (files.filter((part) => part.type === "file").length > MAX_PDF_FILES) {
    throw new ProviderFailure("too-large", sentenceFor("too-large", options.label));
  }

  const gone = new ProviderFailure(
    "failed",
    "A file of this material could not be read. It may have been moved or deleted; go back to the library and open the material again.",
  );

  let root: string;
  try {
    root = await realpath(workingDirectory);
  } catch {
    throw gone;
  }

  const loaded: LoadedAttachment[] = [];
  let imageBytes = 0;
  let pdfBytes = 0;
  for (const part of relative) {
    if (part.type === "text") continue;
    if (part.type === "file" && !options.allowPdf) throw invalid();

    let real: string;
    let size: number;
    try {
      real = await realpath(path.resolve(workingDirectory, part.path));
      const info = await stat(real);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      throw gone;
    }
    // A link or junction inside the folder that points out of it.
    const inside = path.relative(root, real);
    if (inside.length === 0 || inside.startsWith("..") || path.isAbsolute(inside)) throw invalid();

    // Checked before reading, so an oversized file is never loaded into memory.
    if (part.type === "image") imageBytes += size;
    else pdfBytes += size;
    if (imageBytes > PROMPT_MAX_IMAGE_BYTES || pdfBytes > MAX_PDF_BYTES) {
      throw new ProviderFailure("too-large", sentenceFor("too-large", options.label));
    }

    let data: Buffer;
    try {
      data = await readFile(real);
    } catch {
      throw gone;
    }
    const mediaType = sniffMediaType(data);
    const isPdf = mediaType === "application/pdf";
    if (mediaType === undefined || (part.type === "file") !== isPdf) throw invalid();

    loaded.push({
      kind: isPdf ? "pdf" : "image",
      mediaType,
      base64: data.toString("base64"),
      bytes: data.length,
      name: path.basename(real),
    });
  }
  return loaded;
}

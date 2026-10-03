/**
 * Serves a material's PDFs and photo pages to the window, behind the `studiplan-file:` scheme
 * (see `src/shared/preview.ts` for the URL form).
 *
 * The handler is a plain `Request -> Response` function with no Electron import, so the whole
 * of it runs in tests. `src/main/index.ts` hands it to `protocol.handle`.
 *
 * What it will serve is decided in two steps, and nowhere else:
 *   1. `parsePreviewUrl` takes the URL apart into names (or refuses it);
 *   2. `LibraryLookup.locateFile` turns the names into a path through the library's one path
 *      check and finds only what the library lists: a PDF, or a `.jpg` in a photo set.
 * A .pptx is found by the lookup (its text can be read) but is not served: the window has no
 * use for its bytes.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { LibraryErrorCode } from "@shared/library";
import { parsePreviewUrl } from "@shared/preview";
import type { LibraryLookup, LocatedFile } from "./library";

const CONTENT_TYPE: Record<Exclude<LocatedFile["kind"], "pptx">, string> = {
  pdf: "application/pdf",
  "photo-page": "image/jpeg",
};

/** Sent with every answer, refusals included. */
const BASE_HEADERS = {
  // The type we say is the type it is: the browser must not guess another one from the bytes.
  "X-Content-Type-Options": "nosniff",
  // A file can be replaced under the same name; always ask again.
  "Cache-Control": "no-store",
} as const;

function refuse(status: number, reason: string, extra: Record<string, string> = {}): Response {
  return new Response(reason, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

const STATUS: Record<LibraryErrorCode, number> = {
  "invalid-request": 400,
  "invalid-name": 400,
  "outside-library": 403,
  "not-found": 404,
  "unsupported-file": 404,
  "already-exists": 404,
  "too-large": 404,
  io: 500,
};

export type ByteRange = { start: number; end: number };

/**
 * Reads a `Range` header for a file of `size` bytes.
 * `null`: no usable range, send the whole file (also for several ranges at once, which a server
 * may ignore). `"unsatisfiable"`: a well-formed range that lies outside the file.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match as unknown as [string, string, string];
  if (first === "" && last === "") return null;

  if (first === "") {
    // The last N bytes.
    const length = Number(last);
    if (!Number.isSafeInteger(length) || length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  let end = last === "" ? size - 1 : Number(last);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  end = Math.min(end, size - 1);
  return { start, end };
}

function body(file: LocatedFile, range: ByteRange | null): ReadableStream<Uint8Array> | null {
  if (file.size === 0) return null;
  const stream = createReadStream(file.path, range ?? {});
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * The handler for the preview scheme. Never throws: every refusal is a response with a status
 * and a short reason that holds no path.
 */
export function createPreviewHandler(library: LibraryLookup): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return refuse(405, "Only reading is possible here.", { Allow: "GET, HEAD" });
      }

      const target = parsePreviewUrl(request.url);
      if (target === null) return refuse(400, "That is not the address of a file in the library.");

      const located = await library.locateFile(target.ref, target.name, target.page);
      if (!located.ok) return refuse(STATUS[located.error.code] ?? 500, located.error.message);
      const file = located.value;
      // A .pptx, or a PDF named where a photo page belongs: not something the window shows.
      if (file.kind === "pptx") return refuse(404, "That file cannot be shown here.");

      const headers: Record<string, string> = {
        ...BASE_HEADERS,
        "Content-Type": CONTENT_TYPE[file.kind],
        "Content-Disposition": "inline",
        "Accept-Ranges": "bytes",
      };

      const range = parseRange(request.headers.get("range"), file.size);
      if (range === "unsatisfiable") {
        return refuse(416, "That part of the file does not exist.", { "Content-Range": `bytes */${file.size}` });
      }

      const head = request.method === "HEAD";
      if (range !== null) {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${file.size}`;
        headers["Content-Length"] = String(range.end - range.start + 1);
        return new Response(head ? null : body(file, range), { status: 206, headers });
      }
      headers["Content-Length"] = String(file.size);
      return new Response(head ? null : body(file, null), { status: 200, headers });
    } catch {
      return refuse(500, "The file could not be read.");
    }
  };
}

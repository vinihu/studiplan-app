/**
 * The text of one PDF or .pptx of a material, for showing it in the window
 * (`library.extractText` on the bridge).
 *
 * Reading can take seconds, so:
 *   - it does not wait in the library's queue and does not hold it: finding the file is a quick
 *     look, and the reading itself runs beside every other call;
 *   - a file is read once. The result is kept in memory under path + size + modified time, so
 *     a changed or replaced file is read again and an unchanged one is not;
 *   - two calls for the same file while it is being read share that one reading;
 *   - a caller that cancels gets its answer at once. The reading it was waiting for runs on
 *     (it is bounded by the extraction time cap) and its result is kept for the next call.
 *
 * No Electron import, so it runs in tests.
 */
import type { LibraryResult } from "@shared/library";
import type { FileText, FileTextErrorCode, FileTextResult } from "@shared/preview";
import { extractText as realExtractText } from "../extract/extract";
import type { ExtractErrorCode, ExtractResult, TextFileKind } from "../extract/types";
import type { LocatedFile } from "./library";

/** How the extraction module's reasons appear on the bridge. Its sentences are passed on as they are. */
const CODE: Record<ExtractErrorCode, FileTextErrorCode> = {
  unreadable: "io",
  "too-large": "too-large",
  "not-a-pdf": "damaged",
  "not-a-pptx": "damaged",
  corrupt: "damaged",
  "no-slides": "damaged",
  encrypted: "encrypted",
  "no-text": "no-text",
  timeout: "timed-out",
  cancelled: "cancelled",
};

/** Results that may be different the next time: never remembered. */
const TRANSIENT: ReadonlySet<ExtractErrorCode> = new Set(["unreadable", "timeout", "cancelled"]);

const CANCELLED: FileTextResult = {
  ok: false,
  error: { code: "cancelled", message: "Cancelled." },
};

export interface TextReaderDeps {
  locateFile: (ref: unknown, name: unknown) => Promise<LibraryResult<LocatedFile>>;
  /** The extraction module. Replaced in tests. */
  extract?: (kind: TextFileKind, path: string) => Promise<ExtractResult>;
  /** How many files' results are kept. */
  maxEntries?: number;
  /** How many characters of text are kept in total. */
  maxChars?: number;
}

export interface TextReader {
  read(ref: unknown, name: unknown, signal?: AbortSignal): Promise<FileTextResult>;
  /** How many results are remembered or being read right now. For tests. */
  readonly size: number;
}

interface Entry {
  result: Promise<ExtractResult>;
  /** Characters held, once known. */
  chars: number;
}

function whenAborted(signal: AbortSignal): { promise: Promise<FileTextResult>; stop: () => void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<FileTextResult>((resolve) => {
    listener = () => resolve(CANCELLED);
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    stop: () => {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

export function createTextReader(deps: TextReaderDeps): TextReader {
  const extract = deps.extract ?? ((kind: TextFileKind, path: string) => realExtractText(kind, path));
  const maxEntries = deps.maxEntries ?? 24;
  const maxChars = deps.maxChars ?? 6_000_000;

  // Insertion order is age: the first key is the one used longest ago.
  const cache = new Map<string, Entry>();

  function trim(): void {
    let chars = 0;
    for (const entry of cache.values()) chars += entry.chars;
    for (const [key, entry] of cache) {
      if (cache.size <= 1 || (cache.size <= maxEntries && chars <= maxChars)) break;
      cache.delete(key);
      chars -= entry.chars;
    }
  }

  function extractOnce(file: LocatedFile & { kind: TextFileKind }): Promise<ExtractResult> {
    const key = `${file.path}\0${file.size}\0${file.mtimeMs}`;
    const known = cache.get(key);
    if (known) {
      // Used again: now the youngest.
      cache.delete(key);
      cache.set(key, known);
      return known.result;
    }

    const entry: Entry = {
      chars: 0,
      result: extract(file.kind, file.path).then(
        (result) => {
          if (!result.ok && TRANSIENT.has(result.error.code)) {
            if (cache.get(key) === entry) cache.delete(key);
          } else {
            entry.chars = result.ok ? result.value.text.length : 0;
            trim();
          }
          return result;
        },
        (error: unknown) => {
          if (cache.get(key) === entry) cache.delete(key);
          throw error;
        },
      ),
    };
    cache.set(key, entry);
    return entry.result;
  }

  async function readLocated(name: string, file: LocatedFile & { kind: TextFileKind }): Promise<FileTextResult> {
    let result: ExtractResult;
    try {
      result = await extractOnce(file);
    } catch {
      // The extraction module does not throw; this is for a replacement that does.
      return { ok: false, error: { code: "io", message: "The file could not be read. Try again." } };
    }
    if (!result.ok) {
      return { ok: false, error: { code: CODE[result.error.code] ?? "io", message: result.error.message } };
    }
    const document = result.value;
    const value: FileText = {
      name,
      kind: document.kind,
      unit: document.unit,
      totalCount: document.totalCount,
      readCount: document.sections.length,
      stopped: document.stopped,
      textlessCount: document.textlessCount,
      formulasLost: document.formulasLost,
      text: document.text,
    };
    return { ok: true, value };
  }

  async function read(ref: unknown, name: unknown, signal?: AbortSignal): Promise<FileTextResult> {
    if (signal?.aborted) return CANCELLED;

    const located = await deps.locateFile(ref, name);
    if (!located.ok) return located;
    const file = located.value;
    if (file.kind === "photo-page") {
      return { ok: false, error: { code: "unsupported-file", message: "Photos have no text to show." } };
    }
    if (signal?.aborted) return CANCELLED;

    const work = readLocated(name as string, { ...file, kind: file.kind });
    if (!signal) return work;
    const aborted = whenAborted(signal);
    try {
      return await Promise.race([work, aborted.promise]);
    } finally {
      aborted.stop();
    }
  }

  return {
    read,
    get size() {
      return cache.size;
    },
  };
}

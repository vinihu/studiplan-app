/**
 * Getting a JSON value out of a model's reply.
 *
 * Not every provider has strict structured output. A reply may be clean JSON, JSON inside a
 * ```json fence, or JSON with a sentence before and after it. This finds the value in all three
 * and otherwise says, in a sentence the model can act on, that there was none.
 *
 * Only `JSON.parse` ever interprets the text — nothing is evaluated.
 */

import { MAX_RAW_CHARS } from "./types";

export type JsonExtraction = { ok: true; value: unknown } | { ok: false; error: string };

/** How many `{` or `[` positions are tried as the start of the value before giving up. */
const MAX_CANDIDATES = 25;

const FENCE = /```[^\n`]*\n([\s\S]*?)```/g;

function tryParse(text: string): JsonExtraction | null {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

function isContainer(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * The end (exclusive) of the bracketed value starting at `start`, skipping over strings, or -1
 * when the brackets never balance.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first top-level `{…}` or `[…]` in `text` that parses.
 *
 * A candidate that does not parse is skipped whole, never searched inside: returning one card
 * out of a deck whose outer object has a stray comma would turn a clear "not valid JSON" into a
 * confusing complaint about the card. For the same reason a value that never closes ends the
 * search — everything after it is its inside — and is reported as cut off.
 */
function scan(text: string): { found: JsonExtraction | null; cut: boolean } {
  let tried = 0;
  let firstArray: JsonExtraction | null = null;
  for (let i = 0; i < text.length && tried < MAX_CANDIDATES; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    tried++;
    const end = balancedEnd(text, i);
    if (end === -1) return { found: firstArray, cut: firstArray === null };
    const parsed = tryParse(text.slice(i, end));
    if (parsed && parsed.ok && isContainer(parsed.value)) {
      // Every result is an object. An array is kept only as a fallback, so a "[1]" in the prose
      // before the real value is not taken for it.
      if (!Array.isArray(parsed.value)) return { found: parsed, cut: false };
      firstArray ??= parsed;
    }
    i = end - 1;
  }
  return { found: firstArray, cut: false };
}

/**
 * Parse JSON that may be wrapped in a code fence or have prose around it.
 *
 * Returns the first JSON object or array found. A bare string, number or `null` is not a result
 * any kind uses, so it counts as "no JSON".
 */
export function extractJson(reply: string): JsonExtraction {
  if (typeof reply !== "string") {
    return { ok: false, error: "The reply was not text." };
  }
  if (reply.length > MAX_RAW_CHARS) {
    return {
      ok: false,
      error: `The reply is ${reply.length} characters long; the limit is ${MAX_RAW_CHARS}. Write a shorter result.`,
    };
  }
  const text = reply.trim(); // trim() also drops a byte-order mark
  if (text === "") {
    return { ok: false, error: "The reply was empty. Reply with the JSON object." };
  }

  const direct = tryParse(text);
  if (direct && direct.ok && isContainer(direct.value)) return direct;

  for (const match of text.matchAll(FENCE)) {
    const inner = (match[1] ?? "").trim();
    const fenced = tryParse(inner);
    if (fenced && fenced.ok && isContainer(fenced.value)) return fenced;
  }

  const { found, cut } = scan(text);
  if (found) return found;

  return {
    ok: false,
    error: cut
      ? "The reply is not valid JSON: it starts a JSON value but stops before closing it, as if it was cut off. Write a complete JSON object; make the result shorter if needed."
      : "The reply is not valid JSON. Reply with one JSON object and nothing else: no text before or after it, no code fence, double-quoted keys and strings, no trailing commas, no comments.",
  };
}

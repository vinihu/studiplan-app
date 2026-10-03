/**
 * A result as a file: its name, and its text.
 *
 * Pure functions over strings — the main process does the reading and writing.
 *
 * ## The two formats
 *
 * **Flashcards, quiz, mock exam → one `.json` file**: the envelope with the content inside it.
 *
 * ```json
 * { "schemaVersion": 1, "kind": "quiz", "title": "Quiz: Cell division",
 *   "created": "2026-10-02T14:03:11.000Z", "provider": "claude-code", "model": "…",
 *   "coverage": "whole", "content": { "questions": [ … ] } }
 * ```
 *
 * **Summary and "something else" → one `.md` file**: the Markdown, with the envelope as a few
 * `key: value` lines of front matter above it.
 *
 * ```markdown
 * ---
 * title: "Summary: Cell division"
 * kind: summary
 * created: 2026-10-02T14:03:11.000Z
 * provider: claude-code
 * coverage: whole
 * length: medium
 * schemaVersion: 1
 * ---
 *
 * Cell division is …
 * ```
 *
 * Why front matter and not a sidecar file or nothing: a summary should be a file a student can
 * edit in any editor and back up as a plain file. A sidecar (`…-summary.meta.json`) gets
 * separated from its summary the first time someone copies or renames one of the two. Nothing
 * at all loses the title and who made it. Front matter keeps it one file, Markdown editors
 * and static-site tools know it, and it is **optional when reading**: if the student deletes
 * or mangles it, the file still opens — the kind and date come from the file name, the title
 * from the first heading or the kind, and the rest is recorded as unknown.
 *
 * The front matter written here is the small subset of YAML that is one `key: value` per line,
 * with strings JSON-quoted when they need quoting, so no value can spill onto a second line or
 * add a key. Reading it never needs a YAML parser.
 *
 * ## The file name decides the kind
 *
 * `YYYY-MM-DD-kind.ext`, the date in the computer's local time, `-2`, `-3`, … when that name is
 * taken. A list of results is built from names alone; when a file is opened, the kind from its
 * name says how to read it and the `kind` written inside is only a label.
 */

import {
  MAX_RAW_CHARS,
  MAX_SOURCE_NAME,
  MAX_TITLE,
  STUDY_SET_FORMATS,
  STUDY_SET_KINDS,
  STUDY_SET_KIND_LABELS,
  STUDY_SET_SCHEMA_VERSION,
  type MaterialCoverage,
  type StudySet,
  type StudySetContentByKind,
  type StudySetFormat,
  type StudySetKind,
  type StudySetMeta,
  type Validation,
} from "./types";
import { cleanText, isRecord, validateStudySetContent } from "./validate";

/* ------------------------------------------------------------------ *
 * File names
 * ------------------------------------------------------------------ */

const EXTENSIONS: Readonly<Record<StudySetFormat, string>> = { markdown: "md", json: "json" };

export function studySetExtension(kind: StudySetKind): string {
  return EXTENSIONS[STUDY_SET_FORMATS[kind]];
}

/** What a result's file name says about it. */
export interface StudySetFileInfo {
  fileName: string;
  kind: StudySetKind;
  format: StudySetFormat;
  /** `YYYY-MM-DD`, the local date it was made on. */
  date: string;
  /** 1 for the first result of that kind on that day, 2 for `-2`, and so on. */
  sequence: number;
}

const FILE_NAME = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})-(${STUDY_SET_KINDS.join("|")})(?:-([1-9]\\d{0,3}))?\\.(md|json)$`,
  "i",
);

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1900) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Read a file name from `sets/` back into its kind and date. `null` for anything that is not a
 * result's name (another file the student put there, a wrong extension for the kind, an
 * impossible date). Takes a bare name: anything with a path separator is not one.
 */
export function parseStudySetFileName(fileName: string): StudySetFileInfo | null {
  if (typeof fileName !== "string" || fileName.length > 64) return null;
  const match = FILE_NAME.exec(fileName);
  if (!match) return null;
  const [, year = "", month = "", day = "", rawKind = "", rawSequence, extension = ""] = match;
  const kind = STUDY_SET_KINDS.find((candidate) => candidate === rawKind.toLowerCase());
  if (!kind) return null;
  if (extension.toLowerCase() !== studySetExtension(kind)) return null;
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  const sequence = rawSequence === undefined ? 1 : Number(rawSequence);
  if (sequence < 2 && rawSequence !== undefined) return null; // "-1" is never written
  return { fileName, kind, format: STUDY_SET_FORMATS[kind], date: `${year}-${month}-${day}`, sequence };
}

/** `YYYY-MM-DD` of `date` in local time. */
export function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  if (Number.isNaN(year) || year < 1900 || year > 9999) {
    throw new RangeError("A result needs a valid date.");
  }
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * The file name for a new result: `2026-10-02-quiz.json`, or `2026-10-02-quiz-2.json` when the
 * first is taken.
 *
 * `existingNames` are the names already in the material's `sets/` folder. The number is one more
 * than the highest already used for that day and kind — not the first gap — so a later result
 * always sorts after an earlier one even when one in between was deleted. Names are compared
 * without regard to case, as Windows and macOS do.
 */
export function studySetFileName(
  kind: StudySetKind,
  date: Date,
  existingNames: Iterable<string> = [],
): string {
  const stamp = localDateStamp(date);
  const extension = studySetExtension(kind);
  const taken = new Set<string>();
  let highest = 0;
  for (const name of existingNames) {
    taken.add(name.toLowerCase());
    const info = parseStudySetFileName(name);
    if (info && info.kind === kind && info.date === stamp) highest = Math.max(highest, info.sequence);
  }
  for (let sequence = highest + 1; ; sequence++) {
    const name =
      sequence === 1 ? `${stamp}-${kind}.${extension}` : `${stamp}-${kind}-${sequence}.${extension}`;
    if (!taken.has(name)) return name;
  }
}

/** Sort order for the Results list: newest first, by date and then by number. */
export function compareStudySetFilesNewestFirst(a: StudySetFileInfo, b: StudySetFileInfo): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.sequence !== b.sequence) return b.sequence - a.sequence;
  return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
}

/** The results among the names in a `sets/` folder, newest first. Other files are ignored. */
export function listStudySetFiles(names: Iterable<string>): StudySetFileInfo[] {
  const found: StudySetFileInfo[] = [];
  for (const name of names) {
    const info = parseStudySetFileName(name);
    if (info) found.push(info);
  }
  return found.sort(compareStudySetFilesNewestFirst);
}

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

function singleLine(value: string, max: number): string {
  return cleanText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function sourceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = singleLine(value, MAX_SOURCE_NAME);
  return name === "" ? null : name;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function coverageOf(value: unknown): MaterialCoverage {
  return value === "whole" || value === "cut" ? value : "unknown";
}

export interface NewStudySet<K extends StudySetKind> {
  kind: K;
  /** Already validated content, from `parseGenerationOutput()`. */
  content: StudySetContentByKind[K];
  /** Shown in the Results list. Blank falls back to the kind's name. */
  title: string;
  created: Date;
  /** The provider's id, e.g. `claude-code`. */
  provider: string | null;
  model: string | null;
  coverage: "whole" | "cut";
}

/** Put validated content into its envelope, ready for `serialiseStudySet()`. */
export function createStudySet<K extends StudySetKind>(input: NewStudySet<K>): StudySet<K> {
  const title = singleLine(input.title, MAX_TITLE) || STUDY_SET_KIND_LABELS[input.kind];
  const meta: StudySetMeta = {
    schemaVersion: STUDY_SET_SCHEMA_VERSION,
    title,
    created: input.created.toISOString(),
    provider: sourceName(input.provider),
    model: sourceName(input.model),
    coverage: input.coverage,
  };
  return { ...meta, kind: input.kind, content: input.content } as StudySet<K>;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** A value that is safe to write bare after `key: `; anything else is JSON-quoted. */
const BARE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]*$/;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

function frontMatterValue(value: string): string {
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/i.test(value) || /^[\d.+-]/.test(value);
  if (BARE_VALUE.test(value) && !reserved && !value.includes(": ") && !value.endsWith(" ") && !value.endsWith(":")) {
    return value;
  }
  return JSON.stringify(value);
}

function frontMatter(entries: ReadonlyArray<readonly [string, string | number | null]>): string {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === null) continue;
    // A timestamp is written bare so it reads as one; everything else goes through the check.
    const text =
      typeof value === "number"
        ? String(value)
        : key === "created" && TIMESTAMP.test(value)
          ? value
          : frontMatterValue(value);
    lines.push(`${key}: ${text}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** The text to write to the result's file. Ends with a newline. */
export function serialiseStudySet(set: StudySet): string {
  if (set.kind === "summary" || set.kind === "custom" || set.kind === "explain" || set.kind === "cheatsheet") {
    const head = frontMatter([
      ["title", set.title],
      ["kind", set.kind],
      ["created", set.created],
      ["provider", set.provider],
      ["model", set.model],
      ["coverage", set.coverage],
      ...(set.kind === "summary"
        ? [["length", set.content.length] as const]
        : set.kind === "custom"
          ? [["request", set.content.request] as const]
          : []),
      ["schemaVersion", set.schemaVersion],
    ]);
    return `${head}\n\n${set.content.body.trim()}\n`;
  }
  const envelope = {
    schemaVersion: set.schemaVersion,
    kind: set.kind,
    title: set.title,
    created: set.created,
    provider: set.provider,
    model: set.model,
    coverage: set.coverage,
    content: set.content,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const FRONT_MATTER_KEYS = new Set([
  "title",
  "kind",
  "created",
  "provider",
  "model",
  "coverage",
  "length",
  "request",
  "schemaversion",
]);

const FRONT_MATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

function readFrontMatterValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not our quoting; fall through to stripping the quotes.
    }
  }
  if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) return value.slice(1, -1);
  return value;
}

/**
 * Split a Markdown file into its front matter and its body. A leading `---` block counts as
 * front matter only when it holds at least one key this app writes; otherwise the file is all
 * body (a document that merely starts with a horizontal rule stays whole).
 */
export function splitFrontMatter(text: string): { fields: Map<string, string>; body: string } {
  const source = cleanText(text);
  const none = { fields: new Map<string, string>(), body: source };
  if (!source.startsWith("---\n")) return none;
  const lines = source.split("\n");
  let end = -1;
  // Front matter is short. A closing line far down is a horizontal rule, not ours.
  for (let i = 1; i < lines.length && i <= 40; i++) {
    if ((lines[i] ?? "").trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return none;

  const fields = new Map<string, string>();
  let known = 0;
  for (const line of lines.slice(1, end)) {
    const match = FRONT_MATTER_LINE.exec(line);
    if (!match) continue; // a comment, a blank line, or YAML another tool added
    const key = (match[1] ?? "").toLowerCase();
    if (FRONT_MATTER_KEYS.has(key)) known++;
    if (!fields.has(key)) fields.set(key, readFrontMatterValue(match[2] ?? ""));
  }
  if (known === 0) return none;
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** The text of the first Markdown heading, without its `#` marks or emphasis. */
function firstHeading(body: string): string | null {
  // Line by line, and only the start of a line that begins with `#`: the pattern is then run on
  // a few hundred characters at most. Run on the whole body it took seconds on a heading
  // followed by a few thousand blanks, and a body can be two million characters.
  for (const raw of body.split("\n")) {
    if (!raw.startsWith("#")) continue;
    const match = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(raw.slice(0, 400).trimEnd());
    if (!match || match[1] === undefined) continue;
    const text = singleLine(match[1].replace(/[*_`]/g, ""), MAX_TITLE);
    return text === "" ? null : text;
  }
  return null;
}

/** Local midnight of the date in the file name, for a file that carries no timestamp. */
function createdFromName(info: StudySetFileInfo): string {
  const [year = 1970, month = 1, day = 1] = info.date.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

function readMeta(
  info: StudySetFileInfo,
  get: (key: string) => unknown,
  fallbackTitle: string | null,
): StudySetMeta {
  const rawTitle = get("title");
  const title =
    (typeof rawTitle === "string" ? singleLine(rawTitle, MAX_TITLE) : "") ||
    fallbackTitle ||
    STUDY_SET_KIND_LABELS[info.kind];
  return {
    schemaVersion: STUDY_SET_SCHEMA_VERSION,
    title,
    created: isoTimestamp(get("created")) ?? createdFromName(info),
    provider: sourceName(get("provider")),
    model: sourceName(get("model")),
    coverage: coverageOf(get("coverage")),
  };
}

const NEWER_VERSION =
  "This file was saved by a newer version of the app. Update the app to open it.";

function isNewerVersion(value: unknown): boolean {
  const version = typeof value === "string" ? Number(value) : value;
  return typeof version === "number" && Number.isFinite(version) && version > STUDY_SET_SCHEMA_VERSION;
}

/**
 * Read a result's file back into a `StudySet`, validating it exactly as a model's reply is
 * validated: the file may have been edited by hand, or by anything else.
 *
 * `fileName` is the bare name in `sets/`; it decides the kind. The errors are sentences that can
 * be shown to the student.
 */
export function parseStudySetFile(fileName: string, text: string): Validation<StudySet> {
  const info = parseStudySetFileName(fileName);
  if (!info) {
    return { ok: false, errors: [`"${String(fileName).slice(0, 80)}" is not the name of a result.`] };
  }
  if (typeof text !== "string") {
    return { ok: false, errors: ["The file could not be read as text."] };
  }
  if (text.length > MAX_RAW_CHARS) {
    return { ok: false, errors: [`The file is too large to open (${text.length} characters).`] };
  }

  if (info.format === "markdown") {
    const { fields, body } = splitFrontMatter(text);
    if (isNewerVersion(fields.get("schemaversion"))) return { ok: false, errors: [NEWER_VERSION] };
    const content = validateStudySetContent(info.kind, {
      body,
      length: fields.get("length"),
      request: fields.get("request"),
    });
    if (!content.ok) {
      return { ok: false, errors: ["The file has no text in it."] };
    }
    const meta = readMeta(info, (key) => fields.get(key), firstHeading(body));
    return {
      ok: true,
      value: { ...meta, kind: info.kind, content: content.value } as StudySet,
      warnings: content.warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()); // trim() also drops a byte-order mark
  } catch {
    return { ok: false, errors: ["The file is not valid JSON, so it cannot be opened."] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, errors: ["The file does not hold a result: it must be a JSON object."] };
  }
  if (isNewerVersion(parsed.schemaVersion)) return { ok: false, errors: [NEWER_VERSION] };
  if (parsed.content === undefined) {
    return { ok: false, errors: ['The file does not hold a result: it has no "content".'] };
  }
  const content = validateStudySetContent(info.kind, parsed.content);
  if (!content.ok) return content;
  const meta = readMeta(info, (key) => parsed[key], null);
  return {
    ok: true,
    value: { ...meta, kind: info.kind, content: content.value } as StudySet,
    warnings: content.warnings,
  };
}

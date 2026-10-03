/**
 * Names of folders and files in the library.
 *
 * The rules are Windows' rules, applied on every platform, so a library made on one computer
 * can be copied to another. Unicode is kept: only what a Windows folder cannot hold is changed.
 */

/** Longest subject name and longest material folder name, in UTF-16 units (what Windows counts). */
export const MAX_FOLDER_NAME = 60;
/** Longest material title. The title lives in `material.json`, so it may be longer than a folder name. */
export const MAX_TITLE = 200;
/** Longest stored file name, extension included. */
export const MAX_FILE_NAME = 80;
/**
 * The longest whole path the app will create. Windows tools (Explorer among them) still stop
 * at 260; with a root like `C:\Users\name\Documents\Studiplan` the limits above stay under it.
 */
export const MAX_PATH_LENGTH = 259;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** Windows treats `NUL`, `nul.txt` and `NUL .pdf` all as the device: only the part before the first dot counts. */
export function isReservedDeviceName(name: string): boolean {
  const base = name.split(".")[0] ?? "";
  return DEVICE_NAME.test(base.trim());
}

/** Files the system or other programs leave in folders. They are never listed and never counted. */
export function isHiddenName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    lower === "desktop.ini" ||
    lower === "thumbs.db" ||
    lower === "ehthumbs.db" ||
    lower === "$recycle.bin" ||
    lower === "system volume information"
  );
}

/** Two names with the same key are the same folder on Windows and on a default macOS disk. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Cuts to at most `max` UTF-16 units without splitting a character in two. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const character of text) {
    if (out.length + character.length > max) break;
    out += character;
  }
  return out;
}

function stripEnds(text: string): string {
  // A folder name cannot end in a dot or a space on Windows; a leading dot would hide it.
  return text.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
}

/**
 * Turns what the user typed into something a folder can be called: separators become a dash,
 * the other forbidden characters are dropped, whitespace is collapsed, and dots and spaces at
 * the ends are removed. The result may be empty, and it may still be a reserved device name
 * or too long — the caller decides what to do about those.
 */
export function sanitiseName(input: string): string {
  const cleaned = input
    .normalize("NFC")
    .replace(/[/\\:|]/g, "-")
    .replace(/[<>"?*]/g, "")
    .replace(CONTROL, " ")
    .replace(/\s+/gu, " ");
  return stripEnds(cleaned);
}

/** The title as it is stored in `material.json`: one line, trimmed. Any printable character is fine. */
export function cleanTitle(input: string): string {
  return input.normalize("NFC").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
}

/** The folder name for a material with this title. Empty if the title has nothing a folder can hold. */
export function folderNameFromTitle(title: string): string {
  let name = stripEnds(truncate(sanitiseName(title), MAX_FOLDER_NAME));
  if (name !== "" && isReservedDeviceName(name)) name = `_${name}`;
  return name;
}

/**
 * The name a copied file is stored under. `extension` is the checked, lower-case extension
 * with its dot. Never empty: a name with nothing usable in it becomes `file`.
 */
export function storedFileName(sourceName: string, extension: string, maxLength = MAX_FILE_NAME): string {
  const dot = sourceName.lastIndexOf(".");
  const rawStem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  let stem = stripEnds(truncate(sanitiseName(rawStem), Math.max(1, maxLength - extension.length)));
  if (stem === "") stem = "file";
  if (isReservedDeviceName(stem) || isHiddenName(stem + extension)) stem = `_${stem}`;
  return `${stem}${extension}`;
}

/**
 * True if `value` can be used as one path segment exactly as it is. This is the test for
 * every id that arrives over the bridge and for every name read from `material.json`:
 * it must already be a clean name, nothing is repaired.
 */
export function isSafeSegment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 255) return false;
  if (value === "." || value === "..") return false;
  if (FORBIDDEN.test(value)) return false;
  // Windows silently drops trailing dots and spaces, so "Biology." would be another way to
  // say "Biology".
  if (/[\s.]$/u.test(value) || /^\s/u.test(value)) return false;
  if (isReservedDeviceName(value)) return false;
  return true;
}

/**
 * `stem + extension`, or `stem-2`, `stem-3`, … with the extension — the first one whose key
 * is not in `taken` (a set of `nameKey`s).
 */
export function firstFreeName(stem: string, extension: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${stem}${extension}` : `${stem}-${n}${extension}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Order for lists: "Lecture 2" before "Lecture 10", case and accents ignored. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The longest text taken as a typed name before it is tidied. Tidying drops characters, so a
 * name may be typed longer than it ends up, but not without limit.
 */
export const MAX_TYPED_NAME = 4 * MAX_FOLDER_NAME;

/** The longest path of a file to add that is looked at. Windows itself stops at 32,767. */
export const MAX_SOURCE_PATH = 4_096;

/**
 * Whether `source` names a file on one of this computer's drives: on Windows `C:\…` (or
 * `C:/…`) and nothing else. Not a network path (`\\server\share\…`, `//server/share/…`), not
 * a device or "long" path (`\\.\…`, `\\?\…`). Elsewhere every absolute path is local in
 * this sense.
 */
export function isLocalFilePath(source: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return source.startsWith("/") && !source.startsWith("//");
  return /^[A-Za-z]:[\\/]/.test(source);
}

/**
 * What may go into a log line. The log is the console of the main process; whoever is sent a
 * copy of it to help with a problem must not learn the user's account name or where their
 * files are from it. So nothing that is logged carries a path:
 *
 *  - an error becomes its name and, for an error of the file system, its code and the call that
 *    failed, never its message, `path`, `dest` or stack (those name the file);
 *  - text from another program (a tool's error output) has anything that looks like an
 *    absolute path replaced.
 *
 * No Electron import; pure.
 */

/** A drive path, a UNC or device path, a `file:` address, or a path under a usual root of a Unix system. */
const PATH_LIKE =
  /file:\/\/\/?[^\s"'<>|*?]+|\\\\[^\s"'<>|*?]+|(?<![:\w])\/\/[^\s"'<>|*?]+|(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>|*?]*|(?<![\w.:/-])\/(?:Users|home|root|tmp|var|private|opt|usr|etc|mnt|media|Volumes|Applications|Library)\/[^\s"'<>|*?]*/g;

/** `text` with everything that looks like an absolute path replaced by `[path]`. */
export function redactPaths(text: string): string {
  return text.replace(PATH_LIKE, "[path]");
}

/** What is logged of an error: its kind, never where it happened. */
export function describeError(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null) return { error: redactPaths(String(error)).slice(0, 200) };
  const record = error as { name?: unknown; code?: unknown; syscall?: unknown; message?: unknown };
  const described: Record<string, string> = { name: typeof record.name === "string" ? record.name : "Error" };
  if (typeof record.code === "string") {
    described["code"] = record.code;
    if (typeof record.syscall === "string") described["syscall"] = record.syscall;
    return described;
  }
  // Not from the file system: the message says what went wrong; any path in it is taken out.
  if (typeof record.message === "string") described["message"] = redactPaths(record.message).slice(0, 200);
  return described;
}

/** A value for a log line with every string in it, at any depth, free of paths. */
export function withoutPaths(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactPaths(value);
  if (value instanceof Error) return describeError(value);
  if (depth >= 4 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => withoutPaths(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutPaths(item, depth + 1)]));
}

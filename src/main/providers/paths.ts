/**
 * Material paths for CLI providers: every `file`/`image` part must lie inside the working
 * directory, and is handed to the tool as a relative path with forward slashes.
 *
 * The check here is on the path's text. It is one of two guards: the CLI tool itself is also
 * started so that it cannot read outside its working directory.
 */
import path from "node:path";
import { ProviderFailure, sentenceFor } from "./errors";
import type { Part } from "./provider";

function invalid(): ProviderFailure {
  return new ProviderFailure("invalid-request", sentenceFor("invalid-request", ""));
}

// Control characters would let a file name break out of its line in the prompt.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Returns the parts with every path made relative to `workingDirectory`.
 * Throws `invalid-request` when a path leaves the folder or cannot be listed safely.
 */
export function toWorkingDirectoryParts(
  parts: readonly Part[],
  workingDirectory: string | undefined,
  pathApi: path.PlatformPath = path,
): Part[] {
  return parts.map((part) => {
    if (part.type === "text") return part;
    if (workingDirectory === undefined || !pathApi.isAbsolute(workingDirectory)) throw invalid();
    if (part.path.length === 0 || CONTROL.test(part.path)) throw invalid();

    const absolute = pathApi.resolve(workingDirectory, part.path);
    const relative = pathApi.relative(workingDirectory, absolute);
    const escapes =
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative);
    if (escapes) throw invalid();

    return { type: part.type, path: relative.split(pathApi.sep).join("/") };
  });
}

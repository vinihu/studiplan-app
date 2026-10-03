import { realpath } from "node:fs/promises";
import path from "node:path";
import { fail, isErrno } from "./errors";
import { isSafeSegment } from "./names";

export const OUTSIDE = "That is not inside your library, so Studiplan left it alone.";

/** True if `child` is `parent` or lies below it. Both must be absolute. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The real location of the deepest part of `target` that exists, with the rest appended. */
async function realpathOfExistingPart(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if (!isErrno(error, "ENOENT", "ENOTDIR")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The one way from names to a path. Everything the library reads, writes, renames or deletes
 * gets its path here.
 *
 * `segments` are names that came from outside the main process (the renderer, or the contents
 * of `material.json`) or constants such as `files`. Each must be a single clean path segment:
 * no separators, no `..`, no drive letter or stream (`:`), no trailing dot or space, not a
 * device name. The joined path must stay under `root` as written, and again after every
 * symbolic link and junction on the way has been followed — so a link inside the library
 * that points somewhere else cannot be used to reach outside.
 *
 * `root` must exist. The target itself does not have to.
 * Throws `LibraryFailure("outside-library")` otherwise.
 */
export async function resolveInside(root: string, ...segments: unknown[]): Promise<string> {
  if (!path.isAbsolute(root)) fail("outside-library", OUTSIDE);
  for (const segment of segments) {
    if (!isSafeSegment(segment)) fail("outside-library", OUTSIDE);
  }

  const base = path.resolve(root);
  const target = path.resolve(base, ...(segments as string[]));
  if (!isInside(base, target)) fail("outside-library", OUTSIDE);
  // Each segment must have become exactly one level; anything else means a name was
  // understood by the system in a way the checks above did not expect.
  if (path.relative(base, target).split(path.sep).filter(Boolean).length !== segments.length) {
    fail("outside-library", OUTSIDE);
  }

  const realRoot = await realpath(base);
  const realTarget = await realpathOfExistingPart(target);
  if (!isInside(realRoot, realTarget)) fail("outside-library", OUTSIDE);

  return target;
}

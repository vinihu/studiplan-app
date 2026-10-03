/**
 * The temporary folders the command-line providers make for one request each
 * (`studiplan-codex-…`: instructions, schema, copies of photos; `studiplan-claude-…`: the
 * instructions). Each is removed when its request ends. One that is left behind — the app was
 * closed or crashed in the middle — is removed here, the next time the app starts.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

/** The start of every such folder's name. Nothing else in the temporary folder is touched. */
export const TEMP_FOLDER_PREFIXES = ["studiplan-codex-", "studiplan-claude-"] as const;

/** Older than any request can be: a request is ended after ten minutes. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the app's own leftover folders directly inside `tempRoot` that are older than
 * `olderThanMs`. Only real folders with one of the app's prefixes; never a link, never anything
 * deeper. Returns how many were removed. Never throws.
 */
export async function sweepStaleTempFolders(tempRoot: string, olderThanMs = STALE_AFTER_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(tempRoot)) {
      if (!TEMP_FOLDER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const folder = path.join(tempRoot, name);
      try {
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < olderThanMs) continue;
        await rm(folder, { recursive: true, force: true });
        removed += 1;
      } catch {
        // In use, or gone already: the next start looks again.
      }
    }
  } catch {
    // No temporary folder to look in.
  }
  return removed;
}

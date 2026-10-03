/**
 * Finding a command-line tool on this computer, shared by the CLI providers.
 *
 * An app started from the Start menu or the Dock does not always get the same PATH as a
 * terminal, so the tool's usual install folders are checked as well as PATH.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

export type IsFileFn = (file: string) => Promise<boolean>;

export const isFileOnDisk: IsFileFn = async (file) => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

/** The folders listed in PATH. Windows spells the variable `Path`, so the name is matched loosely. */
export function pathDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  const value = key === undefined ? undefined : env[key];
  if (value === undefined || value.length === 0) return [];
  const api = platform === "win32" ? path.win32 : path.posix;
  return value
    .split(api.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0 && api.isAbsolute(entry));
}

/**
 * The first existing file among `directories` × `fileNames`, directories first.
 * Give real executables only (`tool.exe` on Windows, never a `.cmd` shim: those need a shell).
 */
export async function findExecutable(
  fileNames: readonly string[],
  directories: readonly string[],
  platform: NodeJS.Platform,
  isFile: IsFileFn = isFileOnDisk,
): Promise<string | undefined> {
  const api = platform === "win32" ? path.win32 : path.posix;
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const name of fileNames) {
      const candidate = api.join(directory, name);
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

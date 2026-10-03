import path from "node:path";
import type { LibraryInfo } from "@shared/library";
import { LibraryFailure } from "./errors";

/** The environment variable that points the library at another folder (tests, the smoke test). */
export const LIBRARY_DIR_ENV = "STUDIPLAN_LIBRARY_DIR";

/** The folder the library gets inside the user's Documents. */
export const DEFAULT_FOLDER_NAME = "Studiplan";

function usable(candidate: string | undefined): candidate is string {
  return typeof candidate === "string" && candidate.trim() !== "" && path.isAbsolute(candidate);
}

/**
 * Where the library is. In order: the environment override, the folder chosen in Settings,
 * `Documents/Studiplan`. A value that is not an absolute path is ignored.
 */
export function resolveLibraryRoot(sources: {
  /** Value of `STUDIPLAN_LIBRARY_DIR`, if set. */
  override: string | undefined;
  /** `libraryRoot` from the settings file, if set. */
  configured: string | undefined;
  /** The user's Documents folder. */
  documents: string;
}): LibraryInfo {
  const fallback = path.join(sources.documents, DEFAULT_FOLDER_NAME);
  const fixedByEnvironment = usable(sources.override);
  const chosen = usable(sources.override)
    ? sources.override
    : usable(sources.configured)
      ? sources.configured
      : fallback;
  const root = path.resolve(chosen);
  return { root, isDefault: path.relative(root, path.resolve(fallback)) === "", fixedByEnvironment };
}

export interface CheckedLibraryRoot {
  info: LibraryInfo;
  /** The folder from the settings file that was refused, when one was. `info` is the default then. */
  refused: string | null;
}

/**
 * Where the library is, with the folder from the settings file put through the same rules a
 * folder picked in Settings has to pass (`check` is `checkLibraryRoot`). The settings file can
 * be edited by hand, and a folder that was fine when it was chosen can be gone later, so what is
 * stored is never trusted because it is stored. A folder that fails is not used: the library is
 * at its default place instead, and `info.notice` says so in a sentence.
 *
 * The environment override is NOT checked. It exists only in builds with the development hooks
 * on (the caller passes `undefined` in a release build), where the smoke tests point it at
 * temporary folders that the rules would refuse, for instance for the length of their path.
 */
export async function resolveCheckedLibraryRoot(sources: {
  override: string | undefined;
  configured: string | undefined;
  documents: string;
  /** Resolves to the folder to use (its real location), or throws a `LibraryFailure`. */
  check: (folder: string) => Promise<string>;
}): Promise<CheckedLibraryRoot> {
  const { override, configured, documents } = sources;
  const unchecked = resolveLibraryRoot({ override, configured, documents });
  // Nothing from the settings file is in use: the override, or the default place (which is
  // made when the first subject is, so it need not exist yet).
  if (unchecked.fixedByEnvironment || unchecked.isDefault || !usable(configured)) return { info: unchecked, refused: null };

  try {
    const real = await sources.check(configured);
    return { info: resolveLibraryRoot({ override: undefined, configured: real, documents }), refused: null };
  } catch (error) {
    const fallback = resolveLibraryRoot({ override: undefined, configured: undefined, documents });
    const reason =
      error instanceof LibraryFailure && error.code !== "invalid-request"
        ? error.message
        : "That folder cannot be used as a library.";
    return {
      info: {
        ...fallback,
        notice:
          `Studiplan could not use the library folder saved in its settings (${configured}), ` +
          `so it is showing the library in ${fallback.root} instead. ${reason} Nothing was moved or deleted. ` +
          "You can choose the folder again in Settings.",
      },
      refused: configured,
    };
  }
}

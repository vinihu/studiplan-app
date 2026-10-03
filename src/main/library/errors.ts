import type { LibraryErrorCode, LibraryResult } from "@shared/library";

/**
 * A failure the user can be told about. `message` is a plain sentence: no paths, no error
 * codes, no stack traces. Anything else that is thrown is treated as unexpected.
 */
export class LibraryFailure extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.name = "LibraryFailure";
    this.code = code;
  }
}

export function fail(code: LibraryErrorCode, message: string): never {
  throw new LibraryFailure(code, message);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  const code = errnoCode(error);
  return code !== undefined && codes.includes(code);
}

/** The sentence for an error nobody planned for. The real error goes to the log, not the user. */
function sentenceForUnexpected(error: unknown): string {
  switch (errnoCode(error)) {
    case "ENOSPC":
      return "The disk is full. Free up some space and try again.";
    case "EBUSY":
    case "EPERM":
    case "EACCES":
    case "ENOTEMPTY":
      return "A file or folder is open in another program, or Studiplan is not allowed to change it. Close anything that is using it and try again.";
    case "ENOENT":
      return "Something in the library was moved or deleted while Studiplan was working. Check the library folder and try again.";
    default:
      return "Something went wrong while reading or writing the library. Try again.";
  }
}

/**
 * Runs one library operation and turns whatever happens into a `LibraryResult`.
 * Nothing thrown inside ever crosses the bridge.
 */
export async function toResult<T>(
  operation: () => Promise<T>,
  log: (error: unknown) => void,
): Promise<LibraryResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof LibraryFailure) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    log(error);
    return { ok: false, error: { code: "io", message: sentenceForUnexpected(error) } };
  }
}

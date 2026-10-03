import { redactPaths, withoutPaths } from "../log-safe";
import type { ProviderErrorCode, ProviderResult } from "@shared/providers";

/**
 * A provider failure the user can be told about. `message` is a plain sentence that says what
 * to do: no paths, no arguments, no stack traces. Technical detail goes to the log instead.
 */
export class ProviderFailure extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderFailure";
    this.code = code;
  }
}

/**
 * The sentence for each failure. `label` is the provider's name as the user knows it
 * ("Claude Code"). Providers may pass their own sentence to `failure()` when they know more.
 */
export function sentenceFor(code: ProviderErrorCode, label: string): string {
  switch (code) {
    case "not-installed":
      return `${label} is not installed on this computer. Install it, then press Test again in Settings.`;
    case "not-signed-in":
      return `${label} is installed but not signed in. Open ${label} once, sign in, then try again.`;
    case "usage-limit":
      return `Your ${label} usage limit is reached for now. Wait until it resets, or choose another AI in Settings.`;
    case "cancelled":
      return "Cancelled. Nothing was saved.";
    case "timed-out":
      return `${label} took too long and was stopped. Try again, or try with less material.`;
    case "bad-output":
      return `${label} answered, but not in the form Studiplan needs. Try again.`;
    case "model-unavailable":
      return `The chosen model is not available in ${label}. Pick another model in Settings.`;
    case "offline":
      return `${label} could not reach its service. Check your internet connection and try again.`;
    case "busy":
      return `The service behind ${label} is busy right now. Wait a minute and try again.`;
    case "too-large":
      return `This is too much material for ${label} to handle in one go. Try again with fewer or shorter files.`;
    case "invalid-request":
      return "Studiplan could not prepare this request. Please report this as a bug.";
    case "failed":
      return `${label} could not finish the request. Try again; if it keeps failing, press Test in Settings.`;
  }
}

export function failure(code: ProviderErrorCode, label: string, message?: string): ProviderFailure {
  return new ProviderFailure(code, message ?? sentenceFor(code, label));
}

/** Where technical detail goes. Never receives prompt contents or material text. */
export type ProviderLog = (message: string, detail?: Record<string, unknown>) => void;

export const consoleLog: ProviderLog = (message, detail) => {
  // A tool's own error text can name a temporary folder, and with it the user's account. Nothing
  // that looks like a path reaches the log (`src/main/log-safe.ts`).
  if (detail === undefined) console.error(`[providers] ${redactPaths(message)}`);
  else console.error(`[providers] ${redactPaths(message)}`, withoutPaths(detail));
};

/**
 * Runs one provider call and turns whatever happens into a `ProviderResult`, so nothing thrown
 * crosses the bridge and the sentence survives it. For the IPC handlers.
 */
export async function toProviderResult<T>(
  operation: () => Promise<T>,
  log: ProviderLog = consoleLog,
): Promise<ProviderResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ProviderFailure) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    log("unexpected error", { name: error instanceof Error ? error.name : typeof error });
    return {
      ok: false,
      error: { code: "failed", message: "Something went wrong while talking to the AI. Try again." },
    };
  }
}

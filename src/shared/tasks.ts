/**
 * Long-running calls: how the renderer cancels one, and how the main process reports progress.
 *
 * The bridge is request/response, so a call that can be cancelled takes a `requestId` the
 * renderer makes up before calling. While the call is running:
 *
 *   - `tasks.cancel(requestId)` stops it. The original call then resolves, as it always does,
 *     with a failure whose code is `"cancelled"`.
 *   - the main process may send `taskProgress` events carrying the same `requestId`
 *     (`window.studiplan.events.subscribe("taskProgress", listener)`).
 *
 * Pure: no Node, no Electron, no DOM.
 */

/** Letters, digits, `-` and `_`, 8 to 64 characters. A UUID fits. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

/** A fresh id for one cancellable call. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** One progress report for a running call. */
export interface TaskProgress {
  /** The id the renderer passed to the call this is about. */
  requestId: string;
  /** A short plain sentence saying what is happening now, e.g. "Asking Claude Code…". */
  message: string;
  /** How far along, from 0 to 1, or `null` when that cannot be known (show an indeterminate bar). */
  fraction: number | null;
}

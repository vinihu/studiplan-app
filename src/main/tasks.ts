/**
 * The calls that are running right now and can be cancelled.
 *
 * The renderer names each cancellable call with a `requestId` (see `src/shared/tasks.ts`). The
 * handler runs its work through `run`, which hands it an `AbortSignal`; `cancel(requestId)`
 * fires that signal. What "cancelled" means is up to the work: it sees the signal, stops, and
 * resolves in its own result type.
 *
 * No Electron import, so it runs in tests.
 */
import { isRequestId } from "@shared/tasks";

export type TaskStart =
  | { ok: true; signal: AbortSignal; finish: () => void }
  | { ok: false; reason: "invalid-id" | "already-running" };

export interface TaskRegistry {
  /**
   * Registers a running call. Synchronous on purpose: a handler calls it before its first
   * `await`, so a `cancel` that arrives right behind the call always finds it.
   * `finish` must be called when the work ends, however it ends.
   */
  start(requestId: unknown): TaskStart;
  /**
   * `start`, the work, and `finish` in one. `refused` makes the result for an id that is not
   * usable or is already running.
   */
  run<T>(
    requestId: unknown,
    work: (signal: AbortSignal) => Promise<T>,
    refused: (reason: "invalid-id" | "already-running") => T,
  ): Promise<T>;
  /** Fires the signal of the call with this id. True if one was running. */
  cancel(requestId: unknown): boolean;
  /** Stops everything, e.g. when the window closes or reloads. Returns how many were running. */
  cancelAll(): number;
  /** How many calls are running. */
  readonly size: number;
}

export function createTaskRegistry(): TaskRegistry {
  const running = new Map<string, AbortController>();

  function start(requestId: unknown): TaskStart {
    if (!isRequestId(requestId)) return { ok: false, reason: "invalid-id" };
    if (running.has(requestId)) return { ok: false, reason: "already-running" };
    const controller = new AbortController();
    running.set(requestId, controller);
    return {
      ok: true,
      signal: controller.signal,
      finish: () => {
        // Only its own entry: the id may have been reused by a later call in the meantime.
        if (running.get(requestId) === controller) running.delete(requestId);
      },
    };
  }

  async function run<T>(
    requestId: unknown,
    work: (signal: AbortSignal) => Promise<T>,
    refused: (reason: "invalid-id" | "already-running") => T,
  ): Promise<T> {
    const task = start(requestId);
    if (!task.ok) return refused(task.reason);
    try {
      return await work(task.signal);
    } finally {
      task.finish();
    }
  }

  function cancel(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const controller = running.get(requestId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  function cancelAll(): number {
    const controllers = [...running.values()];
    for (const controller of controllers) controller.abort();
    return controllers.length;
  }

  return {
    start,
    run,
    cancel,
    cancelAll,
    get size() {
      return running.size;
    },
  };
}

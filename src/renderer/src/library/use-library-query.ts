import { useCallback, useEffect, useState } from "react";
import type { LibraryError } from "@shared/library";

/** The shape every call over the bridge resolves to; `E` carries at least a sentence. */
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * What a screen can be showing for one thing it reads from the library.
 * `refreshing` is true while newer data is on its way and the last good data is still shown.
 */
export type QueryState<T, E = LibraryError> =
  | { status: "loading" }
  | { status: "error"; error: E }
  | { status: "ready"; value: T; refreshing: boolean };

export interface LibraryQuery<T, E = LibraryError> {
  state: QueryState<T, E>;
  /** Reads again. Keeps showing the current data meanwhile; after an error it shows loading. */
  refresh: () => void;
  /** Puts in a value a change already returned, so the screen need not read again. */
  set: (value: T) => void;
}

interface Settled<T, E> {
  load: () => Promise<Result<T, E>>;
  version: number;
  result: Result<T, E>;
}

/**
 * Reads from the library and keeps the answer. `load` must keep its identity while it means the
 * same thing (wrap it in `useCallback`); a new `load` is a new question and starts from loading.
 * Works for any call that resolves to `{ ok, value }` or `{ ok, error }`: the library's and the
 * results'.
 */
export function useLibraryQuery<T, E = LibraryError>(load: () => Promise<Result<T, E>>): LibraryQuery<T, E> {
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<Settled<T, E> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (!cancelled) setSettled({ load, version, result });
    });
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  const set = useCallback(
    (value: T) => setSettled({ load, version, result: { ok: true, value } }),
    [load, version],
  );

  return { state: stateOf(settled, load, version), refresh, set };
}

function stateOf<T, E>(
  settled: Settled<T, E> | null,
  load: () => Promise<Result<T, E>>,
  version: number,
): QueryState<T, E> {
  if (!settled || settled.load !== load) return { status: "loading" };
  const stale = settled.version !== version;
  if (settled.result.ok) return { status: "ready", value: settled.result.value, refreshing: stale };
  return stale ? { status: "loading" } : { status: "error", error: settled.result.error };
}

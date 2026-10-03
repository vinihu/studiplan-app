import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderDetection, ProviderDetectionEntry, ProviderId, ProviderInfo } from "@shared/providers";
import { ai } from "../ai/api";

export interface Providers {
  /** The AIs this version has. `null` while loading, `"failed"` when they could not be read. */
  list: ProviderInfo[] | null | "failed";
  /** What the last check found for one AI. `null` until the first check has answered. */
  detectionOf: (id: ProviderId) => ProviderDetection | null;
  checking: boolean;
  /** The check itself could not be run. */
  failed: boolean;
  /** Looks again at what is installed and signed in. Costs no request to any AI. */
  checkAgain: () => void;
  /** Goes up with every finished check: lists that depend on what is installed read again. */
  revision: number;
}

interface Detected {
  entries: ProviderDetectionEntry[] | null;
  checking: boolean;
  failed: boolean;
  revision: number;
}

/** The AIs and what was detected about each. Used by Settings and by the first-run screen. */
export function useProviders(): Providers {
  const [list, setList] = useState<Providers["list"]>(null);
  const [detected, setDetected] = useState<Detected>({ entries: null, checking: true, failed: false, revision: 0 });
  const alive = useRef(true);

  const detect = useCallback(async () => {
    const entries = await ai.detectAll();
    if (!alive.current) return;
    setDetected((current) => ({
      entries: entries ?? current.entries,
      checking: false,
      failed: entries === null,
      revision: current.revision + 1,
    }));
  }, []);

  useEffect(() => {
    alive.current = true;
    void ai.list().then((providers) => {
      if (alive.current) setList(providers ?? "failed");
    });
    void detect();
    return () => {
      alive.current = false;
    };
  }, [detect]);

  const checkAgain = useCallback(() => {
    setDetected((current) => ({ ...current, checking: true, failed: false }));
    void detect();
  }, [detect]);

  const entries = detected.entries;
  const detectionOf = useCallback(
    (id: ProviderId) => entries?.find((entry) => entry.id === id)?.detection ?? null,
    [entries],
  );

  return { list, detectionOf, checking: detected.checking, failed: detected.failed, checkAgain, revision: detected.revision };
}

/** The first AI that is ready, in display order, or `null`. */
export function firstReady(providers: Providers): ProviderId | null {
  if (!Array.isArray(providers.list)) return null;
  return providers.list.find((provider) => providers.detectionOf(provider.id)?.status === "ready")?.id ?? null;
}

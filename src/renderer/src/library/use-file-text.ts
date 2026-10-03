import { useCallback, useEffect, useRef, useState } from "react";
import type { MaterialRef } from "@shared/library";
import type { FileText, FileTextError, FileTextResult } from "@shared/preview";
import { newRequestId } from "@shared/tasks";
import { cancelTask, onTaskProgress } from "../ai/api";
import { library } from "./api";

export type FileTextState =
  /** `message` is what the main process says it is doing, when it says anything. */
  | { status: "reading"; message: string | null; fraction: number | null }
  | { status: "ready"; value: FileText }
  /** The student pressed Stop. Not a failure. */
  | { status: "stopped" }
  | { status: "error"; error: FileTextError };

interface Settled {
  key: string;
  result: FileTextResult;
}

interface Progress {
  key: string;
  message: string;
  fraction: number | null;
}

/**
 * Reads the text of one PDF or .pptx of a material. Reading can take seconds, so it can be
 * stopped: with `stop`, or by leaving the screen (the request is cancelled in the main process
 * either way, not just ignored).
 */
export function useFileText(
  ref: MaterialRef,
  name: string,
): { state: FileTextState; stop: () => void; retry: () => void } {
  const { subject, material } = ref;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const running = useRef<string | null>(null);
  const key = `${subject}/${material}/${name}/${attempt}`;

  useEffect(() => {
    let left = false;
    const requestId = newRequestId();
    running.current = requestId;
    const unsubscribe = onTaskProgress(requestId, (report) => {
      if (!left) setProgress({ key, message: report.message, fraction: report.fraction });
    });
    void library.extractText({ subject, material }, name, requestId).then((result) => {
      unsubscribe();
      if (running.current === requestId) running.current = null;
      if (!left) setSettled({ key, result });
    });
    return () => {
      left = true;
      unsubscribe();
      if (running.current === requestId) running.current = null;
      cancelTask(requestId);
    };
  }, [subject, material, name, key]);

  const stop = useCallback(() => {
    if (running.current !== null) cancelTask(running.current);
  }, []);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return { state: stateOf(settled, progress, key), stop, retry };
}

function stateOf(settled: Settled | null, progress: Progress | null, key: string): FileTextState {
  if (!settled || settled.key !== key) {
    const current = progress?.key === key ? progress : null;
    return { status: "reading", message: current?.message ?? null, fraction: current?.fraction ?? null };
  }
  if (settled.result.ok) return { status: "ready", value: settled.result.value };
  if (settled.result.error.code === "cancelled") return { status: "stopped" };
  return { status: "error", error: settled.result.error };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MaterialRef } from "@shared/library";
import type { GenerateOutcome, GenerateRequest, StudyResult } from "@shared/results";
import type { StudySetKind } from "@shared/study";
import { newRequestId } from "@shared/tasks";
import { cancelTask, onTaskProgress } from "../ai/api";
import { study } from "./api";

/** The one result that is being made right now, anywhere in the app. */
export interface RunningGeneration {
  requestId: string;
  ref: MaterialRef;
  /** The material's title, when this window started it. Otherwise its folder name. */
  title: string;
  kind: StudySetKind;
  /** The last progress sentence from the main process, or `null` before the first. */
  message: string | null;
}

/** How the last generation ended, until the student puts the message away. */
export interface FinishedGeneration {
  ref: MaterialRef;
  /** The material's title, for a message shown somewhere else than in the material. */
  title: string;
  kind: StudySetKind;
  result: StudyResult<GenerateOutcome>;
}

export interface Generation {
  running: RunningGeneration | null;
  finished: FinishedGeneration | null;
  /** Starts making a result. Does nothing while another is running. */
  start: (ref: MaterialRef, title: string, request: Omit<GenerateRequest, "requestId">) => void;
  /** Stops the running one. It then ends as "cancelled", which is not a failure. */
  cancel: () => void;
  /**
   * Stops the running one because what it is made from is about to be deleted, and waits until
   * it has stopped. No outcome is kept: the delete itself is what the student sees.
   */
  stopQuietly: () => Promise<void>;
  /** Puts the message about the last one away. */
  dismiss: () => void;
  /** Calls `listener` whenever a generation ends, however it ends. Returns the way to stop. */
  onEnd: (listener: (ref: MaterialRef) => void) => () => void;
}

const sameRef = (a: MaterialRef, b: MaterialRef) => a.subject === b.subject && a.material === b.material;

export function isFor(ref: MaterialRef, other: { ref: MaterialRef } | null): boolean {
  return other !== null && sameRef(ref, other.ref);
}

/**
 * Making results, held by the app's frame rather than by a screen: a generation takes seconds
 * to minutes, and the student may look at Settings or another material meanwhile. Whatever
 * screen is showing can say what is being made, offer Cancel, and show how it ended.
 */
export function useGeneration(): Generation {
  const [running, setRunning] = useState<RunningGeneration | null>(null);
  const [finished, setFinished] = useState<FinishedGeneration | null>(null);
  const current = useRef<string | null>(null);
  const listeners = useRef(new Set<(ref: MaterialRef) => void>());
  /** The request whose end is not to be shown: it was stopped by a delete. */
  const quiet = useRef<string | null>(null);

  const ended = useCallback((ref: MaterialRef) => {
    for (const listener of listeners.current) listener(ref);
  }, []);

  // A generation that was already running when this window (re)loaded: show it, and notice its end.
  useEffect(() => {
    let left = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    void study.current().then((activity) => {
      if (left || activity === null || current.current !== null) return;
      const { requestId, ref, kind } = activity;
      current.current = requestId;
      setRunning({ requestId, ref, title: ref.material, kind, message: activity.message });
      unsubscribe = onTaskProgress(requestId, (progress) => {
        setRunning((now) => (now?.requestId === requestId ? { ...now, message: progress.message } : now));
      });
      // Its answer went to the page that started it; all this one can do is see it stop.
      const watch = async () => {
        const now = await study.current();
        if (left) return;
        if (now?.requestId === requestId) {
          timer = setTimeout(() => void watch(), 1000);
          return;
        }
        unsubscribe();
        if (current.current === requestId) current.current = null;
        setRunning((was) => (was?.requestId === requestId ? null : was));
        ended(ref);
      };
      timer = setTimeout(() => void watch(), 1000);
    });
    return () => {
      left = true;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [ended]);

  const start = useCallback<Generation["start"]>(
    (ref, title, request) => {
      if (current.current !== null) return;
      const requestId = newRequestId();
      current.current = requestId;
      setFinished(null);
      setRunning({ requestId, ref, title, kind: request.kind, message: null });
      const unsubscribe = onTaskProgress(requestId, (progress) => {
        setRunning((now) => (now?.requestId === requestId ? { ...now, message: progress.message } : now));
      });
      void study.generate(ref, { ...request, requestId }).then((result) => {
        unsubscribe();
        if (current.current === requestId) current.current = null;
        setRunning((now) => (now?.requestId === requestId ? null : now));
        if (quiet.current === requestId) quiet.current = null;
        else setFinished({ ref, title, kind: request.kind, result });
        ended(ref);
      });
    },
    [ended],
  );

  const cancel = useCallback(() => {
    if (current.current !== null) cancelTask(current.current);
  }, []);

  const stopQuietly = useCallback(async () => {
    const requestId = current.current;
    if (requestId === null) return;
    quiet.current = requestId;
    cancelTask(requestId);
    // The main process stops within moments; never wait on it for long.
    for (let tries = 0; tries < 40 && current.current === requestId; tries++) {
      await new Promise((done) => setTimeout(done, 50));
    }
  }, []);

  const dismiss = useCallback(() => setFinished(null), []);

  const onEnd = useCallback<Generation["onEnd"]>((listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return useMemo(
    () => ({ running, finished, start, cancel, stopQuietly, dismiss, onEnd }),
    [running, finished, start, cancel, stopQuietly, dismiss, onEnd],
  );
}

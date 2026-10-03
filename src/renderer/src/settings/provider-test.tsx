import { Label, ProgressBar } from "@heroui/react";
import { Check, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiKeyVendor, ProviderId, ProviderTestReply } from "@shared/providers";
import { newRequestId } from "@shared/tasks";
import { ai, cancelTask, onTaskProgress } from "../ai/api";
import { formatDuration } from "../lib/file-text";

export type TestState =
  | { status: "idle" }
  | { status: "running"; requestId: string; message: string | null }
  | { status: "done"; reply: ProviderTestReply }
  /** The student pressed Cancel. Not a failure. */
  | { status: "stopped" }
  | { status: "failed"; message: string };

/**
 * The Test button's work: one tiny real request, with progress, Cancel and the answer. Leaving
 * the screen stops a test that is still running, so no request is left behind.
 */
export function useProviderTest(id: ProviderId, vendor?: ApiKeyVendor) {
  const [state, setState] = useState<TestState>({ status: "idle" });
  const running = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (running.current !== null) cancelTask(running.current);
    },
    [],
  );

  const run = useCallback(async () => {
    if (running.current !== null) return;
    const requestId = newRequestId();
    running.current = requestId;
    setState({ status: "running", requestId, message: null });
    const unsubscribe = onTaskProgress(requestId, (progress) => {
      setState((current) =>
        current.status === "running" && current.requestId === requestId
          ? { ...current, message: progress.message }
          : current,
      );
    });
    const result = await ai.test(id, vendor === undefined ? { requestId } : { requestId, vendor });
    unsubscribe();
    if (running.current !== requestId) return;
    running.current = null;
    if (result.ok) setState({ status: "done", reply: result.value });
    else if (result.error.code === "cancelled") setState({ status: "stopped" });
    else setState({ status: "failed", message: result.error.message });
  }, [id, vendor]);

  const cancel = useCallback(() => {
    if (running.current !== null) cancelTask(running.current);
  }, []);

  /** Forgets the last answer: it was about another model or another key. */
  const reset = useCallback(() => {
    setState((current) => (current.status === "running" ? current : { status: "idle" }));
  }, []);

  return { state, run, cancel, reset };
}

/** What a test is doing or said, under the field row it belongs to. */
export function TestResult({ state, name }: { state: TestState; name: string }) {
  return (
    <div aria-live="polite" data-testid="test-result">
      {state.status === "running" ? (
        <ProgressBar isIndeterminate size="sm" className="mt-4 max-w-md">
          <Label className="truncate">{state.message ?? `Asking ${name}…`}</Label>
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : null}

      {state.status === "done" ? (
        <div className="mt-4 flex max-w-xl gap-2.5 text-sm leading-relaxed">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">It works. {name} answered:</p>
            <p className="mt-0.5 break-words whitespace-pre-wrap">“{state.reply.reply}”</p>
            <p className="mt-1 text-muted tabular-nums">
              {formatDuration(state.reply.durationMs)}
              {" · "}
              {state.reply.model === null ? "its own default model" : `model ${state.reply.model}`}
            </p>
          </div>
        </div>
      ) : null}

      {state.status === "stopped" ? (
        <p className="mt-4 text-sm text-muted">Test cancelled. Nothing was changed.</p>
      ) : null}

      {state.status === "failed" ? (
        <div className="mt-4 flex max-w-xl gap-2.5 text-sm leading-relaxed" role="alert">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="font-medium">The test did not work</p>
            <p className="mt-0.5 break-words text-muted">{state.message}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Text extraction somewhere it can be stopped.
 *
 * Reading a PDF or a deck is a long piece of computing on a file from someone else. Done in
 * the main process it holds everything up while it runs: the window stops answering, the
 * time cap cannot fire and Cancel cannot arrive, because all three wait for the same thread. A
 * small file built for it can keep that up for minutes or hours.
 *
 * So each file is read in a worker of its own (`worker.ts`, started by `worker-host.ts`), and
 * this module decides when to end it: when the result is there, when the caller gives up, or
 * when the time is over. Ending a worker stops it whatever it is doing. The functions here have
 * the shapes of `extractText` and `countPdfPages` and never throw either.
 *
 * No Electron and no worker import: how a job is started is passed in, so this runs in tests.
 */
import { MAX_EXTRACT_MS } from "./limits";
import { TIMEOUT_SENTENCE } from "./shared";
import type { ExtractInput, ExtractOptions, ExtractResult, TextFileKind } from "./types";

/** What a worker is asked to do. Plain data: it crosses to the worker as it is. */
export type ExtractJob =
  | { type: "text"; kind: TextFileKind; input: ExtractInput; timeoutMs: number }
  | { type: "count"; input: ExtractInput; timeoutMs: number };

/** What a worker answers: the value of `extractText` or `countPdfPages`. */
export type ExtractAnswer = { type: "text"; result: ExtractResult } | { type: "count"; result: number | null };

/** One job that is running. `answer` rejects when the worker ends without one. */
export interface RunningJob {
  answer: Promise<ExtractAnswer>;
  /** Ends the worker now, whatever it is doing. */
  terminate(): void;
}

export interface IsolatedExtractorDeps {
  start: (job: ExtractJob) => RunningJob;
  /** How many files are read at the same time; the rest wait their turn. */
  maxConcurrent?: number;
  /**
   * How long after its own time limit a worker is ended. The worker stops by itself at the
   * limit and returns what it has read so far; this is for one that cannot.
   */
  graceMs?: number;
}

export interface IsolatedExtractor {
  extractText(kind: TextFileKind, input: ExtractInput, options?: ExtractOptions): Promise<ExtractResult>;
  countPdfPages(input: ExtractInput, options?: ExtractOptions): Promise<number | null>;
  /** Jobs running and waiting right now. For tests. */
  readonly pending: number;
}

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_GRACE_MS = 5_000;

type Outcome = { how: "answer"; answer: ExtractAnswer } | { how: "timeout" } | { how: "cancelled" } | { how: "crashed" };

export function createIsolatedExtractor(deps: IsolatedExtractorDeps): IsolatedExtractor {
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const graceMs = Math.max(0, deps.graceMs ?? DEFAULT_GRACE_MS);
  let running = 0;
  const waiting: Array<() => void> = [];

  /** Resolves to true when it is this job's turn, or to false when the caller gave up waiting. */
  function turn(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (running < maxConcurrent) {
      running += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const go = (): void => {
        signal?.removeEventListener("abort", giveUp);
        running += 1;
        resolve(true);
      };
      const giveUp = (): void => {
        const at = waiting.indexOf(go);
        if (at !== -1) waiting.splice(at, 1);
        resolve(false);
      };
      waiting.push(go);
      signal?.addEventListener("abort", giveUp, { once: true });
    });
  }

  function done(): void {
    running -= 1;
    waiting.shift()?.();
  }

  async function run(job: ExtractJob, signal: AbortSignal | undefined): Promise<Outcome> {
    if (!(await turn(signal))) return { how: "cancelled" };
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let started: RunningJob | undefined;
    try {
      started = deps.start(job);
      const outcome = await Promise.race<Outcome>([
        started.answer.then(
          (answer): Outcome => (answer?.type === job.type ? { how: "answer", answer } : { how: "crashed" }),
          (): Outcome => ({ how: "crashed" }),
        ),
        new Promise<Outcome>((resolve) => {
          timer = setTimeout(() => resolve({ how: "timeout" }), job.timeoutMs + graceMs);
        }),
        new Promise<Outcome>((resolve) => {
          if (!signal) return;
          onAbort = () => resolve({ how: "cancelled" });
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return outcome;
    } catch {
      // Starting the worker failed.
      return { how: "crashed" };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      // Always: a worker that answered has nothing left to do, one that did not must stop.
      try {
        started?.terminate();
      } catch {
        // Already gone.
      }
      done();
    }
  }

  const budget = (options: ExtractOptions): number => {
    const requested = options.timeoutMs;
    return typeof requested === "number" && requested >= 0 ? Math.min(requested, MAX_EXTRACT_MS) : MAX_EXTRACT_MS;
  };

  return {
    async extractText(kind, input, options = {}) {
      const outcome = await run({ type: "text", kind, input, timeoutMs: budget(options) }, options.signal);
      switch (outcome.how) {
        case "answer":
          return (outcome.answer as Extract<ExtractAnswer, { type: "text" }>).result;
        case "cancelled":
          return { ok: false, error: { code: "cancelled", message: "Reading this file was cancelled." } };
        case "timeout":
          return { ok: false, error: { code: "timeout", message: TIMEOUT_SENTENCE } };
        default:
          return {
            ok: false,
            error: { code: "corrupt", message: "This file could not be read. It may be damaged or unusually complex." },
          };
      }
    },
    async countPdfPages(input, options = {}) {
      const outcome = await run({ type: "count", input, timeoutMs: budget(options) }, options.signal);
      return outcome.how === "answer" ? (outcome.answer as Extract<ExtractAnswer, { type: "count" }>).result : null;
    },
    get pending() {
      return running + waiting.length;
    },
  };
}

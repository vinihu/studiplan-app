/**
 * Starts `worker.ts` as a worker thread for one job (see `isolated.ts`).
 *
 * The thread gets a memory limit of its own: a file that makes the reader build something
 * enormous ends that thread, not the app.
 */
import { Worker } from "node:worker_threads";
import type { ExtractAnswer, ExtractJob, RunningJob } from "./isolated";

/** The most memory one file's reading may take, in megabytes. The largest file is 100 MB. */
export const WORKER_MEMORY_MB = 1024;

/** `workerFile` is the built worker script (the bundler says where it is). */
export function startExtractWorker(workerFile: string): (job: ExtractJob) => RunningJob {
  return (job) => {
    const worker = new Worker(workerFile, {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
      // Nothing the worker prints is of use, and a file must not be able to fill the log.
      stdout: true,
      stderr: true,
    });
    const answer = new Promise<ExtractAnswer>((resolve, reject) => {
      worker.once("message", (message: ExtractAnswer) => resolve(message));
      worker.once("error", (error) => reject(error));
      worker.once("exit", (code) => reject(new Error(`the extraction worker ended with code ${code}`)));
    });
    return {
      answer,
      terminate: () => {
        void worker.terminate();
      },
    };
  };
}

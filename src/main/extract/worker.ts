/**
 * The worker one file is read in (see `isolated.ts` for why). It is given one job, does it with
 * the ordinary extraction code, posts the answer and ends. It has no access to Electron and is
 * given nothing but the job.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractText } from "./extract";
import type { ExtractAnswer, ExtractJob } from "./isolated";
import { countPdfPages } from "./pdf";

async function run(job: ExtractJob): Promise<ExtractAnswer> {
  if (job.type === "count") return { type: "count", result: await countPdfPages(job.input, { timeoutMs: job.timeoutMs }) };
  return { type: "text", result: await extractText(job.kind, job.input, { timeoutMs: job.timeoutMs }) };
}

void run(workerData as ExtractJob).then(
  (answer) => parentPort?.postMessage(answer),
  // The extraction functions do not throw; if one does, ending without an answer says so.
  () => process.exit(1),
);

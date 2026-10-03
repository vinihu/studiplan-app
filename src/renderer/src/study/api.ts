/**
 * The `study` calls (making results and keeping them), as the screens use them.
 *
 * Like `library/api.ts`: the one case the contract cannot cover, the call itself failing,
 * becomes an ordinary `{ ok: false }` with a sentence.
 */

import type { StudiplanApi } from "@shared/ipc";
import type { StudyActivity, StudyError } from "@shared/results";

type StudyApi = StudiplanApi["study"];

const UNREACHABLE: StudyError = {
  code: "failed",
  message: "Studiplan could not reach its own background process. Close the app and open it again.",
};

function safe<Method extends Exclude<keyof StudyApi, "current">>(method: Method): StudyApi[Method] {
  const call = async (...args: unknown[]): Promise<unknown> => {
    try {
      const target = window.studiplan.study[method] as (...a: unknown[]) => Promise<unknown>;
      return await target(...args);
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  };
  return call as StudyApi[Method];
}

export const study = {
  generate: safe("generate"),
  list: safe("list"),
  read: safe("read"),
  rename: safe("rename"),
  remove: safe("remove"),
  /** What is being made right now, or `null` (also when the main process cannot be asked). */
  async current(): Promise<StudyActivity | null> {
    try {
      return await window.studiplan.study.current();
    } catch {
      return null;
    }
  },
};

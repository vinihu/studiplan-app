/**
 * The AI provider calls and the task calls, as the screens use them.
 *
 * Like `library/api.ts`, this adds the one case the contract cannot cover: the call itself
 * failing (the bridge is missing or the main process threw). Calls that return a result become
 * an ordinary `{ ok: false }` with a sentence; calls that return a list become an empty one.
 */

import type {
  AiSettings,
  ApiKeyStatus,
  ApiKeyVendor,
  ProviderModel,
  ProviderDetectionEntry,
  ProviderError,
  ProviderId,
  ProviderInfo,
  ProviderResult,
  ProviderTestOptions,
  ProviderTestReply,
} from "@shared/providers";
import type { TaskProgress } from "@shared/tasks";

const UNREACHABLE: ProviderError = {
  code: "failed",
  message: "Studiplan could not reach its own background process. Close the app and open it again.",
};

export const NO_AI_SETTINGS: AiSettings = { defaultProvider: null, models: {} };

async function orFailure<T>(call: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export const ai = {
  /** Every AI this version of the app knows. `null` when the main process could not be asked. */
  async list(): Promise<ProviderInfo[] | null> {
    try {
      return await window.studiplan.providers.list();
    } catch {
      return null;
    }
  },
  async detectAll(): Promise<ProviderDetectionEntry[] | null> {
    try {
      return await window.studiplan.providers.detectAll();
    } catch {
      return null;
    }
  },
  async getSettings(): Promise<AiSettings> {
    try {
      return await window.studiplan.providers.getSettings();
    } catch {
      return NO_AI_SETTINGS;
    }
  },
  setDefault: (id: ProviderId | null) => orFailure(() => window.studiplan.providers.setDefault(id)),
  setModel: (id: ProviderId, model: string | null) =>
    orFailure(() => window.studiplan.providers.setModel(id, model)),
  test: (id: ProviderId, options: ProviderTestOptions): Promise<ProviderResult<ProviderTestReply>> =>
    orFailure(() => window.studiplan.providers.test(id, options)),
  /** The models to offer for one AI right now. Empty when none were found. */
  async listModels(id: ProviderId): Promise<ProviderModel[]> {
    try {
      return await window.studiplan.providers.listModels(id);
    } catch {
      return [];
    }
  },
  /** Which vendors have an API key saved. The keys themselves never come back. */
  async apiKeyStatus(): Promise<ApiKeyStatus> {
    try {
      return await window.studiplan.providers.apiKeyStatus();
    } catch {
      return { saved: [] };
    }
  },
  saveApiKey: (vendor: ApiKeyVendor, key: string) =>
    orFailure(() => window.studiplan.providers.saveApiKey(vendor, key)),
  clearApiKey: (vendor: ApiKeyVendor) => orFailure(() => window.studiplan.providers.clearApiKey(vendor)),
};

/** Stops the running call that was started with this id. Never throws. */
export function cancelTask(requestId: string): void {
  try {
    void window.studiplan.tasks.cancel(requestId).catch(() => {});
  } catch {
    // Nothing to stop.
  }
}

/** Calls `listener` for every progress report of one running call. Returns the way to stop listening. */
export function onTaskProgress(requestId: string, listener: (progress: TaskProgress) => void): () => void {
  try {
    return window.studiplan.events.subscribe("taskProgress", (progress) => {
      if (progress.requestId === requestId) listener(progress);
    });
  } catch {
    return () => {};
  }
}

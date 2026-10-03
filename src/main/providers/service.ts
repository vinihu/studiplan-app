/**
 * What the Settings screen asks of the provider layer (the `providers` namespace of the
 * bridge): which AIs exist, which are installed, which one and which model the user chose, and
 * the Test button.
 *
 * Every argument is checked here: types are erased over IPC, so what arrives is `unknown`.
 * No Electron import, so it runs in tests; `src/main/ipc/providers.ts` supplies the real parts.
 */
import { isApiKeyVendor, isModelId, isProviderId } from "@shared/providers";
import type {
  AiSettings,
  ApiKeyStatus,
  ProviderModel,
  ProviderDetectionEntry,
  ProviderError,
  ProviderId,
  ProviderInfo,
  ProviderResult,
  ProviderTestReply,
} from "@shared/providers";
import type { TaskProgress } from "@shared/tasks";
import type { Settings, SettingsStore } from "../settings";
import type { TaskRegistry } from "../tasks";
import { API_KEY_MODELS } from "./api-key";
import type { ApiKeyStore } from "./api-key-store";
import { consoleLog, failure, sentenceFor, toProviderResult, type ProviderLog } from "./errors";
import type { Provider } from "./provider";
import { testProvider, type ProviderRegistry } from "./registry";

/** How long the Test button waits. A real answer takes a few seconds; a cold start, longer. */
export const TEST_TIMEOUT_MS = 2 * 60 * 1000;

const BAD_REQUEST: ProviderError = { code: "invalid-request", message: sentenceFor("invalid-request", "") };

const BAD_MODEL =
  "That is not a usable model name. Use letters, numbers and . _ : / - only, without spaces.";

export interface ProviderServiceDeps {
  registry: ProviderRegistry;
  settings: SettingsStore;
  tasks: TaskRegistry;
  /** Where API keys are kept. Left out, keys cannot be saved (and nothing claims they are). */
  apiKeys?: ApiKeyStore;
  /** Sends a progress event to the window. */
  progress?: (progress: TaskProgress) => void;
  testTimeoutMs?: number;
  log?: ProviderLog;
}

export interface ProviderService {
  list(): ProviderInfo[];
  detectAll(): Promise<ProviderDetectionEntry[]>;
  getSettings(): Promise<AiSettings>;
  setDefault(id: unknown): Promise<ProviderResult<AiSettings>>;
  setModel(id: unknown, model: unknown): Promise<ProviderResult<AiSettings>>;
  test(id: unknown, options: unknown): Promise<ProviderResult<ProviderTestReply>>;
  listModels(id: unknown): Promise<ProviderModel[]>;
  apiKeyStatus(): Promise<ApiKeyStatus>;
  saveApiKey(vendor: unknown, key: unknown): Promise<ProviderResult<ApiKeyStatus>>;
  clearApiKey(vendor: unknown): Promise<ProviderResult<ApiKeyStatus>>;
}

export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const { registry, settings, tasks } = deps;
  const log = deps.log ?? consoleLog;
  const progress = deps.progress ?? (() => {});
  const testTimeoutMs = deps.testTimeoutMs ?? TEST_TIMEOUT_MS;

  /**
   * The stored choice as the renderer sees it. A provider this version does not have (the file
   * came from a newer one, or was edited by hand) is left out here, and left alone on disk.
   */
  function view(stored: Settings): AiSettings {
    const models: AiSettings["models"] = {};
    for (const provider of registry.list()) {
      const model = stored.models?.[provider.id];
      if (model !== undefined) models[provider.id] = model;
    }
    const chosen = stored.defaultProvider;
    return {
      defaultProvider: chosen !== undefined && registry.get(chosen) !== undefined ? chosen : null,
      models,
    };
  }

  /** Throws the sentence for an id that is not a provider of this version. */
  function known(id: unknown): ProviderId {
    if (!isProviderId(id)) throw failure("invalid-request", "");
    registry.require(id);
    return id;
  }

  async function setDefault(id: unknown): Promise<AiSettings> {
    const chosen = id === null ? undefined : known(id);
    return view(await settings.update({ defaultProvider: chosen }));
  }

  async function setModel(id: unknown, model: unknown): Promise<AiSettings> {
    const provider = known(id);
    let next: string | undefined;
    if (model === null) next = undefined;
    else if (typeof model !== "string") throw failure("invalid-request", "");
    else {
      next = model.trim();
      if (!isModelId(next)) throw failure("model-unavailable", "", BAD_MODEL);
    }
    return view(
      await settings.change((current) => {
        const models = { ...current.models };
        if (next === undefined) delete models[provider];
        else models[provider] = next;
        return { ...current, models };
      }),
    );
  }

  /** The AIs with a test running right now. */
  const testing = new Set<ProviderId>();

  async function test(id: unknown, options: unknown): Promise<ProviderResult<ProviderTestReply>> {
    if (typeof options !== "object" || options === null) return { ok: false, error: BAD_REQUEST };
    const { requestId, model: asked, vendor } = options as Record<string, unknown>;

    // Registered before the first `await`, so a cancel sent right behind this call finds it.
    return tasks.run<ProviderResult<ProviderTestReply>>(
      requestId,
      (signal) =>
        toProviderResult(async () => {
          const provider = registry.require(known(id));
          // One test per AI at a time: each one starts a program or a paid request.
          if (testing.has(provider.id)) {
            throw failure("busy", provider.label, `${provider.label} is being tested already. Wait until that is finished.`);
          }
          testing.add(provider.id);
          try {
            return await runTest(provider, signal, requestId as string, asked, vendor);
          } finally {
            testing.delete(provider.id);
          }
        }, log),
      () => ({ ok: false, error: BAD_REQUEST }),
    );
  }

  async function runTest(
    provider: Provider,
    signal: AbortSignal,
    requestId: string,
    asked: unknown,
    vendor: unknown,
  ): Promise<ProviderTestReply> {
    let model: string | undefined;
    if (vendor !== undefined && vendor !== null && !isApiKeyVendor(vendor)) {
      throw failure("invalid-request", provider.label);
    }
    if ((asked === undefined || asked === null) && isApiKeyVendor(vendor) && provider.id === "api-key") {
      // The Test button next to one vendor's key: that vendor's recommended model.
      model = API_KEY_MODELS[vendor][0]?.id;
    } else if (asked === undefined || asked === null) model = (await settings.read()).models?.[provider.id];
    else if (typeof asked !== "string") throw failure("invalid-request", provider.label);
    else {
      model = asked.trim();
      if (!isModelId(model)) throw failure("model-unavailable", provider.label, BAD_MODEL);
    }

    // The user's cancel and the time limit both stop the request; which one it was
    // decides the sentence.
    const controller = new AbortController();
    let timedOut = false;
    const stop = (): void => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, testTimeoutMs);

    const started = Date.now();
    progress({ requestId, message: `Asking ${provider.label}…`, fraction: null });
    try {
      const reply = await testProvider(provider, {
        signal: controller.signal,
        ...(model === undefined ? {} : { model }),
      });
      return { reply, model: model ?? null, durationMs: Date.now() - started };
    } catch (error) {
      if (timedOut && !signal.aborted) throw failure("timed-out", provider.label);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  async function listModels(id: unknown): Promise<ProviderModel[]> {
    const provider = isProviderId(id) ? registry.get(id) : undefined;
    if (provider === undefined) return [];
    if (provider.listModels === undefined) return [...provider.suggestedModels];
    try {
      return await provider.listModels();
    } catch {
      return [];
    }
  }

  const NO_KEY_STORE = "API keys cannot be saved in this version of Studiplan.";

  async function apiKeyStatus(): Promise<ApiKeyStatus> {
    try {
      return { saved: (await deps.apiKeys?.saved()) ?? [] };
    } catch {
      return { saved: [] };
    }
  }

  /** The key is handed to the store and to nothing else: it is not logged and not returned. */
  async function saveApiKey(vendor: unknown, key: unknown): Promise<ApiKeyStatus> {
    if (!isApiKeyVendor(vendor)) throw failure("invalid-request", "");
    if (deps.apiKeys === undefined) throw failure("failed", "", NO_KEY_STORE);
    await deps.apiKeys.set(vendor, key);
    return apiKeyStatus();
  }

  async function clearApiKey(vendor: unknown): Promise<ApiKeyStatus> {
    if (!isApiKeyVendor(vendor)) throw failure("invalid-request", "");
    if (deps.apiKeys === undefined) throw failure("failed", "", NO_KEY_STORE);
    await deps.apiKeys.clear(vendor);
    return apiKeyStatus();
  }

  return {
    listModels,
    apiKeyStatus,
    saveApiKey: (vendor, key) => toProviderResult(() => saveApiKey(vendor, key), log),
    clearApiKey: (vendor) => toProviderResult(() => clearApiKey(vendor), log),
    list: () => registry.info(),
    detectAll: () => registry.detectAll(),
    getSettings: async () => view(await settings.read()),
    setDefault: (id) => toProviderResult(() => setDefault(id), log),
    setModel: (id, model) => toProviderResult(() => setModel(id, model), log),
    test,
  };
}

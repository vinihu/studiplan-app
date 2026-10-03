import type { IpcHandlers } from "@shared/ipc";
import { createProviderService } from "../providers/service";
import type { ProviderService } from "../providers/service";
import { getContext } from "./context";
import { emit } from "./events";

/**
 * The `providers` namespace of the bridge: what the Settings screen needs. The work, and the
 * checking of every argument, is in `src/main/providers/service.ts`.
 */
let service: ProviderService | null = null;

function getService(): ProviderService {
  if (service) return service;
  const { providers, settings, tasks, apiKeys } = getContext();
  service = createProviderService({
    registry: providers,
    settings,
    tasks,
    apiKeys,
    progress: (progress) => emit("taskProgress", progress),
  });
  return service;
}

export const providerHandlers: IpcHandlers["providers"] = {
  list: () => getService().list(),
  detectAll: () => getService().detectAll(),
  getSettings: () => getService().getSettings(),
  setDefault: (id) => getService().setDefault(id),
  setModel: (id, model) => getService().setModel(id, model),
  test: (id, options) => getService().test(id, options),
  listModels: (id) => getService().listModels(id),
  apiKeyStatus: () => getService().apiKeyStatus(),
  saveApiKey: (vendor, key) => getService().saveApiKey(vendor, key),
  clearApiKey: (vendor) => getService().clearApiKey(vendor),
};

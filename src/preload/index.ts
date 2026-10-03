import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BRIDGE_KEY, channelName, eventChannelName, isEventName, listChannels } from "@shared/ipc";
import type { LocalApi, StudiplanApi } from "@shared/ipc";

/**
 * What runs here in the page's process instead of going over IPC.
 *
 * A sandboxed page gets no path from a dropped `File`; `webUtils.getPathForFile` is the one
 * supported way to ask for it, and it only works synchronously, on the real `File` object.
 */
const localApi: LocalApi = {
  files: {
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Not a File at all. The page gets "no path" rather than an exception from Electron.
        return "";
      }
    },
  },
  events: {
    // The page never gets `ipcRenderer.on`: it can listen to the events of the contract and to
    // nothing else, it receives the payload without the IPC event object, and all it can do
    // with a subscription is end it.
    subscribe: (event, listener) => {
      if (!isEventName(event) || typeof listener !== "function") {
        throw new TypeError("Unknown event.");
      }
      const channel = eventChannelName(event);
      const forward = (_event: unknown, payload: unknown): void => {
        (listener as (payload: unknown) => void)(payload);
      };
      ipcRenderer.on(channel, forward);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(channel, forward);
      };
    },
  },
};

/**
 * Builds `window.studiplan` from the shared contract: one function per call, each of which
 * can only invoke its own channel. `ipcRenderer` itself is never exposed to the page.
 */
function buildApi(): StudiplanApi {
  const api: Record<string, Record<string, (...args: never[]) => unknown>> = {};

  for (const [namespace, method] of listChannels()) {
    const channel = channelName(namespace, method);
    (api[namespace] ??= {})[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  }

  for (const [namespace, methods] of Object.entries(localApi)) {
    if (namespace in api) throw new Error(`"${namespace}" is already a namespace of the contract.`);
    api[namespace] = methods;
  }

  return api as unknown as StudiplanApi;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, buildApi());

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { channelName, listChannels } from "@shared/ipc";
import type { IpcHandlers } from "@shared/ipc";

type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Registers one `ipcMain.handle` per entry of the shared contract.
 *
 * `handlers` is checked by TypeScript against the contract, so a call without a handler does
 * not compile. `isTrustedSender` runs before every handler: a message from any frame that is
 * not the app's own page is rejected.
 *
 * Types are erased at runtime. A handler that takes arguments must validate them itself
 * before acting on them; the renderer is not trusted to send what the types promise.
 */
export function registerIpcHandlers(
  handlers: IpcHandlers,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  const table = handlers as unknown as Record<string, Record<string, AnyHandler>>;

  for (const [namespace, method] of listChannels()) {
    const handler = table[namespace]?.[method];
    if (typeof handler !== "function") {
      throw new Error(`No handler registered for ${channelName(namespace, method)}`);
    }

    ipcMain.handle(channelName(namespace, method), (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) {
        throw new Error("Rejected a message from an untrusted page.");
      }
      return handler(...args);
    });
  }
}

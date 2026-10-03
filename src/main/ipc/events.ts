/**
 * Sending events from the main process to the page: the other direction of the bridge.
 *
 * Only the events of `ipcEvents` (`src/shared/ipc.ts`) exist, and only the app's own window
 * receives them. The preload turns them into `window.studiplan.events.subscribe`.
 */
import type { WebContents } from "electron";
import { eventChannelName } from "@shared/ipc";
import type { EventName, EventPayload } from "@shared/ipc";

let target: () => WebContents | null = () => null;

/** Tells `emit` where the app's window is. Called once, from `src/main/index.ts`. */
export function setEventTarget(find: () => WebContents | null): void {
  target = find;
}

/** Sends one event to the app's window. Does nothing when there is no window to send it to. */
export function emit<Name extends EventName>(event: Name, payload: EventPayload<Name>): void {
  const contents = target();
  if (contents === null || contents.isDestroyed()) return;
  // To the top-level page only: a frame inside it (a PDF being shown) never gets events.
  contents.mainFrame.send(eventChannelName(event), payload);
}

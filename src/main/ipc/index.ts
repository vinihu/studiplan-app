import type { IpcHandlers } from "@shared/ipc";
import { appHandlers } from "./app";
import { libraryHandlers } from "./library";
import { providerHandlers } from "./providers";
import { studyHandlers } from "./study";
import { taskHandlers } from "./tasks";

/** Every handler of the bridge, one module per namespace. */
export const ipcHandlers: IpcHandlers = {
  app: appHandlers,
  library: libraryHandlers,
  providers: providerHandlers,
  study: studyHandlers,
  tasks: taskHandlers,
};

export { getContext } from "./context";
export { emit, setEventTarget } from "./events";
export { registerIpcHandlers } from "./register";

import type { IpcHandlers } from "@shared/ipc";
import { getContext } from "./context";

/** The `tasks` namespace of the bridge: stopping a running call by the id it was started with. */
export const taskHandlers: IpcHandlers["tasks"] = {
  cancel: (requestId) => getContext().tasks.cancel(requestId),
};

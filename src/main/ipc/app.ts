import { app } from "electron";
import type { IpcHandlers } from "@shared/ipc";
import { BUILD_MARKER } from "../build";

export const appHandlers: IpcHandlers["app"] = {
  getInfo: () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron,
    build: BUILD_MARKER.endsWith(":test") ? "test" : "release",
  }),
};

import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { RootPlaces } from "../library/choose-root";

function folder(name: Parameters<typeof app.getPath>[0]): string[] {
  try {
    return [app.getPath(name)];
  } catch {
    // Not every system has every folder.
    return [];
  }
}

function env(...names: string[]): string[] {
  return names.map((name) => process.env[name]).filter((value): value is string => typeof value === "string" && value !== "");
}

/**
 * The places a library may not be. See `checkLibraryRoot`, which is applied to a folder picked
 * in Settings and to the folder read from the settings file alike.
 */
export function rootPlaces(): RootPlaces {
  return {
    home: os.homedir(),
    personal: (["documents", "desktop", "downloads", "music", "pictures", "videos"] as const).flatMap(folder),
    app: [path.dirname(app.getPath("exe")), ...folder("userData"), ...folder("sessionData")],
    system:
      process.platform === "win32"
        ? env("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData")
        : ["/bin", "/sbin", "/usr", "/etc", "/var", "/System", "/Library", "/Applications", "/opt"],
  };
}

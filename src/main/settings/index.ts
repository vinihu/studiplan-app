/**
 * The app's settings: one small JSON file, `settings.json`, in the app's own data folder.
 *
 * Only plain preferences belong here: where the library is, which AI is the default and which
 * model each one uses. API keys never do — those go through Electron `safeStorage`.
 *
 * No Electron import: the folder is passed in, so this runs in tests.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isModelId, isProviderId } from "@shared/providers";
import type { ProviderId } from "@shared/providers";

export interface Settings {
  /** Absolute path of the library root the user chose. Absent means the default place. */
  libraryRoot?: string;
  /** The AI results are made with. Absent until the user picks one. */
  defaultProvider?: ProviderId;
  /** The model chosen per provider. A provider without an entry uses its own default. */
  models?: Partial<Record<ProviderId, string>>;
}

export interface SettingsStore {
  read(): Promise<Settings>;
  /**
   * Merges `patch` into the stored settings. A key set to `undefined` is removed. `models` is
   * replaced as a whole; use `change` to edit one entry.
   */
  update(patch: { [Key in keyof Settings]?: Settings[Key] | undefined }): Promise<Settings>;
  /**
   * Reads, lets `edit` return the new settings, and writes them — as one step, so two changes
   * made at the same moment never lose one another.
   */
  change(edit: (current: Settings) => Settings): Promise<Settings>;
}

const FILE_NAME = "settings.json";

/**
 * Keeps only what is known and well-formed; a hand-edited or damaged file never breaks the app.
 * Anything else — an unknown key, a provider the app has never heard of, a model name with
 * characters a model name cannot have — is ignored, not repaired.
 */
export function parseSettings(text: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const settings: Settings = {};

  const root = record["libraryRoot"];
  if (typeof root === "string" && root.length <= 1024 && !root.includes("\0") && path.isAbsolute(root)) {
    settings.libraryRoot = root;
  }

  const provider = record["defaultProvider"];
  if (isProviderId(provider)) settings.defaultProvider = provider;

  const models = record["models"];
  if (typeof models === "object" && models !== null && !Array.isArray(models)) {
    const kept: Partial<Record<ProviderId, string>> = {};
    for (const [id, model] of Object.entries(models)) {
      if (isProviderId(id) && isModelId(model)) kept[id] = model;
    }
    if (Object.keys(kept).length > 0) settings.models = kept;
  }

  return settings;
}

export function createSettingsStore(directory: string): SettingsStore {
  const file = path.join(directory, FILE_NAME);

  async function read(): Promise<Settings> {
    try {
      return parseSettings(await readFile(file, "utf8"));
    } catch {
      return {};
    }
  }

  async function write(settings: Settings): Promise<Settings> {
    // Through the same filter as a read, so nothing malformed is ever written.
    const next = parseSettings(JSON.stringify(settings));

    await mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return next;
  }

  // One change at a time: each reads what the one before it wrote.
  let queue: Promise<unknown> = Promise.resolve();
  function change(edit: (current: Settings) => Settings): Promise<Settings> {
    const result = queue.then(async () => write(edit(await read())));
    queue = result.catch(() => {});
    return result;
  }

  function update(patch: Parameters<SettingsStore["update"]>[0]): Promise<Settings> {
    return change((current) => {
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      return merged as Settings;
    });
  }

  return { read, update, change };
}

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLibraryRoot } from "../library/root";
import { createSettingsStore, parseSettings } from "./index";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "studiplan-settings-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("settings store", () => {
  it("is empty before anything is saved, and when the folder does not exist yet", async () => {
    expect(await createSettingsStore(directory).read()).toEqual({});
    expect(await createSettingsStore(path.join(directory, "not", "yet")).read()).toEqual({});
  });

  it("saves and reads back the library root, creating the folder", async () => {
    const nested = path.join(directory, "profile");
    const store = createSettingsStore(nested);
    const chosen = path.join(directory, "My library");
    expect(await store.update({ libraryRoot: chosen })).toEqual({ libraryRoot: chosen });
    expect(await createSettingsStore(nested).read()).toEqual({ libraryRoot: chosen });
    expect(await readdir(nested)).toEqual(["settings.json"]);
    expect(JSON.parse(await readFile(path.join(nested, "settings.json"), "utf8"))).toEqual({ libraryRoot: chosen });
  });

  it("removes a key set to undefined", async () => {
    const store = createSettingsStore(directory);
    await store.update({ libraryRoot: path.join(directory, "x") });
    expect(await store.update({ libraryRoot: undefined })).toEqual({});
    expect(await store.read()).toEqual({});
  });

  it("ignores a damaged file, unknown keys and a root that is not an absolute path", async () => {
    const store = createSettingsStore(directory);
    const file = path.join(directory, "settings.json");
    for (const text of ["{ broken", "", "null", "[]", '{"libraryRoot": 5}', '{"libraryRoot": "relative/path"}', '{"apiKey": "never stored here"}']) {
      await writeFile(file, text);
      expect(await store.read(), text).toEqual({});
    }
    await store.update({});
    expect(await readFile(file, "utf8")).not.toContain("apiKey");
  });
});

describe("the AI choice in the settings", () => {
  it("saves and reads back the default provider and the model per provider", async () => {
    const store = createSettingsStore(directory);
    const saved = await store.update({ defaultProvider: "claude-code", models: { "claude-code": "opus", ollama: "llama3.2:3b" } });
    expect(saved).toEqual({ defaultProvider: "claude-code", models: { "claude-code": "opus", ollama: "llama3.2:3b" } });
    expect(await createSettingsStore(directory).read()).toEqual(saved);
    // The library folder is a separate key and stays as it was.
    const chosen = path.join(directory, "lib");
    expect(await store.update({ libraryRoot: chosen })).toEqual({ ...saved, libraryRoot: chosen });
    expect(await store.update({ defaultProvider: undefined, models: undefined })).toEqual({ libraryRoot: chosen });
  });

  it("ignores unknown providers and unusable model names when reading", () => {
    expect(
      parseSettings(
        JSON.stringify({
          defaultProvider: "gpt-in-the-cloud",
          models: {
            "claude-code": "sonnet",
            codex: "two words",
            ollama: 7,
            "api-key": "--flag",
            unknown: "model",
            __proto__: "x",
          },
        }),
      ),
    ).toEqual({ models: { "claude-code": "sonnet" } });

    for (const models of [null, 5, "sonnet", ["sonnet"], {}]) {
      expect(parseSettings(JSON.stringify({ defaultProvider: 5, models })), JSON.stringify(models)).toEqual({});
    }
    expect(parseSettings(JSON.stringify({ defaultProvider: "ollama" }))).toEqual({ defaultProvider: "ollama" });
    expect(parseSettings(JSON.stringify({ models: { "claude-code": "x".repeat(101) } }))).toEqual({});
    expect(parseSettings("[1, 2]")).toEqual({});
  });

  it("never writes what it would not read", async () => {
    const store = createSettingsStore(directory);
    await store.update({
      defaultProvider: "nope" as never,
      models: { "claude-code": "bad name", ollama: "phi4" },
    });
    expect(JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"))).toEqual({ models: { ollama: "phi4" } });
  });

  it("applies changes made at the same moment one after the other", async () => {
    const store = createSettingsStore(directory);
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((model, index) =>
        store.change((current) => ({ ...current, models: { ...current.models, [(["claude-code", "codex", "ollama", "api-key", "claude-code"] as const)[index]!]: model } })),
      ),
    );
    expect((await store.read()).models).toEqual({ "claude-code": "e", codex: "b", ollama: "c", "api-key": "d" });
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });

  it("carries on after a change that failed", async () => {
    const store = createSettingsStore(directory);
    await expect(
      store.change(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.update({ defaultProvider: "claude-code" })).toEqual({ defaultProvider: "claude-code" });
  });
});

describe("resolveLibraryRoot", () => {
  const documents = path.resolve(tmpdir(), "Documents");
  const fallback = path.join(documents, "Studiplan");

  it("defaults to Documents/Studiplan", () => {
    expect(resolveLibraryRoot({ override: undefined, configured: undefined, documents })).toEqual({ root: fallback, isDefault: true, fixedByEnvironment: false });
  });

  it("uses the folder from Settings, and the environment override before that", () => {
    const configured = path.resolve(tmpdir(), "elsewhere");
    const override = path.resolve(tmpdir(), "throwaway");
    expect(resolveLibraryRoot({ override: undefined, configured, documents })).toEqual({ root: configured, isDefault: false, fixedByEnvironment: false });
    expect(resolveLibraryRoot({ override, configured, documents })).toEqual({ root: override, isDefault: false, fixedByEnvironment: true });
  });

  it("ignores values that are empty or not absolute", () => {
    expect(resolveLibraryRoot({ override: "", configured: "  ", documents }).root).toBe(fallback);
    expect(resolveLibraryRoot({ override: "relative", configured: "also/relative", documents }).root).toBe(fallback);
    // An override that is not used does not lock the folder either.
    expect(resolveLibraryRoot({ override: "relative", configured: undefined, documents }).fixedByEnvironment).toBe(false);
  });

  it("still counts as the default when Settings points at the default place", () => {
    expect(resolveLibraryRoot({ override: undefined, configured: path.join(fallback, "."), documents }).isDefault).toBe(true);
  });
});

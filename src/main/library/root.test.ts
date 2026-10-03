import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLibraryRoot } from "./choose-root";
import type { RootPlaces } from "./choose-root";
import { fail } from "./errors";
import { resolveCheckedLibraryRoot } from "./root";

let sandbox: string;
let documents: string;
let fallback: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "sp-root-"));
  documents = path.join(sandbox, "Documents");
  fallback = path.join(documents, "Studiplan");
  await mkdir(documents);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("resolveCheckedLibraryRoot", () => {
  it("uses a stored folder that passes the check, at its real location", async () => {
    const stored = path.join(sandbox, "stored");
    const real = path.join(sandbox, "real");
    const check = vi.fn(async () => real);
    expect(await resolveCheckedLibraryRoot({ override: undefined, configured: stored, documents, check })).toEqual({
      info: { root: real, isDefault: false, fixedByEnvironment: false },
      refused: null,
    });
    expect(check).toHaveBeenCalledWith(stored);
  });

  it("falls back to the default place, with a sentence, when the stored folder is refused", async () => {
    const stored = path.join(sandbox, "gone");
    const check = async (): Promise<string> => fail("not-found", "That folder could not be opened. Pick a folder that exists.");
    const { info, refused } = await resolveCheckedLibraryRoot({ override: undefined, configured: stored, documents, check });
    expect(refused).toBe(stored);
    expect(info).toMatchObject({ root: fallback, isDefault: true, fixedByEnvironment: false });
    expect(info.notice).toContain(stored);
    expect(info.notice).toContain(fallback);
    expect(info.notice).toContain("That folder could not be opened.");
    expect(info.notice).toMatch(/Nothing was moved or deleted/);
  });

  it("says something plain when the check fails in a way nobody planned for", async () => {
    const check = async (): Promise<string> => {
      throw new Error("EIO: C:\\secret\\path");
    };
    const { info } = await resolveCheckedLibraryRoot({ override: undefined, configured: path.join(sandbox, "x"), documents, check });
    expect(info.root).toBe(fallback);
    expect(info.notice).toContain("That folder cannot be used as a library.");
    expect(info.notice).not.toContain("EIO");
  });

  it("does not check the default place, which need not exist yet, or when nothing is stored", async () => {
    const check = vi.fn(async (folder: string) => folder);
    for (const configured of [undefined, fallback, path.join(fallback, "."), "relative"]) {
      expect(await resolveCheckedLibraryRoot({ override: undefined, configured, documents, check })).toEqual({
        info: { root: fallback, isDefault: true, fixedByEnvironment: false },
        refused: null,
      });
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("does not check the environment override of a development build", async () => {
    const override = path.join(sandbox, "throwaway");
    const check = vi.fn(async (folder: string) => folder);
    expect(await resolveCheckedLibraryRoot({ override, configured: path.join(sandbox, "stored"), documents, check })).toEqual({
      info: { root: override, isDefault: false, fixedByEnvironment: true },
      refused: null,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses, with the real rules, a hand-edited folder that a picker would never accept", async () => {
    const home = path.join(sandbox, "home");
    await mkdir(home);
    const places: RootPlaces = { home, personal: [documents], app: [], system: [] };
    const check = (folder: string): Promise<string> => checkLibraryRoot(folder, places);
    for (const dangerous of [home, documents, path.parse(sandbox).root, path.join(sandbox, "missing")]) {
      const { info, refused } = await resolveCheckedLibraryRoot({ override: undefined, configured: dangerous, documents, check });
      expect(refused, dangerous).toBe(dangerous);
      expect(info.root, dangerous).toBe(fallback);
    }
  });
});

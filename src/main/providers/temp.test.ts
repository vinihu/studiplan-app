import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALE_AFTER_MS, sweepStaleTempFolders } from "./temp";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sp-sweep-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function folder(name: string, ageMs: number): Promise<string> {
  const full = path.join(root, name);
  await mkdir(full);
  await writeFile(path.join(full, "instructions.md"), "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(full, when, when);
  return full;
}

describe("sweepStaleTempFolders", () => {
  it("removes the app's own leftover folders that are older than a day, and nothing else", async () => {
    const oldCodex = await folder("studiplan-codex-aB12cd", STALE_AFTER_MS + 60_000);
    const oldClaude = await folder("studiplan-claude-Zz99", STALE_AFTER_MS + 60_000);
    const fresh = await folder("studiplan-codex-fresh1", 60_000);
    const someoneElses = await folder("other-program-xyz", STALE_AFTER_MS * 3);
    const lookalike = await folder("my-studiplan-codex-notes", STALE_AFTER_MS * 3);
    const file = path.join(root, "studiplan-codex-a-file");
    await writeFile(file, "x");
    await utimes(file, new Date(0), new Date(0));

    expect(await sweepStaleTempFolders(root)).toBe(2);
    expect([oldCodex, oldClaude].map((entry) => existsSync(entry))).toEqual([false, false]);
    expect([fresh, someoneElses, lookalike, file].map((entry) => existsSync(entry))).toEqual([true, true, true, true]);
  });

  it("is quiet when there is nothing to look in", async () => {
    expect(await sweepStaleTempFolders(path.join(root, "missing"))).toBe(0);
  });
});

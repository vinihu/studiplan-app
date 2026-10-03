/**
 * Which kind of build a bundle is: a release build, or one with the development hooks on (a
 * "test build"). The main bundle carries one of two marker strings, written into it when it is
 * built (`electron.vite.config.ts`, `src/main/build.ts`). The packaging hooks and the smoke
 * tests read the marker instead of trusting how they were called, because the two kinds must
 * never be confused:
 *
 *  - a test build must never become an installer or carry the app's name;
 *  - a smoke test must never drive a release build, which would use the real profile and the
 *    real library instead of the throwaway ones.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MARKER = "studiplan-build-kind:";
const RELEASE = Buffer.from(`${MARKER}release`);
const TEST = Buffer.from(`${MARKER}test`);

/** The app's name, and the name of a packed test build (the same two as in `src/main/build.ts`). */
export const RELEASE_NAME = "Studiplan";
export const TEST_NAME = "Studiplan Test";

/** The mode `electron-vite build` is given for a build with the hooks on. */
export const TEST_BUILD_MODE = "test-build";

function kindOf(buffers, where) {
  const release = buffers.some((bytes) => bytes.includes(RELEASE));
  const test = buffers.some((bytes) => bytes.includes(TEST));
  if (release === test) {
    throw new Error(
      release
        ? `${where} says it is both a release build and a test build. Build it again.`
        : `${where} does not say which kind of build it is. Build it again with this version of the code.`,
    );
  }
  return test ? "test" : "release";
}

/** "release" or "test" for the built main bundle in `<projectDir>/out/main`. Throws if it cannot tell. */
export async function bundleKind(projectDir) {
  const folder = path.join(projectDir, "out", "main");
  if (!existsSync(folder)) throw new Error(`There is no build in ${folder}. Run the build first.`);
  const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
  return kindOf(await Promise.all(files.map((file) => readFile(file))), folder);
}

/**
 * "release" or "test" for a packed app, given its executable. An archive stores its files as
 * they are, so the marker can be found in `resources/app.asar` without unpacking it.
 */
export async function packagedKind(executable) {
  const archive = path.join(path.dirname(executable), "resources", "app.asar");
  if (!existsSync(archive)) throw new Error(`There is no app.asar next to ${executable}. Is this a packed Studiplan?`);
  return kindOf([await readFile(archive)], archive);
}

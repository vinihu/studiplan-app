/**
 * electron-builder's `beforePack` hook (see electron-builder.yml): the things that must be true
 * before anything is packed.
 *
 * 1. The licence texts are there. electron-builder skips an `extraFiles` entry whose source does
 *    not exist without a word, so an installer built without `npm run notices` would ship
 *    without the texts it has to carry.
 * 2. The bundle in out/ is the kind this packaging run is for. A build with the development
 *    hooks on (a "test build", see `src/main/build.ts`) is packed only by `npm run dist:test`:
 *    under its own name, as a plain folder, never as an installer. A release is packed only
 *    from a release bundle. `npm run smoke` leaves a test build in out/, so this is what stops
 *    a bare `electron-builder` afterwards from publishing it.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { bundleKind, RELEASE_NAME, TEST_NAME } from "./build-kind.mjs";

const REQUIRED = [
  ["build/THIRD-PARTY-NOTICES.txt", 'Run "npm run notices" first, or use "npm run dist", which does.'],
  ["src/renderer/src/assets/fonts/OFL.txt", "The licence of the bundled Inter font files is missing."],
  ["LICENSE", "The app's own licence is missing."],
];

export default async function beforePack(context) {
  const root = context.packager.projectDir;
  for (const [file, advice] of REQUIRED) {
    const full = path.join(root, file);
    if (!existsSync(full) || statSync(full).size === 0) {
      throw new Error(`${file} is missing or empty, so the installer would lack a licence text. ${advice}`);
    }
  }

  const kind = await bundleKind(root);
  const name = context.packager.appInfo.productName;
  const targets = context.targets.map((target) => target.name);

  if (kind === "test") {
    if (name !== TEST_NAME) {
      throw new Error(
        `out/ holds a test build (development hooks on), and it is about to be packed as "${name}". ` +
          'A release is made with "npm run dist", which builds out/ again without the hooks. ' +
          'A test build is packed with "npm run dist:test".',
      );
    }
    const installers = targets.filter((target) => target !== "dir");
    if (installers.length > 0) {
      throw new Error(
        `A test build is never made into an installer (asked for: ${installers.join(", ")}). ` +
          'Pack it as a folder only: "npm run dist:test".',
      );
    }
  } else if (name !== RELEASE_NAME) {
    throw new Error(
      `out/ holds a release build, and it is about to be packed as "${name}". ` +
        'A test build is made with "npm run dist:test", which builds out/ with the development hooks on.',
    );
  }
}

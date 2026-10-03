/**
 * electron-builder's `afterPack` hook (see electron-builder.yml): sets Electron's fuses in the
 * packed executable. A fuse is a switch inside the .exe itself; once set, no environment
 * variable or command-line argument turns it back. Names and meanings as in Electron's
 * "Fuses" and "ASAR Integrity" documentation for Electron 44 and the README of @electron/fuses.
 *
 * The hook runs after the files are in place (and after electron-builder has written the
 * archive's checksum into the executable) and before the installer is made. Nothing is signed.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { bundleKind } from "./build-kind.mjs";

/**
 * The fuses of the release. Every fuse this Electron has is listed (`strictlyRequireAllFuses`),
 * so an Electron upgrade that brings a new one stops the build until it is decided here.
 */
export const RELEASE_FUSES = {
  // ELECTRON_RUN_AS_NODE would turn the app into a plain Node.js that runs any script with the
  // app's identity. Off. (The app never uses `child_process.fork`, which needs it.)
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS and NODE_EXTRA_CA_CERTS could load code into the main process, or add a
  // certificate authority, from the environment. Off.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect, --inspect-brk and the like open the main process to a debugger. Off.
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // The app's code is looked for in resources/app.asar only, not in an `app` folder next to it.
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // app.asar is checked against the checksum electron-builder wrote into the executable (the
  // "ElectronAsar" resource); an archive that was changed stops the app from starting.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // The cookie store is encrypted with a key kept by the operating system. The app sets no
  // cookies; this costs nothing and cannot be turned off again later without losing them.
  [FuseV1Options.EnableCookieEncryption]: true,
  // LEFT ON, and it has to be: the window's page is loaded from file:// inside app.asar. With
  // the fuse off the packed app cannot open its own page (tried on this build: "Failed to load
  // URL: file:///…/resources/app.asar/out/renderer/index.html with error: ERR_FILE_NOT_FOUND",
  // and an empty window). Turning it off means serving the page from a scheme of the app's own
  // instead of file://, which is a change to how the window loads, not a switch.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  // Left as Electron ships them: there is no separate snapshot file for the main process, and
  // WebAssembly keeps its fast out-of-bounds checks.
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};

/**
 * A test build (`npm run dist:test`) gets the same fuses except the one the smoke test needs:
 * Playwright starts the app with `--inspect` and drives it through that debugger. Everything
 * else is as in the release, so the smoke test runs against the release's settings.
 */
export const TEST_FUSES = {
  ...RELEASE_FUSES,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
};

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    throw new Error("The fuses are set up for the Windows build only. Decide them for this platform before packing it.");
  }
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!existsSync(executable)) throw new Error(`The packed executable was not found: ${executable}`);

  const kind = await bundleKind(context.packager.projectDir);
  const fuses = kind === "release" ? RELEASE_FUSES : TEST_FUSES;
  await flipFuses(executable, { version: FuseVersion.V1, strictlyRequireAllFuses: true, ...fuses });

  // Read them back: the build fails here rather than ship an executable that is not what was asked for.
  const wire = await getCurrentFuseWire(executable);
  for (const [fuse, wanted] of Object.entries(fuses)) {
    const state = String.fromCharCode(wire[fuse]);
    if (state !== (wanted ? "1" : "0")) {
      throw new Error(`The fuse ${FuseV1Options[fuse]} is "${state}" after flipping, not ${wanted ? "on" : "off"}.`);
    }
  }
  console.log(`  • fuses set for a ${kind} build  file=${executable}`);
}

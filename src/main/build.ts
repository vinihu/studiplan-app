/**
 * Which kind of build this is. Decided when the app is built (`electron.vite.config.ts`) and
 * written into this bundle as constants; nothing a running app can be given changes it.
 *
 *  - **Release build** (`electron-vite build`, what `npm run dist` packs and what is published):
 *    `DEV_HOOKS` is `false`. The app loads only its own packaged page, uses its own profile
 *    folder, has no stand-in AI, no menu, no developer tools and no remote debugging, whatever
 *    environment variables or command-line switches it is started with.
 *  - **Build with the hooks on** (`npm run dev`, and `--mode test-build`, which `npm run smoke`
 *    and `npm run dist:test` use): `DEV_HOOKS` is `true`, and the hooks below work.
 *
 * The hooks, all of them, and nothing else is one:
 *
 * | Hook                         | What it does                                              |
 * |------------------------------|-----------------------------------------------------------|
 * | `ELECTRON_RENDERER_URL`      | the window loads this address (the Vite dev server)       |
 * | `STUDIPLAN_USER_DATA_DIR`    | the profile folder (settings, saved keys, window state)   |
 * | `STUDIPLAN_LIBRARY_DIR`      | the library folder, without the checks a chosen one gets  |
 * | `STUDIPLAN_FAKE_AI`          | every AI is replaced by the Test AI                       |
 * | the default menu, dev tools  | only when also not packaged                               |
 * | `--remote-debugging-port` …  | left alone, so Playwright can drive the app               |
 *
 * `app.isPackaged` is deliberately not what decides any of this: Electron derives it from the
 * name of the executable, which anyone can change.
 *
 * In unit tests the constants do not exist; the values then are those of a release build.
 */
declare const __STUDIPLAN_DEV_HOOKS__: boolean | undefined;
declare const __STUDIPLAN_BUILD_MARKER__: string | undefined;

export const DEV_HOOKS: boolean = typeof __STUDIPLAN_DEV_HOOKS__ !== "undefined" && __STUDIPLAN_DEV_HOOKS__ === true;

/**
 * `studiplan-build-kind:release` or `studiplan-build-kind:test`, as text in the bundle. The
 * packaging hooks (`scripts/pack-hooks.mjs`) look for it to know what they are packing.
 */
export const BUILD_MARKER: string =
  typeof __STUDIPLAN_BUILD_MARKER__ !== "undefined" ? __STUDIPLAN_BUILD_MARKER__ : "studiplan-build-kind:release";

/** The name of the app. A packed test build says what it is, and keeps a profile folder of its own. */
export const RELEASE_NAME = "Studiplan";
export const TEST_NAME = "Studiplan Test";

/** A development hook's value from the environment: `undefined` in a release build, always. */
export function hookValue(name: string): string | undefined {
  if (!DEV_HOOKS) return undefined;
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Chromium's switches that open the app to a debugger. The Node ones are closed by a fuse. */
export const DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-allow-origins"] as const;

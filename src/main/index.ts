import { app, BrowserWindow, Menu, protocol, session } from "electron";
import { PREVIEW_SCHEME } from "@shared/preview";
import { DEBUGGING_SWITCHES, DEV_HOOKS, hookValue, RELEASE_NAME, TEST_NAME } from "./build";
import { getContext, ipcHandlers, registerIpcHandlers, setEventTarget } from "./ipc";
import { createPreviewHandler } from "./library/preview";
import os from "node:os";
import { sweepStaleTempFolders } from "./providers/temp";
import { isAppUrl, mayUseNetwork } from "./security";
import { createMainWindow, devServerUrl, lockDownWebContents, rendererUrl } from "./window";

// A packed test build (`npm run dist:test`) carries its own name, and with it a profile folder of
// its own, so it can never be mistaken for the app or share its data. See `src/main/build.ts`.
const isTestPackage = DEV_HOOKS && app.isPackaged;
app.setName(isTestPackage ? TEST_NAME : RELEASE_NAME);

// The id Windows groups the app's windows and shortcuts under. It is the `appId` in
// electron-builder.yml, which the installer puts on the Start-menu shortcut; the two must match,
// or a pinned shortcut and the running window show as two taskbar buttons.
if (process.platform === "win32" && app.isPackaged) {
  app.setAppUserModelId(isTestPackage ? "vinihu.studiplan.test" : "vinihu.studiplan");
}

// Lets an automated run (the smoke test) use a throwaway profile instead of the real one.
// A development hook: a release build does not read the variable.
const userDataOverride = hookValue("STUDIPLAN_USER_DATA_DIR");
if (userDataOverride) app.setPath("userData", userDataOverride);

// A release build cannot be opened to a debugger from its command line. Chromium reads these
// switches after this script has run, so taking them away here means the port (or pipe) is never
// opened. Node's own `--inspect` switches are a different mechanism and are switched off in the
// executable itself, by a fuse (`scripts/pack-hooks.mjs`).
if (!DEV_HOOKS) {
  for (const name of DEBUGGING_SWITCHES) app.commandLine.removeSwitch(name);
}

// A release build that is not packed is somebody running the built code from the source tree
// (`electron .` after a plain build). It would ignore every throwaway folder it is given and
// run in the real profile, which is never what was meant. It says so and stops; `npm run dev`
// and `npm run smoke` build with the development hooks on.
if (!DEV_HOOKS && !app.isPackaged) {
  console.error(
    "This is a release build started from the source tree. It would use your real Studiplan profile and library, so it will not start. " +
      "Use `npm run dev`, or build with `electron-vite build --mode test-build` (what `npm run smoke` does).",
  );
  // At once: nothing below may run, not even the single-instance lock, which looks into the profile.
  process.exit(1);
}

// The scheme the window loads a material's PDFs and photo pages from (src/shared/preview.ts).
// It has to be declared before the app is ready. `standard` gives its URLs a host and a path
// that are parsed like http ones; `secure` lets the app's page embed them without a
// mixed-content warning; `stream` lets a large PDF arrive in pieces. It is deliberately NOT
// given `bypassCSP`, `supportFetchAPI` or `corsEnabled`: the page's policy still decides where
// such a URL may be used (an image, a frame), and scripts cannot fetch the bytes.
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow = createMainWindow();
  // Whoever asked for a running call is gone when the page is loaded anew or the window closes.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) getContext().tasks.cancelAll();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    getContext().tasks.cancelAll();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);

  app.on("web-contents-created", (_event, contents) => {
    lockDownWebContents(contents);
  });

  void app.whenReady().then(() => {
    // No menu bar on Windows and Linux. macOS keeps its standard menu, which is where the
    // system puts copy, paste and quit. During development the default menu stays available
    // (hidden until Alt is pressed) for reload and the developer tools: only in a build with
    // the development hooks on, and only while it is not packed.
    const keepsDevelopmentMenu = DEV_HOOKS && !app.isPackaged;
    if (process.platform !== "darwin" && !keepsDevelopmentMenu) Menu.setApplicationMenu(null);

    // The app asks for no browser permission (camera, microphone, location, notifications…).
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    // Chromium makes no web request for this app, whoever asks: the page (whose own policy
    // already says so), or a PDF in the preview frame, which that policy does not reach. The
    // app's requests to an AI are made by the main process through Node and do not pass here.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details, callback) => callback({ cancel: !mayUseNetwork(details.url, devServerUrl) }),
    );

    // Folders a command-line AI left behind when the app was closed in the middle of a request.
    void sweepStaleTempFolders(os.tmpdir());

    // Serves only what the library lists, found through the library's own path check.
    protocol.handle(PREVIEW_SCHEME, createPreviewHandler(getContext().library));

    setEventTarget(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null));

    registerIpcHandlers(ipcHandlers, (event) => {
      const frame = event.senderFrame;
      return frame !== null && frame.parent === null && isAppUrl(frame.url, rendererUrl);
    });

    showMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, screen, shell } from "electron";
import type { BrowserWindowConstructorOptions, Rectangle, WebContents } from "electron";
import { DEV_HOOKS, hookValue } from "./build";
import { PREVIEW_SCHEME } from "@shared/preview";
import { isAllowedFrameUrl, isAppUrl, isSafeExternalUrl } from "./security";

const builtRendererFile = join(import.meta.dirname, "../renderer/index.html");
// A development hook (`src/main/build.ts`): a release build does not read the variable, so the
// window only ever loads the page that was packed with it.
export const devServerUrl = hookValue("ELECTRON_RENDERER_URL");

/** Where the renderer is loaded from: the Vite dev server in `npm run dev`, the built file otherwise. */
export const rendererUrl = devServerUrl ?? pathToFileURL(builtRendererFile).href;

/** Opens a link in the system browser (http, https) or the mail program (a plain mailto), and nothing else. */
function openExternally(url: string): void {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

/**
 * The navigation rules, applied to every web contents the app ever creates:
 * the page can never leave the app, never open a second window and never embed a webview.
 */
export function lockDownWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url, rendererUrl)) return;
    event.preventDefault();
    openExternally(url);
  });

  // The frame that shows a PDF stays on that PDF. A link or a form in the file cannot take the
  // frame to a web address (the main frame has its own rule above).
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    if (!isAllowedFrameUrl(event.url, PREVIEW_SCHEME)) event.preventDefault();
  });

  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url, rendererUrl)) event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

/*
 * The window's own colours, for the parts the page cannot paint: the frame before the first
 * paint, and the title bar's buttons. They are the theme's surface and text colours and must stay
 * equal to `--background` and `--foreground` in src/renderer/src/theme/theme.css (that file's
 * test checks it).
 */
export const WINDOW_SURFACE = "#ffffff";
export const WINDOW_SYMBOLS = "#111111";

/** How tall the strip with the window's buttons is. The page reads it back from CSS (`titlebar-area-height`). */
export const TITLE_BAR_HEIGHT = 40;

/** The smallest the window can be made: below this the sidebar and a list no longer fit side by side. */
const MIN_SIZE = { width: 1000, height: 600 };
/** A new window fills most of the screen it opens on, up to this size. */
const MAX_FIRST_SIZE = { width: 1600, height: 1000 };
const SHARE_OF_SCREEN = 0.9;

/**
 * The title bar is part of the app: no separate bar in the system's colour above the white
 * window. The system's own buttons stay (minimise, maximise with its snap layouts, close), drawn
 * over the app's surface, and the page marks which of its areas move the window when dragged
 * (see `.app-drag` in the renderer's styles.css).
 *
 *   Windows  a hidden title bar with the window-controls overlay in the app's colours
 *   macOS    the traffic lights inset into the window; the page keeps clear of them
 *   Linux    the system's own frame, because its buttons cannot be drawn over a page everywhere
 */
function titleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: WINDOW_SURFACE, symbolColor: WINDOW_SYMBOLS, height: TITLE_BAR_HEIGHT },
    };
  }
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", titleBarOverlay: { height: TITLE_BAR_HEIGHT } };
  }
  return {};
}

/** What is remembered about the window between runs. */
interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const stateFile = (): string => join(app.getPath("userData"), "window.json");

/** A new window's size: most of the screen's work area, never more than it, never below the minimum. */
export function firstSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const fit = (available: number, most: number, least: number) =>
    Math.min(available, Math.max(least, Math.min(most, Math.round(available * SHARE_OF_SCREEN))));
  return {
    width: fit(workArea.width, MAX_FIRST_SIZE.width, MIN_SIZE.width),
    height: fit(workArea.height, MAX_FIRST_SIZE.height, MIN_SIZE.height),
  };
}

/**
 * Where the window was last time, if that is still a sensible place: wholly inside the work
 * area of a screen that is connected now, and not smaller than the minimum. Anything else (a
 * monitor that is gone, another resolution, a damaged file) is dropped, and the window opens as new.
 */
function rememberedState(): WindowState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { bounds, maximized } = raw as { bounds?: Partial<Rectangle>; maximized?: unknown };
  if (typeof bounds !== "object" || bounds === null) return null;
  const { x, y, width, height } = bounds;
  // Whole numbers of a size a screen can have: a hand-edited value outside that range must not
  // reach Electron, which would throw and leave the app without a window.
  const sane = (value: unknown): boolean =>
    typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 100_000;
  if (![x, y, width, height].every(sane)) return null;
  const rect = { x, y, width, height } as Rectangle;
  if (rect.width < MIN_SIZE.width || rect.height < MIN_SIZE.height) return null;
  const area = screen.getDisplayMatching(rect).workArea;
  const inside =
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height;
  return inside ? { bounds: rect, maximized: maximized === true } : null;
}

function rememberState(window: BrowserWindow): void {
  if (window.isMinimized() && !window.isMaximized()) return;
  const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // Not being able to remember a size is no reason to disturb anyone: next time it opens as new.
  }
}

export function createMainWindow(): BrowserWindow {
  const remembered = rememberedState();
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    title: "Studiplan",
    // As it was left last time; the first time, most of the screen, centred.
    ...(remembered ? remembered.bounds : firstSize(workArea)),
    // On a screen smaller than the usual minimum the window still has to fit on it.
    minWidth: Math.min(MIN_SIZE.width, workArea.width),
    minHeight: Math.min(MIN_SIZE.height, workArea.height),
    // Stay hidden until the first frame is painted, and match the theme's surface colour,
    // so the window never flashes an unstyled or differently coloured frame.
    show: false,
    backgroundColor: WINDOW_SURFACE,
    autoHideMenuBar: true,
    ...titleBarOptions(),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      // No message, confirm or print dialog from a page or from a PDF shown in it. The app's
      // own dialogs are drawn by the page itself.
      disableDialogs: true,
      // No developer tools in a release build, by any route.
      devTools: DEV_HOOKS,
    },
  });

  window.once("ready-to-show", () => {
    if (remembered?.maximized) window.maximize();
    window.show();
  });
  window.on("close", () => rememberState(window));

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(builtRendererFile);
  }

  return window;
}

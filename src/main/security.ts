/**
 * Pure URL checks behind the window's security rules. No Electron import, so they can be
 * unit-tested without starting the app.
 */

/** One address, nothing else: no second recipient, no encoded characters, no parameters. */
const PLAIN_MAILTO = /^mailto:[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}$/i;

/**
 * What may be handed to the system: ordinary web links (they open in the browser; at most 2,048
 * characters, with no user name or password in them) and a plain
 * `mailto:` link to one address (it opens the mail program with an empty message; nothing is
 * sent unless the user sends it). A `mailto:` that carries a subject, a body, copies or
 * attachments (`?subject=…`, `?body=…`, `?cc=…`) is refused: a summary written by a model could
 * otherwise prefill a message.
 */
export function isSafeExternalUrl(url: string): boolean {
  if (typeof url !== "string" || url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "mailto:") return url.length <= 320 && PLAIN_MAILTO.test(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // A name and password in front of the host (`https://bank.example@evil.example/`) is how a link
  // is made to look like it goes somewhere else. No link the app shows needs one.
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.hostname !== "";
}

/**
 * Whether `url` is the app's own page. `rendererUrl` is where the renderer was loaded from:
 * the Vite dev server while developing, the built `index.html` file otherwise.
 * Used both to block navigation away from the app and to reject IPC from any other page.
 */
export function isAppUrl(url: string, rendererUrl: string): boolean {
  let candidate: URL;
  let app: URL;
  try {
    candidate = new URL(url);
    app = new URL(rendererUrl);
  } catch {
    return false;
  }

  if (candidate.protocol !== app.protocol) return false;

  // file: URLs all share one opaque origin, so compare the exact file instead.
  if (app.protocol === "file:") {
    return candidate.host === app.host && candidate.pathname === app.pathname;
  }
  return candidate.origin === app.origin;
}

/** Chromium's built-in PDF viewer: the page inside the frame that shows a PDF. */
const PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/**
 * Whether a frame inside the window may go to `url`. The only frame the app has is the one that
 * shows a material's PDF: it loads a `studiplan-file:` address, and Chromium's PDF viewer loads
 * its own page inside it. Nothing else — above all no web address, which is where a link or a
 * form in a PDF would send the frame.
 */
export function isAllowedFrameUrl(url: string, previewScheme: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${previewScheme}:`) return true;
  if (url === "about:blank" || url === "about:srcdoc") return true;
  // The viewer loads its page and the file it shows from addresses of its own.
  return parsed.protocol === "chrome-extension:" && parsed.host === PDF_VIEWER_ID;
}

/**
 * Whether Chromium may make this web request (`http:`, `https:`, `ws:`, `wss:`). In the app as
 * published: never. The window's page asks for nothing from the network, and the app's own
 * requests to an AI go out from the main process through Node, which this does not concern. The
 * one exception is the development server the page is loaded from during `npm run dev`
 * (`devServerUrl`, absent in a release build), with its websocket for hot reload.
 */
export function mayUseNetwork(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl === undefined) return false;
  try {
    const target = new URL(url);
    const dev = new URL(devServerUrl);
    if (dev.protocol !== "http:" && dev.protocol !== "https:") return false;
    const sameScheme = target.protocol === dev.protocol || target.protocol === (dev.protocol === "https:" ? "wss:" : "ws:");
    return sameScheme && target.host === dev.host;
  } catch {
    return false;
  }
}

import { describe, expect, it } from "vitest";
import { isAllowedFrameUrl, isAppUrl, isSafeExternalUrl, mayUseNetwork } from "./security";

describe("isSafeExternalUrl", () => {
  it("allows http and https links", () => {
    expect(isSafeExternalUrl("https://example.com/page?q=1")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
  });

  it("rejects every other scheme", () => {
    for (const url of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ms-settings:privacy",
      "smb://host/share",
      "tel:+15550100",
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it("allows a mailto link to one plain address", () => {
    expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true);
    expect(isSafeExternalUrl("MAILTO:First.Last+tag@mail.uni-example.org")).toBe(true);
  });

  it("rejects a mailto link that carries anything besides one address", () => {
    for (const url of [
      "mailto:someone@example.com?subject=Hello",
      "mailto:someone@example.com?body=Send%20me%20your%20notes",
      "mailto:someone@example.com?cc=other@example.com",
      "mailto:someone@example.com?attach=C:\\secret.txt",
      "mailto:someone@example.com,other@example.com",
      "mailto:someone@example.com;other@example.com",
      "mailto:someone%40example.com",
      "mailto:someone@example.com%0Abcc:other@example.com",
      "mailto:someone@example.com#x",
      "mailto:someone@example.com ",
      "mailto:?to=someone@example.com",
      "mailto:",
      "mailto:someone",
      "mailto://someone@example.com",
      `mailto:${"a".repeat(65)}@example.com`,
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it("rejects a web link with a user name or password in it", () => {
    for (const url of ["https://example.com@evil.example/", "https://user:secret@example.com/", "http://:x@example.com"]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it("rejects an endless link", () => {
    expect(isSafeExternalUrl(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });

  it("rejects text that is not a URL", () => {
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("example.com")).toBe(false);
    expect(isSafeExternalUrl("/just/a/path")).toBe(false);
  });
});

describe("isAppUrl", () => {
  const built = "file:///C:/app/out/renderer/index.html";
  const dev = "http://localhost:5173/";

  it("accepts the built page, with or without a hash or query", () => {
    expect(isAppUrl(built, built)).toBe(true);
    expect(isAppUrl(`${built}#/settings`, built)).toBe(true);
    expect(isAppUrl(`${built}?x=1`, built)).toBe(true);
  });

  it("rejects any other local file", () => {
    expect(isAppUrl("file:///C:/app/out/renderer/other.html", built)).toBe(false);
    expect(isAppUrl("file:///C:/Users/someone/evil.html", built)).toBe(false);
    expect(isAppUrl("file://server/C:/app/out/renderer/index.html", built)).toBe(false);
  });

  it("accepts any path on the dev server, and nothing else", () => {
    expect(isAppUrl("http://localhost:5173/src/main.tsx", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isAppUrl("https://localhost:5173/", dev)).toBe(false);
    expect(isAppUrl("https://example.com/", dev)).toBe(false);
  });

  it("rejects web pages when the app runs from a file, and the reverse", () => {
    expect(isAppUrl("https://example.com/index.html", built)).toBe(false);
    expect(isAppUrl(built, dev)).toBe(false);
  });

  it("rejects text that is not a URL", () => {
    expect(isAppUrl("not a url", built)).toBe(false);
    expect(isAppUrl(built, "")).toBe(false);
  });
});

describe("isAllowedFrameUrl", () => {
  it("lets the preview frame show a file of the library, through Chromium's PDF viewer", () => {
    for (const url of [
      "studiplan-file://library/Biology/Cell%20division/chapter-3.pdf#navpanes=0",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/51200ede-b756-4017-94fd-24fa357ca651",
      "about:blank",
    ]) {
      expect(isAllowedFrameUrl(url, "studiplan-file"), url).toBe(true);
    }
  });

  it("lets it go nowhere else: not to the web, a file, or another extension", () => {
    for (const url of [
      "https://example.com/collect?file=chapter-3.pdf",
      "http://127.0.0.1:8080/submit",
      "file:///C:/Windows/win.ini",
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "not a url",
      "",
    ]) {
      expect(isAllowedFrameUrl(url, "studiplan-file"), url).toBe(false);
    }
  });
});

describe("mayUseNetwork", () => {
  it("lets Chromium make no web request at all in the app as published", () => {
    for (const url of ["https://example.com/", "http://127.0.0.1:11434/api/tags", "ws://localhost:5173/", "wss://example.com/socket"]) {
      expect(mayUseNetwork(url, undefined), url).toBe(false);
    }
  });

  it("lets only the development server through while developing, with its websocket", () => {
    const dev = "http://localhost:5173/";
    expect(mayUseNetwork("http://localhost:5173/src/main.tsx", dev)).toBe(true);
    expect(mayUseNetwork("ws://localhost:5173/", dev)).toBe(true);
    for (const url of ["http://localhost:5174/", "https://localhost:5173/", "http://example.com:5173/", "wss://localhost:5173/", "http://localhost.evil.example:5173/", "nonsense"]) {
      expect(mayUseNetwork(url, dev), url).toBe(false);
    }
    expect(mayUseNetwork("http://localhost:5173/", "file:///C:/app/index.html")).toBe(false);
  });
});

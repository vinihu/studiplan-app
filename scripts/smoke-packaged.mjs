/**
 * Smoke test for the packaged app: the things that only behave this way once the app is built
 * into an .exe with its code in an archive (app.asar).
 *
 *   npm run dist:test                             packs the test build into artifacts/test-build
 *   npm run smoke:packaged                        runs against "artifacts/test-build/win-unpacked/Studiplan Test.exe"
 *   node scripts/smoke-packaged.mjs <Studiplan Test.exe>   runs against a test build somewhere else
 *
 * It drives a TEST BUILD: the app packed exactly like the release, from a bundle with the
 * development hooks on (`src/main/build.ts`), under its own name. The release itself cannot be
 * driven like this, and that is the point of it: it ignores the throwaway folders below and has
 * no debugger to attach to. What can be checked of the release from outside is in
 * `scripts/verify-release.mjs` (`npm run verify:release`). This test refuses to start on a
 * release build, where it would run in the real profile.
 *
 * THE TWO KINDS OF PACKED APP, AND THE ONE COMMAND FOR EACH
 *
 *   Test build      `npm run dist:test`  then  `npm run smoke:packaged`   (this script)
 *                   "Studiplan Test.exe" in artifacts/test-build/win-unpacked. Development hooks
 *                   on: it obeys the throwaway profile and library this script gives it, and
 *                   Playwright can attach to it. Never an installer, never published.
 *   Release build   `npm run dist`       then  `npm run verify:release`   (scripts/verify-release.mjs)
 *                   "Studiplan.exe" in release/win-unpacked, and the installer. Ignores every
 *                   hook. Started only by verify-release.mjs, which gives each process a
 *                   temporary home so that it cannot reach the real profile.
 *
 * Do not start a release build by hand or from another script to "have a look": it runs in
 * the real profile (%APPDATA%\Studiplan) and on the real library, whatever variables are set.
 * This script reads which kind an executable is from its app.asar before it starts anything,
 * and stops if it is not a test build. The same check is in scripts/smoke.mjs for out/.
 *
 * `scripts/smoke.mjs` checks what the app does, against the unpackaged build. This one checks
 * that the same app still works from inside the package, and what differs there: no menu bar,
 * no way to the developer tools, the version from package.json, the licence files,
 * the modules loaded from the archive (PDF and .pptx text), the file scheme, real `safeStorage`,
 * the single-instance lock, the strict Content-Security-Policy, the bundled font, and all of it
 * with the release's fuses apart from the one a debugger needs (`scripts/after-pack.mjs`).
 *
 * It uses a throwaway profile and a throwaway library (STUDIPLAN_USER_DATA_DIR,
 * STUDIPLAN_LIBRARY_DIR), never the real ones, and makes no AI request: providers are listed and
 * detected (which starts the user's own `claude` and `codex` tools with `--version`), nothing
 * more. Exits non-zero if a step fails; the failing window is saved to
 * artifacts/smoke-packaged-failure.png.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { _electron as electron } from "playwright-core";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { TEST_FUSES } from "./after-pack.mjs";
import { packagedKind, TEST_NAME } from "./build-kind.mjs";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, "artifacts");
const executable = resolve(process.argv[2] ?? join(root, "artifacts/test-build/win-unpacked", `${TEST_NAME}.exe`));
const STEP_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 180_000;

const SUBJECT = "Biology";
const MATERIAL = "Cell division";
const REF = { subject: SUBJECT, material: MATERIAL };
/**
 * Shaped like an Anthropic key, and not one. Long and odd enough to search the disk for. Put
 * together here so that no text shaped like a key is in this file.
 */
const KEY_START = ["sk", "ant", ""].join("-");
const TEST_KEY = `${KEY_START}smoke-packaged-${"NOT-A-REAL-KEY-".repeat(2)}0123456789abcdef`;
const STRICT_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-studiplan-style'; " +
  "img-src 'self' data: studiplan-file:; frame-src studiplan-file:; font-src 'self'; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/* ── Fixtures, generated at run time (the same small real files `smoke.mjs` makes) ─────────── */

function pdf(pages) {
  const objects = [];
  const pageObject = (index) => 4 + index * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    const stream = `BT /F1 18 Tf 72 700 Td 26 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
    const id = pageObject(index);
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function pptx(slides) {
  const ns =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const shape = (placeholder, paragraphs) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraphs.map((text) => `<a:p><a:r><a:rPr lang="en"/><a:t>${text}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  const rels = (entries) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join("")}</Relationships>`;

  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  slides.forEach((slide, index) => {
    archive.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${ns}><p:cSld><p:spTree>` +
        shape('<p:ph type="title"/>', [slide.title]) +
        shape('<p:ph type="body" idx="1"/>', slide.body) +
        `</p:spTree></p:cSld></p:sld>`,
    );
  });
  archive.file(
    "ppt/_rels/presentation.xml.rels",
    rels(slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/slide" Target="slides/slide${i + 1}.xml"/>`)),
  );
  archive.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${ns}><p:sldMasterIdLst/><p:sldIdLst>` +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") +
      `</p:sldIdLst></p:presentation>`,
  );
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A small valid RGB PNG: a light page, as a photo of notes would be. */
function png(width, height) {
  const crc32 = (bytes) => {
    let crc = ~0;
    for (const byte of bytes) {
      let c = (crc ^ byte) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return ~crc >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, 236);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function writeFixtures(folder) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "photo-a.png"), png(600, 800));
  await writeFile(join(folder, "photo-b.png"), png(800, 600));
  await writeFile(
    join(folder, "chapter-3.pdf"),
    pdf([
      ["Chapter 3: Cell division", "Mitosis makes two identical cells."],
      ["The phases", "Prophase, metaphase, anaphase, telophase."],
    ]),
  );
  await writeFile(
    join(folder, "slides.pptx"),
    await pptx([
      { title: "Phases of mitosis", body: ["Prophase: chromosomes condense"] },
      { title: "Anaphase and telophase", body: ["Telophase: two nuclei form"] },
    ]),
  );
  await writeFile(join(folder, "slow.pdf"), slowPdf(5, 30));
  return folder;
}

/**
 * About 2 KB that stand for 24 million pieces of text: one page draws a form thirty times,
 * which draws the next form thirty times, five levels deep; the last one writes a word. Read
 * to the end it computes for minutes.
 */
function slowPdf(levels, fanOut) {
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Count 1 /Kids [4 0 R] >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const form = (level) => 6 + level;
  const page = "/X Do ".repeat(fanOut);
  objects[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /X ${form(0)} 0 R >> >> /Contents 5 0 R >>`;
  objects[5] = `<< /Length ${page.length} >>\nstream\n${page}\nendstream`;
  for (let level = 0; level < levels; level += 1) {
    const last = level === levels - 1;
    const stream = last ? "BT /F1 12 Tf 72 720 Td (word) Tj ET" : "/X Do ".repeat(fanOut);
    const resources = last ? "/Font << /F1 3 0 R >>" : `/XObject << /X ${form(level + 1)} 0 R >>`;
    objects[form(level)] = `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${resources} >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/* ── Helpers ─────────────────────────────────────────────────────────────────────────────── */

async function until(check, label, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * The title bar is part of the app. Where the system draws its buttons over the page (Windows,
 * macOS) the page has to know where they are and keep out from under them; where the system
 * keeps its own title bar (Linux) there is nothing to reserve. Returns what was found.
 */
async function assertTitleBar(page, view) {
  const found = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const area = overlay.getTitlebarAreaRect();
    const strip = document.querySelector('[data-testid="title-strip"]');
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    // Where the window's buttons are: the part of the bar that is not free.
    const buttons =
      area.x > 0
        ? { left: 0, top: 0, right: area.x, bottom: area.height }
        : { left: area.width, top: 0, right: innerWidth, bottom: area.height };
    const under = [...document.querySelectorAll("button, a[href], input, textarea, [role='option'], [role='row'], [tabindex='0']")]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => {
        const rect = box(element);
        return rect.left < buttons.right && rect.right > buttons.left && rect.top < buttons.bottom && rect.bottom > buttons.top;
      })
      .map((element) => element.outerHTML.slice(0, 100));
    const drags = (element) => (element ? getComputedStyle(element).getPropertyValue("-webkit-app-region") : null);
    return {
      overlay: overlay.visible,
      barHeight: area.height,
      buttonsWidth: buttons.right - buttons.left,
      strip: strip ? { ...box(strip), drags: drags(strip) } : null,
      sidebarHead: drags(document.querySelector("nav > p")),
      aRow: drags(document.querySelector("nav button")),
      under,
      innerWidth,
    };
  });
  assert.ok(found.strip, `${view}: the screen has no strip for the window's title bar`);
  if (process.platform === "linux") {
    assert.equal(found.overlay, false, `${view}: the system's own title bar is expected here`);
    assert.equal(found.strip.bottom - found.strip.top, 0, `${view}: a strip is reserved under the system's own title bar`);
    return found;
  }
  assert.equal(found.overlay, true, `${view}: the window's buttons are not drawn over the page (the title bar is the system's own)`);
  assert.ok(found.barHeight >= 28, `${view}: the title bar is ${found.barHeight}px tall`);
  assert.ok(found.buttonsWidth > 0, `${view}: no room is taken by the window's buttons`);
  // The strip over the screen is as tall as the bar, runs to the window's right edge, and moves the window.
  assert.equal(found.strip.top, 0);
  assert.equal(found.strip.bottom, found.barHeight, `${view}: the strip is not as tall as the title bar`);
  assert.equal(found.strip.right, found.innerWidth);
  assert.equal(found.strip.drags, "drag", `${view}: the strip does not move the window`);
  assert.deepEqual(found.under, [], `${view}: something to press lies under the window's buttons`);
  return found;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const dialogOf = (page) => page.locator('[role="dialog"], [role="alertdialog"]').first();

async function submitName(page, name) {
  const field = dialogOf(page).getByRole("textbox");
  await field.fill(name);
  await field.press("Enter");
}

/** Every file under `folder` whose bytes contain `needle`. */
async function filesContaining(folder, needle) {
  const found = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    // Chromium keeps some of its own files open; a file that cannot be read cannot hold the key
    // this run wrote either.
    const bytes = await readFile(file).catch(() => null);
    if (bytes?.includes(needle)) found.push(file);
  }
  return found;
}

/* ── Steps ───────────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {{ app: import("playwright-core").ElectronApplication, page: import("playwright-core").Page, env: NodeJS.ProcessEnv, userData: string, library: string, fixtures: string, version: string }} StepContext
 * @type {Array<{ name: string, run: (ctx: StepContext) => Promise<void> }>}
 */
const steps = [
  {
    name: "the fuses are the release's, apart from the one a debugger needs",
    async run() {
      const wire = await getCurrentFuseWire(executable);
      for (const [fuse, wanted] of Object.entries(TEST_FUSES)) {
        assert.equal(String.fromCharCode(wire[fuse]), wanted ? "1" : "0", `fuse ${FuseV1Options[fuse]}`);
      }
    },
  },
  {
    name: "the window opens with the first screen",
    async run({ page }) {
      // A fresh profile opens on the first-run screen; skipping it leads to the empty library.
      await page
        .getByRole("heading", { name: "Two things before you start" })
        .waitFor({ state: "visible" });
      assert.equal(await page.title(), "Studiplan");
      await page.screenshot({ path: join(artifacts, "smoke-packaged-01-first-run.png") });
      await page.getByRole("button", { name: "Skip for now" }).click();
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor({ state: "visible" });
    },
  },
  {
    name: "it is the packaged app, loaded from the archive, in the throwaway profile and library",
    async run({ app, page, userData, library }) {
      const main = await app.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        exe: app.getPath("exe"),
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        name: app.getName(),
      }));
      assert.equal(main.isPackaged, true, "this is not a packaged app");
      assert.equal(resolve(main.exe).toLowerCase(), executable.toLowerCase());
      assert.equal(resolve(main.appPath).toLowerCase(), join(dirname(executable), "resources", "app.asar").toLowerCase());
      assert.equal(resolve(main.userData), resolve(userData));
      assert.equal(main.name, TEST_NAME);
      assert.match(page.url(), /^file:\/\/\/.+\/resources\/app\.asar\/out\/renderer\/index\.html$/);

      const where = await page.evaluate(() => globalThis.studiplan.library.getInfo());
      assert.equal(where.ok, true);
      assert.equal(resolve(where.value.root), resolve(library));
    },
  },
  {
    name: "the bridge returns the version from package.json",
    async run({ app, page, version }) {
      const info = await page.evaluate(() => globalThis.studiplan.app.getInfo());
      assert.equal(info.version, version);
      // A test build says that it is one, in its name and in what the page is told.
      assert.equal(info.name, TEST_NAME);
      assert.equal(info.build, "test");
      assert.equal(info.platform, process.platform);
      assert.equal(info.electronVersion, await app.evaluate(() => process.versions.electron));
    },
  },
  {
    name: "the page is isolated from Node and Electron",
    async run({ app, page }) {
      const exposed = await page.evaluate(() => ({
        require: typeof globalThis.require,
        process: typeof globalThis.process,
        module: typeof globalThis.module,
        bridge: typeof globalThis.studiplan,
      }));
      assert.deepEqual(exposed, { require: "undefined", process: "undefined", module: "undefined", bridge: "object" });
      const prefs = await app.evaluate(({ BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
        return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox };
      });
      assert.deepEqual(prefs, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    },
  },
  {
    name: "there is no menu bar, and no key opens the developer tools or reloads the page",
    async run({ app, page }) {
      const menu = await app.evaluate(({ BrowserWindow, Menu }) => ({
        applicationMenu: Menu.getApplicationMenu() === null ? null : "a menu",
        menuBarVisible: BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      }));
      assert.deepEqual(menu, { applicationMenu: null, menuBarVisible: false });

      // The shortcuts for the developer tools and for reloading belong to the default menu.
      // With no menu they do nothing. A reload would lose the marker.
      await page.evaluate(() => (globalThis.__smokeMarker = true));
      for (const keys of ["F12", "Control+Shift+I", "Control+Shift+J", "Control+R", "F5", "Alt"]) {
        await page.keyboard.press(keys);
      }
      // Give a reload or the tools time to show up if a key did start one.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 500)));
      const after = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { devTools: window.webContents.isDevToolsOpened(), menuBarVisible: window.isMenuBarVisible() };
      });
      assert.deepEqual(after, { devTools: false, menuBarVisible: false });
      assert.equal(await page.evaluate(() => globalThis.__smokeMarker), true, "a key reloaded the page");
    },
  },
  {
    name: "the title bar is part of the app: the window's buttons over the page, and room kept for them",
    async run({ page }) {
      await assertTitleBar(page, "packaged app");
    },
  },
  {
    name: "the bundled Inter font is loaded from the archive",
    async run({ page }) {
      // The page is a file:// page with no extra rights (a fuse); its fonts still have to load.
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        await document.fonts.load('16px "Inter"');
        return {
          faces: [...document.fonts].map((face) => `${face.family.replace(/["']/g, "")} ${face.style}: ${face.status}`),
          body: getComputedStyle(document.body).fontFamily,
        };
      });
      assert.match(fonts.body, /Inter/, `the page's font is ${fonts.body}`);
      assert.ok(
        fonts.faces.some((face) => /^Inter\b.* normal: loaded$/.test(face)),
        `the upright Inter font did not load: ${fonts.faces.join("; ")}`,
      );
      assert.ok(!fonts.faces.some((face) => face.endsWith(": error")), `a font failed to load: ${fonts.faces.join("; ")}`);
    },
  },
  {
    name: "the Content-Security-Policy is the strict one",
    async run({ page }) {
      const policy = await page.evaluate(
        () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null,
      );
      assert.equal(policy, STRICT_POLICY);
      // And it is enforced: an inline script does not run, a network request is refused.
      const blocked = await page.evaluate(async () => {
        const script = document.createElement("script");
        script.textContent = "globalThis.__smokeInline = true";
        document.head.append(script);
        script.remove();
        const fetched = await fetch("https://example.com/").then(
          () => "fetched",
          () => "refused",
        );
        return { inline: globalThis.__smokeInline === true, fetched };
      });
      assert.deepEqual(blocked, { inline: false, fetched: "refused" });
    },
  },
  {
    name: "create a subject and a material, and add a PDF and a .pptx",
    async run({ page, library, fixtures }) {
      await page.getByRole("main").getByRole("button", { name: "New subject" }).click();
      await submitName(page, SUBJECT);
      await page.getByRole("heading", { name: SUBJECT, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "New material" }).click();
      await submitName(page, MATERIAL);
      await page.getByRole("heading", { name: MATERIAL, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });

      await page
        .locator('input[type="file"]')
        .setInputFiles(["chapter-3.pdf", "slides.pptx"].map((name) => join(fixtures, name)));
      await until(
        async () => (await page.getByRole("button", { name: /^Remove / }).count()) === 2,
        "two file rows",
      );
      const files = join(library, SUBJECT, MATERIAL, "files");
      assert.deepEqual((await readdir(files)).sort(), ["chapter-3.pdf", "slides.pptx"]);
      assert.deepEqual(await readFile(join(files, "chapter-3.pdf")), await readFile(join(fixtures, "chapter-3.pdf")));
    },
  },
  {
    name: "the PDF opens in the built-in viewer through the studiplan-file: scheme",
    async run({ app, page, fixtures }) {
      await page.getByRole("row").filter({ hasText: "chapter-3.pdf" }).click();
      const expected = `studiplan-file://library/${SUBJECT}/${encodeURIComponent(MATERIAL)}/chapter-3.pdf`;
      const frame = page.getByTestId("pdf-frame");
      await frame.waitFor();
      assert.equal(await frame.getAttribute("src"), `${expected}#navpanes=0`);
      await until(
        () => page.frames().find((candidate) => candidate.url().startsWith(expected)),
        "the frame to load the studiplan-file URL",
      );
      const served = await app.evaluate(async ({ session }, url) => {
        const response = await session.defaultSession.fetch(url);
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, type: response.headers.get("content-type"), base64: bytes.toString("base64") };
      }, expected);
      assert.equal(served.status, 200);
      assert.match(served.type ?? "", /^application\/pdf/);
      assert.deepEqual(Buffer.from(served.base64, "base64"), await readFile(join(fixtures, "chapter-3.pdf")));

      // The viewer drew the page: its dark background fills the frame until then.
      const box = await frame.boundingBox();
      assert.ok(box && box.width > 400 && box.height > 300, "the PDF frame has no room");
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      await until(
        () =>
          app.evaluate(async ({ BrowserWindow }, area) => {
            const bitmap = (await BrowserWindow.getAllWindows()[0].webContents.capturePage(area)).toBitmap();
            let white = 0;
            for (let at = 0; at < bitmap.length; at += 4) {
              if (bitmap[at] > 245 && bitmap[at + 1] > 245 && bitmap[at + 2] > 245) white += 1;
            }
            return white / (bitmap.length / 4) > 0.15;
          }, rect),
        "the viewer to draw the PDF's page",
      );
      const picture = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"),
      );
      await writeFile(join(artifacts, "smoke-packaged-02-pdf.png"), Buffer.from(picture, "base64"));
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: MATERIAL, level: 1 }).waitFor();
    },
  },
  {
    name: "text comes out of the PDF and the .pptx (unpdf and jszip, loaded from the archive)",
    async run({ app, page }) {
      const [fromPdf, fromSlides] = await page.evaluate(
        (ref) =>
          Promise.all([
            globalThis.studiplan.library.extractText(ref, "chapter-3.pdf"),
            globalThis.studiplan.library.extractText(ref, "slides.pptx"),
          ]),
        REF,
      );
      assert.equal(fromPdf.ok, true, `PDF text failed: ${JSON.stringify(fromPdf.error)}`);
      assert.match(fromPdf.value.text, /Mitosis makes two identical cells\./);
      assert.match(fromPdf.value.text, /Prophase, metaphase, anaphase, telophase\./);
      assert.equal(fromSlides.ok, true, `.pptx text failed: ${JSON.stringify(fromSlides.error)}`);
      assert.match(fromSlides.value.text, /Phases of mitosis/);
      assert.match(fromSlides.value.text, /Telophase: two nuclei form/);

      // Both modules really came out of app.asar, not from a node_modules folder next to it.
      const resources = join(dirname(executable), "resources");
      assert.deepEqual((await readdir(resources)).sort(), ["app.asar"]);
      // The licence texts a user can open lie next to the program.
      for (const name of ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt", "LICENSE.Inter-font.txt", "LICENSE.electron.txt", "LICENSES.chromium.html"]) {
        assert.ok(existsSync(join(dirname(executable), name)), `${name} is not in the program folder`);
      }
      const packed = await app.evaluate(() => {
        const { existsSync } = process.getBuiltinModule("node:fs");
        const { join } = process.getBuiltinModule("node:path");
        const modules = join(process.resourcesPath, "app.asar", "node_modules");
        return ["unpdf/package.json", "unpdf/dist/pdfjs.mjs", "jszip/package.json"].map((file) =>
          existsSync(join(modules, file)),
        );
      });
      assert.deepEqual(packed, [true, true, true]);
    },
  },
  {
    name: "a PDF built to compute for minutes does not hold the app up, and reading it can be cancelled",
    async run({ app, page, fixtures }) {
      await page.locator('input[type="file"]').setInputFiles([join(fixtures, "slow.pdf")]);
      await until(async () => (await page.getByRole("button", { name: /^Remove / }).count()) === 3, "three file rows");

      // Read in the worker (out/main/worker-….js inside app.asar). The call is not awaited yet.
      await page.evaluate((ref) => {
        globalThis.__slow = { done: false, result: null };
        void globalThis.studiplan.library.extractText(ref, "slow.pdf", "smoke-slow-pdf-0001").then((result) => {
          globalThis.__slow = { done: true, result };
        });
      }, REF);
      // While it computes, the main process answers at once and the page keeps running.
      for (let round = 0; round < 5; round += 1) {
        await new Promise((done) => setTimeout(done, 300));
        const started = Date.now();
        assert.equal(await app.evaluate(({ app }) => app.isReady()), true);
        assert.equal((await page.evaluate(() => globalThis.studiplan.library.getInfo())).ok, true);
        assert.ok(Date.now() - started < 1_500, `the main process took ${Date.now() - started} ms to answer while a PDF was being read`);
      }
      assert.equal(await page.evaluate(() => globalThis.__slow.done), false, "the slow PDF was read to the end already: it is not slow");
      // Cancel reaches it.
      const cancelAt = Date.now();
      assert.equal(await page.evaluate(() => globalThis.studiplan.tasks.cancel("smoke-slow-pdf-0001")), true);
      await until(() => page.evaluate(() => globalThis.__slow.done), "the cancelled reading to come back", 5_000);
      assert.ok(Date.now() - cancelAt < 3_000);
      const outcome = await page.evaluate(() => globalThis.__slow.result);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, "cancelled");
      // And the ordinary file is still read, next to it.
      const again = await page.evaluate((ref) => globalThis.studiplan.library.extractText(ref, "chapter-3.pdf"), REF);
      assert.equal(again.ok, true);

      await page.getByRole("button", { name: "Remove slow.pdf" }).click();
      const confirm = dialogOf(page).getByRole("button", { name: /^Remove/ });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await until(async () => (await page.getByRole("button", { name: /^Remove / }).count()) === 2, "two file rows again");
    },
  },
  {
    name: "photos become a set and the set a PDF, from inside the package; Make offers its six kinds",
    async run({ page, library, fixtures }) {
      // Wherever the last step left the window: back to the material.
      for (let tries = 0; tries < 3 && (await page.getByRole("heading", { name: MATERIAL, level: 1 }).count()) === 0; tries++) {
        await page.keyboard.press("Escape");
        await page.getByRole("heading", { level: 1 }).first().waitFor();
      }
      await page.getByRole("heading", { name: MATERIAL, level: 1 }).waitFor();
      await page.locator('input[type="file"]').setInputFiles([join(fixtures, "photo-a.png"), join(fixtures, "photo-b.png")]);
      const turn = page.getByRole("button", { name: /^Turn .+ into a PDF$/ });
      await turn.waitFor();
      await turn.click();
      await page.getByTestId("pdf-made").waitFor();
      const files = join(library, SUBJECT, MATERIAL, "files");
      const made = (await readdir(files)).find((name) => name.startsWith("notes-") && name.endsWith(".pdf"));
      assert.ok(made, "no PDF of the photo set on disk");
      assert.equal((await readFile(join(files, made))).subarray(0, 4).toString("latin1"), "%PDF");
      assert.equal(await turn.count(), 0, "the PDF can be made a second time");
      await page.locator("[data-made-from]").getByText("same pages as the photos").waitFor();

      const kinds = await page.getByTestId("make").locator("[data-make-group] button").allInnerTexts();
      assert.deepEqual(kinds.map((kind) => kind.trim()), ["Summary", "Explain it", "Cheat sheet", "Flashcards", "Practice test", "Your own request"]);
    },
  },
  {
    name: "Chromium makes no web request for the app; the main process's own requests still go out",
    async run({ app }) {
      const hits = [];
      const server = http.createServer((request, response) => {
        hits.push(request.url);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const seen = await app.evaluate(async ({ session }, address) => {
          const http = process.getBuiltinModule("node:http");
          return {
            // What a page, a frame or a PDF in the window would use.
            chromium: await session.defaultSession.fetch(`${address}/chromium`).then(
              (reply) => `answered ${reply.status}`,
              () => "refused",
            ),
            // What the API-key provider uses.
            nodeFetch: await fetch(`${address}/node-fetch`).then(
              (reply) => reply.status,
              (error) => String(error),
            ),
            // What the Ollama provider uses.
            nodeHttp: await new Promise((done) => {
              http
                .get(`${address}/node-http`, (reply) => {
                  reply.resume();
                  done(reply.statusCode);
                })
                .on("error", (error) => done(String(error)));
            }),
          };
        }, base);
        assert.deepEqual(seen, { chromium: "refused", nodeFetch: 200, nodeHttp: 200 });
        assert.deepEqual(hits.sort(), ["/node-fetch", "/node-http"]);
      } finally {
        await new Promise((done) => server.close(done));
      }
    },
  },
  {
    name: "the providers are the real four, and detecting them works",
    async run({ app, page }) {
      assert.equal(await app.evaluate(() => process.env.STUDIPLAN_FAKE_AI), undefined, "the stand-in AI is switched on");
      const listed = await page.evaluate(() => globalThis.studiplan.providers.list());
      assert.deepEqual(listed.map((provider) => provider.id), ["claude-code", "codex", "ollama", "api-key"]);
      assert.ok(!listed.some((provider) => /test ai/i.test(provider.label)), "the Test AI is listed");

      // Detection starts the user's own `claude` and `codex` (their version and sign-in status,
      // no request) and asks Ollama on this computer. Whatever is installed here, each must come
      // back with a status and a sentence: starting a program works from the packaged app.
      const detected = await page.evaluate(() => globalThis.studiplan.providers.detectAll());
      assert.deepEqual(detected.map((entry) => entry.id), ["claude-code", "codex", "ollama", "api-key"]);
      for (const entry of detected) {
        assert.ok(
          ["ready", "not-installed", "not-signed-in"].includes(entry.detection.status),
          `${entry.id}: ${entry.detection.status}: ${entry.detection.detail}`,
        );
        assert.ok(entry.detection.detail.length > 0);
      }
      console.log(
        `        detected: ${detected.map((entry) => `${entry.id}=${entry.detection.status}${entry.detection.version ? ` (${entry.detection.version})` : ""}`).join(", ")}`,
      );
    },
  },
  {
    name: "an API key is saved encrypted by Windows, is nowhere on disk as text, and can be removed",
    async run({ app, page, userData }) {
      assert.equal(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true);
      const saved = await page.evaluate((key) => globalThis.studiplan.providers.saveApiKey("anthropic", key), TEST_KEY);
      assert.equal(saved.ok, true, `saving failed: ${JSON.stringify(saved.error)}`);
      assert.deepEqual(saved.value.saved, ["anthropic"]);

      const file = join(userData, "api-key-anthropic.bin");
      const stored = await readFile(file);
      assert.ok(stored.length > TEST_KEY.length, "the stored key is shorter than the key");
      assert.ok(!stored.includes(TEST_KEY), "the key file holds the key as text");
      assert.ok(!stored.includes(KEY_START), "the key file holds the start of the key as text");
      assert.deepEqual(await filesContaining(userData, TEST_KEY), [], "the key is on disk as text");
      // Only this Windows account can turn it back into the key.
      const decrypted = await app.evaluate(({ safeStorage }, base64) => safeStorage.decryptString(Buffer.from(base64, "base64")), stored.toString("base64"));
      assert.equal(decrypted, TEST_KEY);

      const cleared = await page.evaluate(() => globalThis.studiplan.providers.clearApiKey("anthropic"));
      assert.equal(cleared.ok, true);
      assert.deepEqual(cleared.value.saved, []);
      assert.ok(!existsSync(file), "the key file is still there after removing the key");
    },
  },
  {
    name: "a second copy started while this one runs steps aside (single-instance lock)",
    async run({ app, env }) {
      const second = spawn(executable, [], { env, stdio: "ignore" });
      const code = await withTimeout(
        new Promise((done, fail) => {
          second.once("exit", done);
          second.once("error", fail);
        }),
        15_000,
        "the second copy to quit",
      ).catch((error) => {
        second.kill();
        throw error;
      });
      assert.equal(code, 0);
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      assert.equal(windows, 1, "the second copy opened a window");
    },
  },
];

/* ── Runner ──────────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (process.platform !== "win32") throw new Error("The packaged smoke test runs on Windows only.");
  if (!existsSync(executable)) {
    throw new Error(`No test build at ${executable}. Run \`npm run dist:test\` first.`);
  }
  // A release build ignores the throwaway profile and library: this test would run in the real ones.
  if ((await packagedKind(executable)) !== "test") {
    throw new Error(
      `${executable} is a release build. This test drives a test build only (\`npm run dist:test\`); ` +
        "for the release there is `npm run verify:release`.",
    );
  }
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await mkdir(artifacts, { recursive: true });
  for (const name of await readdir(artifacts)) {
    if (/^smoke-packaged.*\.png$/.test(name)) await rm(join(artifacts, name), { force: true });
  }

  // Set from outside (the install check does) so the caller can look at the folders afterwards.
  const given = process.env.STUDIPLAN_USER_DATA_DIR && process.env.STUDIPLAN_LIBRARY_DIR;
  const scratch = await mkdtemp(join(tmpdir(), "studiplan-smoke-packaged-"));
  const userData = given ? resolve(process.env.STUDIPLAN_USER_DATA_DIR) : join(scratch, "profile");
  const library = given ? resolve(process.env.STUDIPLAN_LIBRARY_DIR) : join(scratch, "library");
  const fixtures = await writeFixtures(join(scratch, "fixtures"));

  const env = {
    ...process.env,
    STUDIPLAN_USER_DATA_DIR: userData,
    STUDIPLAN_LIBRARY_DIR: library,
  };
  // The stand-in AI is a development hook like the two above, and a test build honours it. This
  // test wants the real list of AIs.
  delete env.STUDIPLAN_FAKE_AI;
  // Set by some terminals and editors; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`\n  ${executable}`);
  const pageProblems = [];
  let app;
  let passed = true;
  try {
    app = await electron.launch({ executablePath: executable, args: [], cwd: scratch, env, timeout: 30_000 });
    const page = await app.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.on("console", (message) => {
      if (message.type() === "error") pageProblems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => pageProblems.push(`uncaught: ${error.message}`));
    await page.waitForLoadState("domcontentloaded");

    for (const step of [
      ...steps,
      {
        name: "no errors in the page console",
        async run() {
          // The two the policy step provokes on purpose are expected; anything else is not.
          const unexpected = pageProblems.filter(
            (problem) => !/Content Security Policy|Failed to fetch|example\.com/.test(problem),
          );
          assert.deepEqual(unexpected, []);
        },
      },
    ]) {
      const started = Date.now();
      try {
        await withTimeout(
          step.run({ app, page, env, userData, library, fixtures, version }),
          STEP_TIMEOUT_MS * 2,
          `"${step.name}"`,
        );
        console.log(`  ok    ${step.name} (${Date.now() - started} ms)`);
      } catch (error) {
        passed = false;
        console.error(`  FAIL  ${step.name}`);
        console.error(String(error?.stack ?? error).replace(/^/gm, "        "));
        if (pageProblems.length > 0) console.error("        page problems:", pageProblems);
        await page.screenshot({ path: join(artifacts, "smoke-packaged-failure.png") }).catch(() => {});
        break;
      }
    }
  } finally {
    await withTimeout(app?.close() ?? Promise.resolve(), 10_000, "closing the app").catch(() => {
      app?.process().kill();
    });
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  if (!passed) throw new Error("Packaged smoke test failed.");
  console.log("\nPackaged smoke test passed.");
}

const watchdog = setTimeout(() => {
  console.error(`Packaged smoke test did not finish within ${RUN_TIMEOUT_MS} ms.`);
  process.exit(1);
}, RUN_TIMEOUT_MS);

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(`\n${error?.message ?? error}`);
    process.exit(1);
  });

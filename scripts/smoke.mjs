/**
 * Smoke test: starts the real, built app and checks it the way a person would use it.
 *
 *   npm run smoke          builds first, then runs this script
 *   node scripts/smoke.mjs runs against the existing build in out/
 *
 * It launches Electron through Playwright with a throwaway profile and a throwaway library
 * folder, runs the steps below in order, saves screenshots of the main states to
 * artifacts/smoke-NN-*.png and exits non-zero if any step fails (the failing window is saved to
 * artifacts/smoke-failure.png).
 *
 * Every step checks both sides: what the page shows, and what is really on disk in the
 * throwaway library.
 *
 * To cover a new milestone, add a step to `steps`. A step gets a context:
 *   app       Playwright ElectronApplication (app.evaluate runs code in the main process)
 *   page      the app's window, a Playwright Page
 *   shot      shot("name") saves artifacts/name.png
 *   library   absolute path of the throwaway library folder
 *   fixtures  absolute path of a folder with generated source files (see `writeFixtures`)
 *   userData  absolute path of the throwaway profile folder
 * and fails by throwing, e.g. through `assert`. Steps run in order and build on each other.
 * Wait on state (a locator, `until`), never on a fixed time.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { _electron as electron } from "playwright-core";
import { bundleKind } from "./build-kind.mjs";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, "artifacts");
const STEP_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 600_000;

/* ── Fixtures, generated at run time ─────────────────────────────────────────────────────── */

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

/** A valid RGB PNG of the given size: light paper with dark diagonal lines. */
function png(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, 236);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = (48 - (y % 48)) % 48; x < width; x += 48) raw.fill(40, y * stride + 1 + x * 3, y * stride + 4 + x * 3);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A small but real PDF: one page per entry of `pages`, each a list of lines set in Helvetica,
 * with a correct cross-reference table, so the built-in viewer opens it.
 */
function pdf(pages) {
  const objects = [];
  const pageObject = (index) => 4 + index * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    // A page given as `null` is a picture only, the way a scanned page is: nothing to read.
    const stream =
      lines === null
        ? "0.5 g 72 72 468 648 re f"
        : `BT /F1 18 Tf 72 700 Td 26 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
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

const PPTX_NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PPTX_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function pptxShape(placeholder, paragraphs) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraphs.map((text) => `<a:p><a:r><a:rPr lang="en"/><a:t>${text}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`
  );
}

function pptxRels(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join("")}</Relationships>`;
}

/**
 * A small but real .pptx: slide XML with title and body placeholders, speaker notes, and a
 * presentation part that gives the order. `slides` is a list of `{ title?, body?, notes? }`.
 */
async function pptx(slides) {
  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  slides.forEach((slide, index) => {
    const number = index + 1;
    archive.file(
      `ppt/slides/slide${number}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${PPTX_NAMESPACES}><p:cSld><p:spTree>` +
        (slide.title ? pptxShape('<p:ph type="title"/>', [slide.title]) : "") +
        (slide.body ? pptxShape('<p:ph type="body" idx="1"/>', slide.body) : "") +
        `</p:spTree></p:cSld></p:sld>`,
    );
    if (slide.notes) {
      archive.file(
        `ppt/notesSlides/notesSlide${number}.xml`,
        `<?xml version="1.0" encoding="UTF-8"?><p:notes ${PPTX_NAMESPACES}><p:cSld><p:spTree>` +
          pptxShape('<p:ph type="body" idx="1"/>', slide.notes) +
          `</p:spTree></p:cSld></p:notes>`,
      );
      archive.file(
        `ppt/slides/_rels/slide${number}.xml.rels`,
        pptxRels([`<Relationship Id="rId2" Type="${PPTX_REL}/notesSlide" Target="../notesSlides/notesSlide${number}.xml"/>`]),
      );
    }
  });
  archive.file(
    "ppt/_rels/presentation.xml.rels",
    pptxRels(slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${PPTX_REL}/slide" Target="slides/slide${i + 1}.xml"/>`)),
  );
  archive.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${PPTX_NAMESPACES}><p:sldMasterIdLst/><p:sldIdLst>` +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") +
      `</p:sldIdLst></p:presentation>`,
  );
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const PDF_PAGES = [
  ["Chapter 3: Cell division", "Mitosis makes two identical cells.", "Meiosis makes four cells with half the chromosomes."],
  ["The phases", "Prophase, metaphase, anaphase, telophase."],
];

const SLIDES = [
  { title: "Phases of mitosis", body: ["Prophase: chromosomes condense", "Metaphase: they line up in the middle"], notes: ["Ask the class which phase is the longest."] },
  { title: "Anaphase and telophase", body: ["Anaphase: the chromatids are pulled apart", "Telophase: two nuclei form"] },
  { body: ["Cytokinesis divides the cell itself."] },
];

/** The source files a student would pick. Returns the folder they are in. */
async function writeFixtures(folder) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "chapter-3.pdf"), pdf(PDF_PAGES));
  await writeFile(join(folder, "slides.pptx"), await pptx(SLIDES));
  await writeFile(join(folder, "scan.pdf"), pdf([null, null]));
  // One page of text, three scanned ones: partly a scan.
  await writeFile(join(folder, "partly.pdf"), pdf([["Notes on waves", "A wave carries energy, not matter."], null, null, null]));
  // Slides that are pictures only: there is no text in them to show.
  await writeFile(join(folder, "pictures.pptx"), await pptx([{}, {}]));
  // Larger than a page is allowed to be, so the downscale is observable in the result.
  await writeFile(join(folder, "photo-a.png"), png(2600, 1950));
  await writeFile(join(folder, "photo-b.png"), png(900, 1200));
  await writeFile(join(folder, "recording.mp3"), "ID3 not something a material can hold");
  return folder;
}

/* ── Helpers for steps ───────────────────────────────────────────────────────────────────── */

/** Polls until `check` returns something truthy, and returns it. For state that is not in the page. */
async function until(check, label, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Every file and folder under `folder`, as sorted forward-slash paths. [] if it does not exist. */
async function tree(folder) {
  if (!existsSync(folder)) return [];
  const entries = await readdir(folder, { recursive: true });
  return entries.map((entry) => entry.replaceAll("\\", "/")).sort();
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

/** Width and height from a JPEG's frame header. */
function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error("Not a JPEG segment");
    const marker = bytes[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("No frame header in JPEG");
}

/** The open dialog (a name dialog or a confirmation). */
const dialogOf = (page) => page.locator('[role="dialog"], [role="alertdialog"]').first();

/** Fills the open name dialog and submits it with Enter. */
async function submitName(page, name) {
  const field = dialogOf(page).getByRole("textbox");
  await field.fill(name);
  await field.press("Enter");
}

/** Opens a "…" menu by its accessible name and picks an item. */
async function chooseOption(page, menuName, item) {
  await page.getByRole("button", { name: menuName, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** What the system calls its bin, as the app words it. */
const binName = () => (process.platform === "win32" ? "Recycle Bin" : "Trash");

/**
 * The look, checked on whatever view is showing: a white surface, the accent defined, HeroUI's
 * styles applied, and at most one filled accent button — blue means "act here", once.
 */
async function assertTheme(page, view) {
  const styles = await page.evaluate(async () => {
    await document.fonts.ready;
    const resolveColor = (value) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const accent = resolveColor("var(--accent)");
    const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    const filled = buttons.filter((b) => getComputedStyle(b).backgroundColor === accent);
    return {
      // A button that shows only an icon has to say in words what it does.
      unnamed: buttons
        .filter((b) => (b.textContent ?? "").trim() === "" && (b.getAttribute("aria-label") ?? "").trim() === "" && !b.hasAttribute("aria-labelledby"))
        .map((b) => b.outerHTML.slice(0, 120)),
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontLoaded: document.fonts.check('400 16px "Inter"') && document.fonts.check('700 16px "Inter"'),
      accent,
      transparent: resolveColor("transparent"),
      white: resolveColor("#ffffff"),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      buttons: buttons.length,
      filled: filled.map((b) => b.textContent),
      radius: filled[0] ? getComputedStyle(filled[0]).borderTopLeftRadius : null,
      padding: filled[0] ? getComputedStyle(filled[0]).paddingLeft : null,
    };
  });
  assert.notEqual(styles.accent, styles.transparent, `${view}: --accent is not defined`);
  assert.equal(styles.bodyBackground, styles.white, `${view}: the surface is not white`);
  assert.ok(styles.buttons > 0, `${view}: no buttons are showing`);
  assert.deepEqual(styles.unnamed, [], `${view}: an icon-only button has no accessible name`);
  // The app's one typeface is the bundled Inter, and it really loaded (nothing comes from the network).
  assert.match(styles.fontFamily, /^"?Inter"?,/, `${view}: the body's font family does not start with Inter`);
  assert.equal(styles.fontLoaded, true, `${view}: Inter did not load`);
  assert.ok(
    styles.filled.length <= 1,
    `${view}: more than one filled accent button: ${styles.filled.join(", ")}`,
  );
  if (styles.radius !== null) {
    assert.notEqual(styles.radius, "0px", `${view}: the button has no radius: HeroUI styles are missing`);
    assert.notEqual(styles.padding, "0px", `${view}: the button has no padding: HeroUI styles are missing`);
  }
  return styles;
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

/* ── Steps ───────────────────────────────────────────────────────────────────────────────── */

const SUBJECT = "Biology";
const MATERIAL = "Cell division";
const RENAMED = "Mitosis";
/** The subject and material the preview and Settings steps work in. */
const SUBJECT_2 = "Physics";
const MATERIAL_2 = "Waves";

/** A quiz as an earlier version of the app saved one, written by hand by the step that needs it. */
const OLD_QUIZ = "2026-09-30-quiz.json";

/** A file's row on the Material screen. */
const fileRow = (page, name) => page.getByRole("row").filter({ hasText: name });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today as the app writes a date: "2 Oct 2026", whatever the computer's own format is. */
function today() {
  const now = new Date();
  return `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

/**
 * Deleting uses shell.trashItem. In a smoke run that would leave litter in the real Recycle
 * Bin, so it removes the item outright instead, and only ever inside the throwaway library.
 * Everything else about deleting is the real code. Needed once per launch that deletes.
 */
async function keepOutOfRecycleBin(app, library) {
  await app.evaluate(({ shell }, libraryDir) => {
    const { rm } = process.getBuiltinModule("node:fs/promises");
    const { resolve, sep } = process.getBuiltinModule("node:path");
    globalThis.__smokeTrashed = [];
    shell.trashItem = async (target) => {
      const full = resolve(target);
      if (!full.startsWith(resolve(libraryDir) + sep)) {
        throw new Error(`Smoke: refusing to delete outside the throwaway library: ${full}`);
      }
      globalThis.__smokeTrashed.push(full);
      await rm(full, { recursive: true });
    };
  }, library);
}

/** Opens a material from its subject's list. */
async function openMaterial(page, title) {
  await page.getByRole("row").filter({ hasText: title }).click();
  await page.getByRole("heading", { name: title, level: 1 }).waitFor();
}

/** Chooses what to make: one of the kind buttons of the Make section. */
async function chooseKind(page, label) {
  await page.getByTestId("make").getByText(label, { exact: true }).click();
}

/** Starts noting every text the Make progress shows; a fast AI is done before it can be waited for. */
async function recordProgress(page) {
  await page.evaluate(() => {
    globalThis.__smokeMaking = [];
    const note = () => {
      const text = document.querySelector('[data-testid="make-progress"]')?.textContent ?? "";
      if (text !== "" && !globalThis.__smokeMaking.includes(text)) globalThis.__smokeMaking.push(text);
    };
    globalThis.__smokeMakingObserver?.disconnect();
    globalThis.__smokeMakingObserver = new MutationObserver(note);
    globalThis.__smokeMakingObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function recordedProgress(page) {
  return page.evaluate(() => {
    globalThis.__smokeMakingObserver.disconnect();
    return globalThis.__smokeMaking;
  });
}

/** Waits until every image inside `scope` has really loaded, and returns their natural widths. */
async function loadedImages(page, scope, expected) {
  return until(
    () =>
      page.evaluate(
        ([selector, n]) => {
          const images = [...document.querySelectorAll(`${selector} img`)];
          if (images.length !== n) return null;
          return images.every((image) => image.complete && image.naturalWidth > 0)
            ? images.map((image) => image.naturalWidth)
            : null;
        },
        [scope, expected],
      ),
    `${expected} loaded image(s) in ${scope}`,
  );
}

/** Steps of the very first launch, on a fresh profile: the first-run screen. */
const firstRunSteps = [
  {
    name: "a fresh profile starts on the first-run screen: the folder, and an AI one click away",
    async run({ page, shot, library }) {
      const screen = page.getByTestId("first-run");
      await screen.waitFor();
      await screen.getByRole("heading", { name: "Two things before you start", level: 1 }).waitFor();
      assert.equal(await page.getByTestId("app-shell").count(), 0, "the library is showing behind the first-run screen");

      // Step 1: where the library lives. In this run the environment fixes it, and the screen says so.
      assert.equal(resolve(await screen.getByTestId("library-root").innerText()), resolve(library));
      await screen.getByText(/set from outside the app for this run \(STUDIPLAN_LIBRARY_DIR\)/).waitFor();
      assert.equal(await screen.getByRole("button", { name: "Change…" }).isDisabled(), true);

      // What the app is, in its first sentence: your own AI, and free. "Free" is said of the app,
      // never of an AI: the student pays their provider as they already do.
      const said = (await screen.innerText()).replace(/\s+/g, " ");
      assert.match(said, /turns your study materials into summaries, cheat sheets, flashcards and practice tests, with your own AI, for free\./);
      assert.match(said, /Studiplan is free and never charges for AI\. It uses the one you already have, and you pay that provider as you already do\./);
      assert.doesNotMatch(said, /free AI|AI is free|free (model|credits|tier)/i);

      // Step 2: the AI that is ready is offered with one blue button; Start waits as an outline.
      const row = screen.locator('[data-provider="claude-code"]');
      await row.locator('[data-status="ready"]').waitFor();
      // (Start hands the blue over to it; the colour changes over a moment.)
      await until(async () => {
        const blue = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--accent)";
          document.body.append(probe);
          const accent = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return [...document.querySelectorAll("button")].filter((b) => getComputedStyle(b).backgroundColor === accent).map((b) => b.textContent);
        });
        return blue.join() === "Use Test AI";
      }, "Use Test AI to be the one blue button");
      assert.deepEqual((await assertTheme(page, "first run")).filled, ["Use Test AI"]);
      await screen.getByRole("button", { name: "Skip for now" }).waitFor();
      // No sidebar here, so the strip for the window's title bar runs across the whole window.
      const bar = await assertTitleBar(page, "first run");
      assert.equal(bar.strip.left, 0, "the first-run screen's strip does not start at the window's left edge");
      await shot("smoke-00-first-run");

      await row.getByRole("button", { name: "Use Test AI" }).click();
      await row.getByText("Used for new results").waitFor();
      const saved = await page.evaluate(() => globalThis.studiplan.providers.getSettings());
      assert.equal(saved.defaultProvider, "claude-code");
      // Choosing did not close the screen; now Start is the thing to press.
      // (The button changes colour over a moment.)
      await until(
        async () => (await assertTheme(page, "first run, AI chosen")).filled.join() === "Start",
        "Start to become the blue button",
      );
      await shot("smoke-00-first-run-ai-chosen");

      await screen.getByRole("button", { name: "Start" }).click();
      await page.getByTestId("app-shell").waitFor();
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      assert.equal(await page.getByTestId("first-run").count(), 0);
    },
  },
  {
    name: "the chosen AI can be put away again in Settings, in one click",
    async run({ page }) {
      const sidebar = page.getByRole("navigation");
      await sidebar.getByRole("button", { name: /^Settings/ }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      const row = page.locator('[data-provider="claude-code"]');
      await row.getByText("Used for new results").waitFor();
      await row.getByRole("button", { name: "Stop using" }).click();
      await row.getByRole("button", { name: "Use Test AI" }).waitFor();
      assert.equal(await row.getByText("Used for new results").count(), 0);
      const saved = await page.evaluate(() => globalThis.studiplan.providers.getSettings());
      assert.equal(saved.defaultProvider, null);
      // Escape leaves Settings, like its back button.
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      await sidebar.getByText("No AI yet").waitFor();
    },
  },
  {
    name: "first run does not come back after it was finished; Skip finishes it too",
    async run({ page }) {
      // No subjects and no AI, as on the very first start, but it was finished: straight to the app.
      await page.reload();
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      assert.equal(await page.getByTestId("first-run").count(), 0, "first run came back");

      // As if never finished: it is offered again, and Skip for now puts it away for good.
      await page.evaluate(() => globalThis.localStorage.removeItem("studiplan.firstRunDone"));
      await page.reload();
      const screen = page.getByTestId("first-run");
      await screen.waitFor();
      await screen.getByRole("button", { name: "Skip for now" }).click();
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      assert.equal(await page.evaluate(() => globalThis.studiplan.providers.getSettings().then((s) => s.defaultProvider)), null);
      await page.reload();
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      assert.equal(await page.getByTestId("first-run").count(), 0, "first run came back after Skip");
    },
  },
];

firstRunSteps.push({
  name: "a name of only spaces gets a sentence; a name a folder cannot have is said to be changed",
  async run({ app, page, shot, library }) {
    await keepOutOfRecycleBin(app, library);
    await page.getByRole("main").getByRole("button", { name: "New subject" }).click();
    const field = dialogOf(page).getByRole("textbox");
    await field.fill("   ");
    await field.press("Enter");
    await dialogOf(page).getByText("Type a name first. Spaces alone are not one.").waitFor();
    assert.deepEqual(await tree(library), []);

    // Characters Windows forbids in a folder name: the subject is made, and the screen says
    // under which name, instead of changing it silently.
    await field.fill("a/bc:d*e");
    await field.press("Enter");
    await dialogOf(page).waitFor({ state: "detached" });
    const [saved] = await until(async () => {
      const found = await tree(library);
      return found.length === 1 ? found : null;
    }, "the subject's folder");
    assert.notEqual(saved, "a/bc:d*e");
    await page.getByRole("heading", { name: saved, level: 1 }).waitFor();
    const note = page.getByTestId("saved-as");
    await note.waitFor();
    assert.ok((await note.innerText()).includes(`Saved as “${saved}”`), "the note does not name the folder");
    assert.match(await note.innerText(), /Some characters cannot be used in the name of a folder/);
    await shot("smoke-00-saved-as");

    await chooseOption(page, `Options for ${saved}`, "Delete");
    await dialogOf(page).getByRole("button", { name: "Delete subject" }).click();
    await dialogOf(page).waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
    assert.deepEqual(await tree(library), []);
  },
});

/** Steps of the last launch: no stand-in AI. Whatever this computer has; no request is sent. */
const realProviderSteps = [
  {
    name: "Settings lists every AI with what was really detected, and at most one blue button",
    async run({ page, shot }) {
      // A new launch of a finished profile: the app itself, not the first-run screen.
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      assert.equal(await page.getByTestId("first-run").count(), 0);
      await page.getByRole("navigation").getByRole("button", { name: /^Settings/ }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();

      const listed = await page.evaluate(() => globalThis.studiplan.providers.list());
      assert.deepEqual(listed.map((provider) => provider.label), ["Claude Code", "Codex", "Ollama", "API key"]);
      await until(
        async () => (await page.locator("[data-provider]").count()) === 4 && (await page.locator('[data-status="checking"]').count()) === 0,
        "the check of all four to finish",
        25_000,
      );
      const detected = await page.evaluate(() => globalThis.studiplan.providers.detectAll());
      for (const { id, detection } of detected) {
        const row = page.locator(`[data-provider="${id}"]`);
        // What the block says is what was found, whatever that is on this computer.
        assert.equal(await row.locator("[data-status]").first().getAttribute("data-status"), detection.status, id);
        assert.ok(detection.detail.length > 0);
      }
      // Free is the app; the AI is the student's own, paid as they already pay it.
      const intro = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
      assert.match(intro, /Studiplan is free and never charges for AI\. It makes everything with the AI you already have/);
      assert.match(intro, /You pay that provider as you already do\./);
      assert.doesNotMatch(intro, /free AI|AI is free|free (model|credits)/i);
      const theme = await assertTheme(page, "settings, four AIs");
      const settings = await page.evaluate(() => globalThis.studiplan.providers.getSettings());
      const ready = detected.filter((entry) => entry.detection.status === "ready").map((entry) => entry.id);
      // Filled only while nothing is chosen, on the first AI that is ready.
      const expected =
        settings.defaultProvider === null && ready.length > 0
          ? [`Use ${listed.find((provider) => provider.id === ready[0]).label}`]
          : [];
      assert.deepEqual(theme.filled, expected);
      await shot("smoke-36-settings-four");
    },
  },
  {
    name: "an API key is saved encrypted, never shown again, and can be removed",
    async run({ page, shot, userData }) {
      const row = page.locator('[data-provider="api-key"]');
      if ((await row.getByTestId("provider-details").count()) === 0) {
        await row.getByRole("button", { name: "Details of API key" }).click();
      }
      const keys = row.getByTestId("api-keys");
      await keys.waitFor();
      // No key, so no model to choose yet.
      assert.equal(await row.getByRole("button", { name: /Model/ }).count(), 0);
      // Words, not a link, about where a key is kept; nothing claims to be free of charge.
      assert.match(await keys.innerText(), /kept on this computer, encrypted by the operating system/);

      // Shaped like an OpenAI key, and not a real one. It is never sent anywhere in this test.
      // Put together here so that no text shaped like a key is in this file.
      const key = ["sk", "smoke", "test", "NOT-A-REAL-KEY".repeat(3)].join("-");

      // In the wrong field it is refused with the sentence from the main process.
      const google = keys.locator('[data-vendor="google"]');
      await google.getByLabel("Google", { exact: true }).fill(key);
      await google.getByRole("button", { name: "Save the Google key" }).click();
      await google.getByText(/This looks like a key from OpenAI, not from Google\./).waitFor();
      await google.getByLabel("Google", { exact: true }).fill("");

      const openai = keys.locator('[data-vendor="openai"]');
      await openai.getByLabel("OpenAI", { exact: true }).fill(key);
      await openai.getByRole("button", { name: "Save the OpenAI key" }).click();
      const outcome = await until(async () => {
        if ((await openai.getByText("A key is saved").count()) > 0) return "saved";
        if ((await openai.getByText(/cannot store the key safely/).count()) > 0) return "no-keychain";
        return null;
      }, "the key to be saved or refused");
      if (outcome === "no-keychain") {
        console.log("        (this computer has no keychain: the key was refused, as it should be)");
        return;
      }

      // The page no longer holds the key anywhere.
      const held = await page.evaluate(
        (text) => [...document.querySelectorAll("input")].some((input) => input.value.includes(text)) || document.body.innerText.includes(text),
        key,
      );
      assert.equal(held, false, "the key is still in the page");
      assert.equal(await openai.locator("input").count(), 0);
      assert.deepEqual(await page.evaluate(() => globalThis.studiplan.providers.apiKeyStatus()), { saved: ["openai"] });

      // On disk: one file for the key, and the key is not readable in it, nor in the settings.
      const file = join(userData, "api-key-openai.bin");
      assert.ok(existsSync(file), "no key file in the profile");
      assert.ok(!(await readFile(file)).includes(Buffer.from(key)), "the key is stored as plain text");
      assert.ok(!(await readFile(file)).includes(Buffer.from("smoke-test")), "the key is stored as plain text");
      const settingsFile = join(userData, "settings.json");
      if (existsSync(settingsFile)) assert.ok(!(await readFile(settingsFile, "utf8")).includes(key));

      // The block follows: it is ready now, and its models are the ones of the vendor with a key.
      await row.locator('[data-status="ready"]').waitFor();
      const models = await page.evaluate(() => globalThis.studiplan.providers.listModels("api-key"));
      assert.ok(models.length > 0 && models.every((model) => /OpenAI/.test(model.label)), JSON.stringify(models));
      await row.getByRole("button", { name: /Model/ }).waitFor();
      await openai.getByRole("button", { name: "Test the OpenAI key" }).waitFor();
      await assertTheme(page, "settings, key saved");
      await openai.scrollIntoViewIfNeeded();
      await shot("smoke-37-api-key-saved");

      // Remove: asked first, then gone from the profile.
      await openai.getByRole("button", { name: "Remove the OpenAI key" }).click();
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: "Remove the OpenAI key?" }).waitFor();
      assert.match(await dialog.innerText(), /removed from this computer\. It stays valid at OpenAI until you delete it there\./);
      await dialog.getByRole("button", { name: "Remove key" }).click();
      await dialog.waitFor({ state: "detached" });
      await openai.getByLabel("OpenAI", { exact: true }).waitFor();
      assert.ok(!existsSync(file), "the key file is still in the profile");
      assert.deepEqual(await page.evaluate(() => globalThis.studiplan.providers.apiKeyStatus()), { saved: [] });
      await row.locator('[data-status="not-signed-in"]').waitFor();
    },
  },
];

/**
 * @typedef {{ app: import("playwright-core").ElectronApplication, page: import("playwright-core").Page, shot: (name: string) => Promise<void>, library: string, fixtures: string }} StepContext
 * @type {Array<{ name: string, run: (ctx: StepContext) => Promise<void> }>}
 */
const steps = [
  {
    name: "after first run, the app opens on its empty state",
    async run({ page, shot, library }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor({ state: "visible" });
      assert.match((await page.getByRole("main").innerText()).replace(/\s+/g, " "), /Turn your study materials into .+, with your own AI, for free\./);
      assert.equal(await page.title(), "Studiplan");
      await page.getByRole("navigation").getByText("None yet").waitFor();
      assert.deepEqual(await tree(library), [], "a new library is not empty");
      const theme = await assertTheme(page, "first run");
      assert.deepEqual(theme.filled, ["New subject"], "the first-run action is not the accent button");
      await shot("smoke-01-first-run");
    },
  },
  {
    name: "the title bar is part of the app, the window opens at a sensible size, and the interface is at its scale",
    async run({ app, page }) {
      const bar = await assertTitleBar(page, "library");
      if (process.platform !== "linux") {
        // In the app proper the sidebar's head is the title bar on its side, and its rows are not.
        assert.equal(bar.sidebarHead, "drag", "the sidebar's head does not move the window");
        assert.notEqual(bar.aRow, "drag", "a row of the sidebar moves the window instead of acting");
        assert.ok(bar.strip.left > 0, "the strip does not start beside the sidebar");
      }
      // The window: inside the screen's work area, not below its minimum, and not maximised.
      const window = await app.evaluate(({ BrowserWindow, screen }) => {
        const [first] = BrowserWindow.getAllWindows();
        return {
          bounds: first.getNormalBounds(),
          minimum: first.getMinimumSize(),
          maximized: first.isMaximized(),
          area: screen.getDisplayMatching(first.getBounds()).workArea,
        };
      });
      assert.equal(window.maximized, false);
      assert.ok(window.bounds.width <= window.area.width && window.bounds.height <= window.area.height, JSON.stringify(window));
      assert.ok(window.bounds.width >= window.minimum[0] && window.bounds.height >= window.minimum[1], JSON.stringify(window));
      assert.ok(window.bounds.width <= 1600 && window.bounds.height <= 1000, `the window opens larger than it should: ${JSON.stringify(window.bounds)}`);

      // Everything is measured in rem, and one rem is 18px: the whole interface is a step up from 16.
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "18px");
    },
  },
  {
    name: "the sidebar says where the library is, with a button to change that",
    async run({ page, library }) {
      const sidebar = page.getByRole("navigation");
      assert.equal(resolve(await sidebar.getByTestId("sidebar-root").getAttribute("title")), resolve(library));
      // An icon with a name, no words of its own.
      const change = sidebar.getByRole("button", { name: "Change folder…" });
      // In this run the environment fixes the folder: the button is there, switched off, with the reason next to it.
      // It is switched off for assistive technology (`aria-disabled`), which is what is looked at
      // here; `isDisabled()` reads that too, and the attribute is checked by name as well.
      assert.equal(await change.isDisabled(), true);
      assert.ok(
        (await change.getAttribute("aria-disabled")) === "true" || (await change.getAttribute("disabled")) !== null,
        "the button to change the folder is not marked as switched off",
      );
      assert.match(await sidebar.getByTestId("sidebar-root-fixed").innerText(), /^Set from outside the app for this run, so it cannot be changed here\.$/);
    },
  },
  {
    name: "the bridge round trip shows main-process values in the page",
    async run({ app, page, library }) {
      // Read the truth directly in the main process, then compare with what the page gets.
      const expected = await app.evaluate(({ app }) => ({
        version: app.getVersion(),
        platform: process.platform,
        electron: process.versions.electron,
      }));
      const info = await page.evaluate(() => globalThis.studiplan.app.getInfo());
      assert.equal(info.version, expected.version);
      assert.equal(info.platform, expected.platform);
      assert.equal(info.electronVersion, expected.electron);

      // The library the page talks to is the throwaway one, and the page says where it is.
      const where = await page.evaluate(() => globalThis.studiplan.library.getInfo());
      assert.equal(where.ok, true);
      assert.equal(resolve(where.value.root), resolve(library));
      await page.getByRole("navigation").getByTitle(where.value.root).waitFor();
    },
  },
  {
    name: "the page is isolated from Node and Electron",
    async run({ page }) {
      const exposed = await page.evaluate(() => ({
        require: typeof globalThis.require,
        process: typeof globalThis.process,
        module: typeof globalThis.module,
        bridgeKeys: Object.keys(globalThis.studiplan ?? {}),
      }));
      assert.deepEqual(exposed, {
        require: "undefined",
        process: "undefined",
        module: "undefined",
        bridgeKeys: ["app", "library", "providers", "study", "tasks", "files", "events"],
      });
    },
  },
  {
    name: "the window is locked down",
    async run({ app, page }) {
      const prefs = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        const p = window.webContents.getLastWebPreferences();
        return {
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
          sandbox: p.sandbox,
          webviewTag: p.webviewTag,
          menuBarVisible: window.isMenuBarVisible(),
          windows: BrowserWindow.getAllWindows().length,
        };
      });
      assert.deepEqual(prefs, {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        menuBarVisible: false,
        windows: 1,
      });

      // New windows are refused, and only http(s) links reach the system browser.
      // shell.openExternal is stubbed so the test never opens the real browser.
      await app.evaluate(({ shell }) => {
        globalThis.__smokeOpened = [];
        shell.openExternal = async (url) => {
          globalThis.__smokeOpened.push(url);
        };
      });
      const before = page.url();
      await page.evaluate(() => {
        window.open("https://example.com/from-window-open");
        window.open("file:///C:/Windows/win.ini");
      });

      // Navigation away from the app is refused. The will-navigate event is sent to the real
      // handlers from the main process: starting a real navigation in the page and cancelling
      // it leaves Playwright waiting for a page load that never comes.
      const navigation = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        const attempt = (url) => {
          let prevented = false;
          const event = { preventDefault: () => (prevented = true) };
          window.webContents.emit("will-navigate", event, url);
          return prevented;
        };
        return {
          external: attempt("https://example.com/from-navigation"),
          otherFile: attempt("file:///C:/Windows/win.ini"),
          ownPage: attempt(window.webContents.getURL()),
        };
      });
      assert.deepEqual(navigation, { external: true, otherFile: true, ownPage: false });

      const after = await until(
        async () => {
          const state = await app.evaluate(({ BrowserWindow }) => ({
            windows: BrowserWindow.getAllWindows().length,
            opened: globalThis.__smokeOpened,
          }));
          return state.opened.length >= 2 ? state : null;
        },
        "both http(s) links to reach the stubbed browser",
      );
      assert.equal(page.url(), before, "the page navigated away from the app");
      assert.equal(after.windows, 1, "window.open created a window");
      assert.deepEqual(after.opened.sort(), [
        "https://example.com/from-navigation",
        "https://example.com/from-window-open",
      ]);
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
    },
  },
  {
    name: "deleting is kept out of the real Recycle Bin for this run",
    async run({ app, library }) {
      await keepOutOfRecycleBin(app, library);
    },
  },
  {
    name: "create a subject",
    async run({ page, library }) {
      await page.getByRole("main").getByRole("button", { name: "New subject" }).click();
      await dialogOf(page).getByRole("heading", { name: "New subject" }).waitFor();
      await submitName(page, SUBJECT);
      await page.getByRole("heading", { name: SUBJECT, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });
      await page.getByRole("option", { name: SUBJECT }).waitFor();
      await page.getByRole("heading", { name: "No materials yet" }).waitFor();
      assert.deepEqual(await tree(library), [SUBJECT]);
    },
  },
  {
    name: "the sidebar's rows share one shape, and each acts across its whole width",
    async run({ page, shot }) {
      const sidebar = page.getByRole("navigation");
      const rows = {
        subject: sidebar.getByRole("option", { name: SUBJECT }),
        newSubject: sidebar.getByRole("button", { name: "New subject" }),
        settings: sidebar.getByRole("button", { name: /^Settings/ }),
      };
      // One height, one left edge, one width; and what each row shows first (a name or an icon)
      // starts at the same place, under the app's name.
      const shapes = {};
      for (const [name, row] of Object.entries(rows)) {
        shapes[name] = await row.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
          let first = null;
          for (let node = walker.nextNode(); node && first === null; node = walker.nextNode()) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "") {
              const range = document.createRange();
              range.selectNodeContents(node);
              first = range.getBoundingClientRect().x;
            } else if (node.nodeName.toLowerCase() === "svg") first = node.getBoundingClientRect().x;
          }
          const style = getComputedStyle(element);
          return { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height), content: Math.round(first), radius: style.borderTopLeftRadius, cursor: style.cursor };
        });
      }
      assert.deepEqual(shapes.newSubject, shapes.subject, "New subject is not shaped like a subject's row");
      assert.deepEqual(shapes.settings, shapes.subject, "Settings is not shaped like a subject's row");
      assert.ok(shapes.subject.height >= 32, "the sidebar's rows are too low to press comfortably");
      const logoX = await sidebar.locator("img").evaluate((image) => Math.round(image.getBoundingClientRect().x));
      assert.equal(logoX, shapes.subject.content, "the logo does not start where the rows' text starts");
      // The logo keeps its own proportions (it is wider than tall) instead of being boxed into a square.
      const logo = await sidebar.locator("img").evaluate((image) => ({ shown: image.width / image.height, own: image.naturalWidth / image.naturalHeight }));
      assert.ok(Math.abs(logo.shown - logo.own) < 0.03, `the logo is shown at ${logo.shown}, its own ratio is ${logo.own}`);

      // The far right end of each row, where there is no text: the row answers the pointer there.
      const background = (row) => row.evaluate((element) => getComputedStyle(element).backgroundColor);
      for (const [name, row] of Object.entries({ newSubject: rows.newSubject, settings: rows.settings })) {
        await page.mouse.move(2, 2);
        const box = await row.boundingBox();
        const atRest = await until(async () => {
          const colour = await background(row);
          return (await row.evaluate((element) => !element.matches(":hover"))) ? colour : null;
        }, `${name} to be at rest`);
        await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
        await until(async () => (await background(row)) !== atRest, `${name} to highlight under the pointer at its right end`);
        if (name === "newSubject") await shot("smoke-02-sidebar-row-hover");
      }
      // And a press there does what the row says.
      const box = await rows.newSubject.boundingBox();
      await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
      await dialogOf(page).getByRole("heading", { name: "New subject" }).waitFor();
      await page.keyboard.press("Escape");
      await dialogOf(page).waitFor({ state: "detached" });
      await page.mouse.move(2, 2);
    },
  },
  {
    name: "a duplicate name is refused, in a sentence, with the dialog still open",
    async run({ page, shot, library }) {
      await page.getByRole("navigation").getByRole("button", { name: "New subject" }).click();
      await dialogOf(page).getByRole("heading", { name: "New subject" }).waitFor();
      await submitName(page, SUBJECT);
      const refusal = dialogOf(page).getByText(/already exists/);
      await refusal.waitFor();
      assert.match(await refusal.innerText(), /^A subject called .+ already exists\. .+\.$/);
      assert.equal(await dialogOf(page).getByRole("textbox").inputValue(), SUBJECT);
      await shot("smoke-02-name-refused");

      // Escape closes it, and nothing was created.
      await page.keyboard.press("Escape");
      await dialogOf(page).waitFor({ state: "detached" });
      assert.deepEqual(await tree(library), [SUBJECT]);
      assert.equal(await page.getByRole("option").count(), 1);
    },
  },
  {
    name: "create a material and land in it",
    async run({ page, shot, library }) {
      await page.getByRole("button", { name: "New material" }).click();
      await dialogOf(page).getByRole("heading", { name: "New material" }).waitFor();
      await submitName(page, MATERIAL);
      await page.getByRole("heading", { name: MATERIAL, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });
      await page.getByText("Drop files here, or press Add files").waitFor();

      const meta = await readJson(join(library, SUBJECT, MATERIAL, "material.json"));
      assert.equal(meta.title, MATERIAL);
      assert.deepEqual(meta.files, []);
      assert.ok(!Number.isNaN(Date.parse(meta.created)), "material.json has no usable created date");

      const theme = await assertTheme(page, "empty material");
      assert.deepEqual(theme.filled, ["Add files"]);
      await shot("smoke-03-material-empty");
    },
  },
  {
    name: "add a PDF, a .pptx, two photos and an unsupported file in one pick",
    async run({ page, shot, library, fixtures }) {
      // Progress is over quickly, so it is recorded as it happens rather than waited for.
      await page.evaluate(() => {
        globalThis.__smokeProgress = [];
        const note = () => {
          for (const bar of document.querySelectorAll('[role="progressbar"]')) {
            const text = bar.textContent ?? "";
            if (!globalThis.__smokeProgress.includes(text)) globalThis.__smokeProgress.push(text);
          }
        };
        globalThis.__smokeProgressObserver = new MutationObserver(note);
        globalThis.__smokeProgressObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });

      // The order of the pick: photos are not next to each other, and must still become one set.
      await page
        .locator('input[type="file"]')
        .setInputFiles(
          ["photo-a.png", "chapter-3.pdf", "recording.mp3", "slides.pptx", "photo-b.png"].map((name) =>
            join(fixtures, name),
          ),
        );

      // The report: what was turned away and why, next to what was added.
      const report = page.getByRole("alert").filter({ hasText: "was not added" });
      await report.waitFor();
      const reportText = await report.innerText();
      assert.match(reportText, /1 file was not added/);
      assert.match(reportText, /recording\.mp3/);
      assert.match(reportText, /\.mp3 files cannot be added\. Studiplan takes PDFs, PowerPoint files \(\.pptx\) and photos\./);
      assert.match(reportText, /Added to Cell division: 2 files and 2 photos\./);
      await shot("smoke-04-add-report");

      // The page lists three entries, in the order they were stored.
      const rows = page.getByRole("row").filter({ has: page.getByRole("button", { name: /^Remove / }) });
      await until(async () => (await rows.count()) === 3, "three file rows");
      const rowTexts = (await rows.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
      assert.match(rowTexts[0], /^chapter-3\.pdf PDF \d+ KB$/);
      assert.match(rowTexts[1], /^slides\.pptx PowerPoint \d+ KB$/);
      assert.match(rowTexts[2], /^notes-\S+ Photos · 2 pages [\d.]+ (KB|MB)$/);

      // Progress was shown while it ran: the photos one by one, and saving.
      const progress = await page.evaluate(() => {
        globalThis.__smokeProgressObserver.disconnect();
        return globalThis.__smokeProgress;
      });
      assert.ok(
        progress.some((text) => /Preparing photo \d of 2 for Cell division/.test(text)),
        `no photo progress was shown: ${JSON.stringify(progress)}`,
      );
      assert.ok(
        progress.some((text) => text.includes("Saving to Cell division")),
        `no saving progress was shown: ${JSON.stringify(progress)}`,
      );

      // On disk: the documents as they were, one photo set of two JPEG pages, and nothing else.
      const material = join(library, SUBJECT, MATERIAL);
      const stored = await tree(join(material, "files"));
      const photoSet = stored.find((name) => name.startsWith("notes-") && !name.includes("/"));
      assert.ok(photoSet, `no photo set folder in files/: ${stored.join(", ")}`);
      assert.deepEqual(stored, [
        "chapter-3.pdf",
        photoSet,
        `${photoSet}/page-1.jpg`,
        `${photoSet}/page-2.jpg`,
        "slides.pptx",
      ]);
      assert.deepEqual(
        await readFile(join(material, "files", "chapter-3.pdf")),
        await readFile(join(fixtures, "chapter-3.pdf")),
        "the PDF was changed on its way in",
      );
      assert.deepEqual(
        await readFile(join(material, "files", "slides.pptx")),
        await readFile(join(fixtures, "slides.pptx")),
        "the .pptx was changed on its way in",
      );

      // Pages are JPEGs, in the order picked, downscaled to at most 2000px and never enlarged.
      const sizes = [];
      for (const name of ["page-1.jpg", "page-2.jpg"]) {
        const bytes = await readFile(join(material, "files", photoSet, name));
        assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${name} is not a JPEG`);
        sizes.push(jpegSize(bytes));
      }
      assert.deepEqual(sizes, [
        { width: 2000, height: 1500 }, // photo-a.png, 2600 × 1950
        { width: 900, height: 1200 }, // photo-b.png, already small enough
      ]);

      const meta = await readJson(join(material, "material.json"));
      assert.deepEqual(meta.files, ["chapter-3.pdf", "slides.pptx", photoSet]);

      // The message can be put away; the files stay.
      await page.getByRole("button", { name: "Close this message" }).click();
      await report.waitFor({ state: "detached" });
      await shot("smoke-05-material-files");
    },
  },
  {
    name: "rename the material: the title changes and the folder follows",
    async run({ page, library }) {
      await chooseOption(page, `Options for ${MATERIAL}`, "Rename");
      await dialogOf(page).getByRole("heading", { name: "Rename material" }).waitFor();
      assert.equal(await dialogOf(page).getByRole("textbox").inputValue(), MATERIAL);
      await submitName(page, RENAMED);
      await page.getByRole("heading", { name: RENAMED, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });

      assert.deepEqual(await readdir(join(library, SUBJECT)), [RENAMED]);
      const meta = await readJson(join(library, SUBJECT, RENAMED, "material.json"));
      assert.equal(meta.title, RENAMED);
      assert.equal(meta.files.length, 3, "files were lost in the rename");
      // The files came along and are still listed.
      await until(
        async () => (await page.getByRole("button", { name: /^Remove / }).count()) === 3,
        "the renamed material to list its three files",
      );
    },
  },
  {
    name: "remove one file through its confirmation",
    async run({ app, page, library }) {
      await page.getByRole("button", { name: "Remove slides.pptx" }).click();
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: "Remove “slides.pptx”?" }).waitFor();
      assert.match(
        await dialog.innerText(),
        new RegExp(`moved to the ${binName()}\\. You can restore it from there\\. Your original file stays where it is\\.`),
      );
      await dialog.getByRole("button", { name: "Remove file", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Remove slides.pptx" }).waitFor({ state: "detached" });

      const material = join(library, SUBJECT, RENAMED);
      assert.ok(!existsSync(join(material, "files", "slides.pptx")), "the file is still on disk");
      assert.ok(existsSync(join(material, "files", "chapter-3.pdf")), "the wrong file was removed");
      const meta = await readJson(join(material, "material.json"));
      assert.equal(meta.files.length, 2);
      assert.ok(!meta.files.includes("slides.pptx"), "material.json still lists the removed file");

      const trashed = await app.evaluate(() => globalThis.__smokeTrashed);
      assert.deepEqual(trashed, [resolve(material, "files", "slides.pptx")]);
    },
  },
  {
    name: "back in the library, the material is listed with its files",
    async run({ page, shot }) {
      await page.getByRole("main").getByRole("button", { name: SUBJECT, exact: true }).click();
      await page.getByRole("heading", { name: SUBJECT, level: 1 }).waitFor();
      const row = page.getByRole("row").filter({ hasText: RENAMED });
      await row.waitFor();
      assert.match((await row.innerText()).replace(/\s+/g, " "), /^Mitosis 2 files \d{1,2} \w+ \d{4}/);
      // One date format everywhere, whatever the computer's own: day, month by name, year.
      assert.ok((await row.innerText()).includes(today()), `the date is not written as "${today()}"`);
      assert.match(await page.getByRole("option", { name: SUBJECT }).innerText(), /1\s*$/);

      const theme = await assertTheme(page, "library");
      assert.deepEqual(theme.filled, ["New material"]);
      await shot("smoke-06-library");
    },
  },
  {
    name: "a material that cannot be read shows the reason and a way back",
    async run({ page, shot, library }) {
      // A real failure rather than a stubbed one: the material's folder disappears from disk
      // behind the app's back (as when it is deleted in Explorer) while it is still listed.
      await page.getByRole("button", { name: "New material" }).click();
      await dialogOf(page).getByRole("heading", { name: "New material" }).waitFor();
      await submitName(page, "Gone");
      await page.getByRole("heading", { name: "Gone", level: 1 }).waitFor();
      await page.getByRole("main").getByRole("button", { name: SUBJECT, exact: true }).click();
      const row = page.getByRole("row").filter({ hasText: "Gone" });
      await row.waitFor();

      await rm(join(library, SUBJECT, "Gone"), { recursive: true });
      await row.click();
      const notice = page.getByRole("main").getByText("This material could not be opened");
      await notice.waitFor();
      // The sentence from the library is shown, and retrying is offered.
      const text = await page.getByRole("main").innerText();
      assert.match(text, /This material could not be opened\s+\S.+\./);
      await page.getByRole("button", { name: "Try again" }).waitFor();
      await shot("smoke-07-load-error");

      // Back in the library the list is read again and no longer shows it.
      await page.getByRole("main").getByRole("button", { name: SUBJECT, exact: true }).click();
      await page.getByRole("heading", { name: SUBJECT, level: 1 }).waitFor();
      await page.getByRole("row").filter({ hasText: RENAMED }).waitFor();
      await page.getByRole("row").filter({ hasText: "Gone" }).waitFor({ state: "detached" });
    },
  },
  {
    name: "delete the material through its confirmation",
    async run({ app, page, shot, library }) {
      await chooseOption(page, `Options for ${RENAMED}`, "Delete");
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: `Delete “${RENAMED}”?` }).waitFor();
      // It names what is inside and says where it goes.
      assert.match(
        await dialog.innerText(),
        new RegExp(`everything in it \\(2 files\\) will be moved to the ${binName()}\\. You can restore it from there\\.`),
      );
      // Focus starts on Cancel, so a stray Enter never deletes; the confirming button is red.
      await until(
        () => page.evaluate(() => document.activeElement?.textContent === "Cancel"),
        "focus to start on Cancel",
      );
      const colors = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--danger)";
        document.body.append(probe);
        const danger = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const confirm = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Delete material",
        );
        return { danger, confirm: confirm ? getComputedStyle(confirm).backgroundColor : null };
      });
      assert.equal(colors.confirm, colors.danger, "the confirming button is not the danger colour");
      await shot("smoke-08-delete-confirm");

      // Escape cancels and nothing is deleted.
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.ok(existsSync(join(library, SUBJECT, RENAMED)), "Escape deleted the material");

      await chooseOption(page, `Options for ${RENAMED}`, "Delete");
      await dialog.getByRole("button", { name: "Delete material" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("heading", { name: "No materials yet" }).waitFor();

      assert.deepEqual(await tree(library), [SUBJECT]);
      const trashed = await app.evaluate(() => globalThis.__smokeTrashed);
      assert.equal(trashed.at(-1), resolve(library, SUBJECT, RENAMED));
    },
  },
  {
    name: "delete the subject through its confirmation",
    async run({ app, page, library }) {
      await chooseOption(page, `Options for ${SUBJECT}`, "Delete");
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: `Delete “${SUBJECT}”?` }).waitFor();
      assert.match(
        await dialog.innerText(),
        new RegExp(`This empty subject will be moved to the ${binName()}\\. You can restore it from there\\.`),
      );
      await dialog.getByRole("button", { name: "Delete subject" }).click();
      await dialog.waitFor({ state: "detached" });

      // With no subject left, the app is back at its first-run state.
      await page.getByRole("heading", { name: "Start with a subject" }).waitFor();
      assert.equal(await page.getByRole("option").count(), 0);
      assert.deepEqual(await tree(library), []);
      const trashed = await app.evaluate(() => globalThis.__smokeTrashed);
      assert.equal(trashed.at(-1), resolve(library, SUBJECT));
    },
  },
  {
    name: "a second material gets a PDF, two decks and photos; the photo row shows its pages",
    async run({ page, shot, library, fixtures }) {
      await page.getByRole("main").getByRole("button", { name: "New subject" }).click();
      await submitName(page, SUBJECT_2);
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });
      await page.getByRole("button", { name: "New material" }).click();
      await submitName(page, MATERIAL_2);
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });

      await page
        .locator('input[type="file"]')
        .setInputFiles(
          ["chapter-3.pdf", "slides.pptx", "pictures.pptx", "photo-a.png", "photo-b.png"].map((name) =>
            join(fixtures, name),
          ),
        );
      await until(
        async () => (await page.getByRole("button", { name: /^Remove / }).count()) === 4,
        "four file rows",
      );
      const stored = await tree(join(library, SUBJECT_2, MATERIAL_2, "files"));
      assert.equal(stored.filter((name) => name.endsWith(".jpg")).length, 2);

      // The photo set's row shows its first pages, served by the app's own file scheme.
      const sources = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="row-thumbnails"] img')].map((image) => image.src),
      );
      assert.equal(sources.length, 2);
      for (const [index, source] of sources.entries()) {
        assert.match(source, new RegExp(`^studiplan-file://library/${SUBJECT_2}/${MATERIAL_2}/notes-[^/]+/page-${index + 1}\\.jpg$`));
      }
      assert.deepEqual(await loadedImages(page, '[data-testid="row-thumbnails"]', 2), [2000, 900]);
      await shot("smoke-09-file-rows");
    },
  },
  {
    name: "a PDF opens in place, in the built-in viewer",
    async run({ app, page, fixtures }) {
      await fileRow(page, "chapter-3.pdf").click();
      const preview = page.getByTestId("file-preview");
      await preview.getByRole("heading", { name: "chapter-3.pdf", level: 1 }).waitFor();

      const expected = `studiplan-file://library/${SUBJECT_2}/${MATERIAL_2}/chapter-3.pdf`;
      const frame = page.getByTestId("pdf-frame");
      await frame.waitFor();
      assert.equal(await frame.getAttribute("src"), `${expected}#navpanes=0`);
      assert.equal(await frame.getAttribute("sandbox"), null, "the PDF frame must not be sandboxed");

      // The frame really navigated to the file. What the viewer draws lives in frames of its
      // own process, which cannot be read from here; the screenshot shows it.
      const pdfFrame = await until(
        () => page.frames().find((candidate) => candidate.url().startsWith(expected)),
        "the frame to load the studiplan-file URL",
      );
      // The same URL, asked for from the main process: the scheme answers with the PDF itself.
      const served = await app.evaluate(async ({ session }, url) => {
        const response = await session.defaultSession.fetch(url);
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, type: response.headers.get("content-type"), base64: bytes.toString("base64") };
      }, expected);
      assert.equal(served.status, 200);
      assert.match(served.type ?? "", /^application\/pdf/);
      assert.deepEqual(Buffer.from(served.base64, "base64"), await readFile(join(fixtures, "chapter-3.pdf")));

      // The viewer drew the page: seen from outside, as pixels. Its dark background fills the
      // frame until then, so a good share of paper-white inside the frame means a page is showing.
      const box = await frame.boundingBox();
      assert.ok(box && box.width > 400 && box.height > 300, "the PDF frame has no room");
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      await until(
        () =>
          app.evaluate(async ({ BrowserWindow }, area) => {
            const [window] = BrowserWindow.getAllWindows();
            const bitmap = (await window.webContents.capturePage(area)).toBitmap();
            let white = 0;
            for (let at = 0; at < bitmap.length; at += 4) {
              if (bitmap[at] > 245 && bitmap[at + 1] > 245 && bitmap[at + 2] > 245) white += 1;
            }
            return white / (bitmap.length / 4) > 0.15;
          }, rect),
        "the viewer to draw the PDF's page",
      );
      assert.ok(pdfFrame.url().startsWith(expected));
      await assertTheme(page, "PDF preview");
      // Taken by the window itself: the viewer's frames belong to another process.
      const picture = await app.evaluate(async ({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        return (await window.webContents.capturePage()).toPNG().toString("base64");
      });
      await writeFile(join(artifacts, "smoke-10-preview-pdf.png"), Buffer.from(picture, "base64"));

      // One way back, to the material, with its files still listed.
      await preview.getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      await fileRow(page, "chapter-3.pdf").waitFor();
    },
  },
  {
    name: "a photo set opens as a grid, then page by page with the arrow keys",
    async run({ page, shot }) {
      await fileRow(page, /^notes-/).click();
      const preview = page.getByTestId("file-preview");
      await preview.getByRole("button", { name: "Open page 1" }).waitFor();
      assert.equal(await preview.getByRole("button", { name: /^Open page \d+$/ }).count(), 2);
      assert.deepEqual(await loadedImages(page, '[data-testid="file-preview"]', 2), [2000, 900]);
      await shot("smoke-11-preview-photos");

      await preview.getByRole("button", { name: "Open page 1" }).click();
      await preview.getByText("Page 1 of 2").waitFor();
      assert.deepEqual(await loadedImages(page, '[data-testid="file-preview"]', 1), [2000]);
      assert.equal(await preview.getByRole("button", { name: "Previous page" }).isDisabled(), true);

      // Fitted to the area first; "Actual size" shows every pixel and the area scrolls.
      const shownWidth = () => page.getByTestId("photo-large").evaluate((image) => image.getBoundingClientRect().width);
      const fitted = await shownWidth();
      await preview.getByRole("button", { name: "Actual size" }).focus();
      await page.keyboard.press("Enter");
      await preview.getByRole("button", { name: "Fit to window" }).waitFor();
      assert.equal(Math.round(await shownWidth()), 2000);
      const scrolls = await page.getByTestId("photo-stage").evaluate((stage) => stage.scrollWidth > stage.clientWidth && stage.scrollHeight > stage.clientHeight);
      assert.equal(scrolls, true, "the full-size photo cannot be scrolled");
      await shot("smoke-12-photo-actual-size");
      // A click on the photo does the same as the button.
      await page.getByTestId("photo-large").click();
      await preview.getByRole("button", { name: "Actual size" }).waitFor();
      assert.equal(Math.round(await shownWidth()), Math.round(fitted));

      await page.keyboard.press("ArrowRight");
      await preview.getByText("Page 2 of 2").waitFor();
      assert.deepEqual(await loadedImages(page, '[data-testid="file-preview"]', 1), [900]);
      assert.equal(await preview.getByRole("button", { name: "Next page" }).isDisabled(), true);
      // The whole page is shown, not a crop of it.
      const fit = await page.getByTestId("photo-large").evaluate((image) => getComputedStyle(image).objectFit);
      assert.equal(fit, "contain");
      await shot("smoke-12-preview-photo-page");

      await page.keyboard.press("ArrowLeft");
      await preview.getByText("Page 1 of 2").waitFor();

      // Escape steps back: to the grid, then to the material.
      await page.keyboard.press("Escape");
      await preview.getByRole("button", { name: "Open page 2" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "a .pptx opens as the text of its slides, and says that is what it is",
    async run({ page, shot }) {
      await fileRow(page, "slides.pptx").click();
      const text = page.getByTestId("slide-text");
      await text.waitFor();
      const shown = (await text.innerText()).replace(/\s+/g, " ");
      assert.match(shown, /This is the text of the 3 slides and the speaker notes, not the slides themselves\./);
      assert.match(shown, /Slide 1 Phases of mitosis Prophase: chromosomes condense Metaphase: they line up in the middle Speaker notes Ask the class which phase is the longest\./);
      assert.match(shown, /Slide 2 Anaphase and telophase/);
      assert.match(shown, /Slide 3 Cytokinesis divides the cell itself\./);
      assert.deepEqual(await text.getByRole("heading", { level: 2 }).allInnerTexts().then((all) => all.map((h) => h.replace(/\s+/g, " "))), [
        "Slide 1 Phases of mitosis",
        "Slide 2 Anaphase and telophase",
        "Slide 3",
      ]);
      // It is text: nothing from the file became markup.
      assert.equal(await text.locator("script, iframe, img, a").count(), 0);
      await assertTheme(page, "slide text");
      await shot("smoke-13-preview-slides");
      await page.getByTestId("file-preview").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();

      // Slides with nothing but pictures: said plainly, not shown as a breakdown.
      await fileRow(page, "pictures.pptx").click();
      const problem = page.getByTestId("text-error");
      await problem.waitFor();
      await problem.getByRole("heading", { name: "These slides have no text" }).waitFor();
      assert.match((await problem.innerText()).replace(/\s+/g, " "), /These slides have no text \S.+\.$/);
      assert.equal(await page.getByTestId("slide-text").count(), 0);
      await shot("smoke-14-preview-no-text");
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "a photo set is turned into a PDF that says it is the same pages, and cannot be made twice",
    async run({ page, shot, library }) {
      const files = join(library, SUBJECT_2, MATERIAL_2, "files");
      const set = (await readdir(files)).find((name) => name.startsWith("notes-"));
      // Offered on the photo set's row and on no other.
      const turn = page.getByRole("button", { name: /^Turn .+ into a PDF$/ });
      assert.equal(await turn.count(), 1);
      assert.equal(await turn.getAttribute("aria-label"), `Turn ${set} into a PDF`);
      await turn.click();
      const made = page.getByTestId("pdf-made");
      await made.waitFor();
      assert.match((await made.innerText()).replace(/\s+/g, " "), /was added It has the same pages as the photos in notes-\S+\. The photos are what your AI reads; this PDF is for you to keep, share or print\./);

      // In the material: the PDF directly after its set, each knowing the other.
      const listed = await page.evaluate(
        ([subject, material]) => globalThis.studiplan.library.getMaterial({ subject, material }).then((result) => result.value.files),
        [SUBJECT_2, MATERIAL_2],
      );
      const at = listed.findIndex((file) => file.name === set);
      const pdfFile = listed[at + 1];
      assert.equal(listed[at].pdf, pdfFile.name);
      assert.equal(pdfFile.kind, "pdf");
      assert.equal(pdfFile.madeFrom, set);
      // On disk: a real PDF, next to the photos, which are untouched.
      const bytes = await readFile(join(files, pdfFile.name));
      assert.equal(bytes.subarray(0, 4).toString("latin1"), "%PDF");
      assert.equal((await readdir(join(files, set))).length, 2);

      // On screen: the PDF's row hangs under its set and says what it is; the set says it has one.
      const rows = page.getByRole("row").filter({ has: page.getByRole("button", { name: /^Remove / }) });
      const names = await rows.evaluateAll((all) => all.map((row) => row.querySelector(".font-medium")?.textContent));
      assert.equal(names[names.indexOf(set) + 1], pdfFile.name, `the PDF is not listed directly after its set: ${names.join(", ")}`);
      const pdfRow = page.getByRole("row").filter({ has: page.locator(`[data-made-from="${set}"]`) });
      assert.match((await pdfRow.innerText()).replace(/\s+/g, " "), new RegExp(`PDF of ${set} · same pages as the photos`));
      const setRow = page.getByRole("row").filter({ has: page.getByTestId("row-thumbnails") });
      assert.match((await setRow.innerText()).replace(/\s+/g, " "), /Photos · 2 pages · also as a PDF/);
      // It is a file on disk, so it counts as one.
      await page.getByRole("heading", { name: "Files" }).getByText("5 files").waitFor();

      // It cannot be made a second time: the button is gone, and the library refuses.
      assert.equal(await turn.count(), 0);
      const again = await page.evaluate(
        ([subject, material, name]) => globalThis.studiplan.library.photoSetToPdf({ subject, material }, name),
        [SUBJECT_2, MATERIAL_2, set],
      );
      assert.equal(again.ok, false);
      assert.equal(again.error.code, "already-exists");
      assert.match(again.error.message, /\S.+\./);
      assert.equal((await readdir(files)).filter((name) => name.endsWith(".pdf") && name.startsWith("notes-")).length, 1);
      await page.mouse.move(2, 2);
      await assertTheme(page, "files with a photo set and its PDF");
      await shot("smoke-14-photo-set-pdf");
      await made.getByRole("button", { name: "Close this message" }).click();

      // Opened, it says what it is instead of being called a scan with no text.
      await pdfRow.click();
      const note = page.getByTestId("pdf-from-photos");
      await note.waitFor();
      assert.equal((await note.innerText()).replace(/\s+/g, " "), "Made from your photos. The photos are what your AI reads; this PDF is for you to keep, share or print.");
      await page.getByTestId("pdf-frame").waitFor();
      await until(
        () => page.evaluate(([subject, material, name]) => globalThis.studiplan.library.extractText({ subject, material }, name).then((r) => !r.ok), [SUBJECT_2, MATERIAL_2, pdfFile.name]),
        "the PDF's text to have been looked for",
      );
      assert.equal(await page.getByTestId("pdf-no-text").count(), 0, "the PDF of the photos is called a scan with no text");
      await shot("smoke-14-photo-set-pdf-preview");
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "Open folder shows the material's folder in the file manager",
    async run({ app, page, library }) {
      // Stubbed, so the test never opens a real Explorer window.
      await app.evaluate(({ shell }) => {
        globalThis.__smokeFolders = [];
        shell.openPath = async (target) => {
          globalThis.__smokeFolders.push(target);
          return "";
        };
      });
      await chooseOption(page, `Options for ${MATERIAL_2}`, "Open folder");
      const opened = await until(async () => {
        const folders = await app.evaluate(() => globalThis.__smokeFolders);
        return folders.length > 0 ? folders : null;
      }, "the folder to be opened");
      assert.deepEqual(opened.map((folder) => resolve(folder)), [resolve(library, SUBJECT_2, MATERIAL_2)]);
    },
  },
  {
    name: "with no AI chosen, Make leads to Settings instead of failing",
    async run({ page, shot }) {
      const sidebar = page.getByRole("navigation");
      // No AI has been chosen in a new profile, and the sidebar says so quietly.
      await sidebar.getByRole("button", { name: /^Settings/ }).getByText("No AI yet").waitFor();
      const needs = page.getByTestId("make-needs-ai");
      await needs.waitFor();
      assert.equal(await page.getByTestId("make").getByRole("button", { name: /^Make / }).count(), 0);
      assert.deepEqual((await assertTheme(page, "material, no AI")).filled, ["Connect your AI"]);
      assert.match(await needs.innerText(), /Studiplan is free and works with your own AI\./);
      await shot("smoke-15-make-needs-ai");
      await needs.getByRole("button", { name: "Connect your AI" }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
    },
  },
  {
    name: "Settings shows what was detected, and the folder that cannot be changed in this run",
    async run({ app, page, shot, library }) {
      const sidebar = page.getByRole("navigation");
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await page.getByRole("heading", { name: "Connect your AI" }).waitFor();

      // This run's only AI is the Test AI (STUDIPLAN_FAKE_AI): it stands in for Claude Code, is
      // always ready, and never sends a request anywhere.
      const listed = await page.evaluate(() => globalThis.studiplan.providers.list());
      assert.deepEqual(listed.map((provider) => provider.label), ["Test AI"]);
      const row = page.locator('[data-provider="claude-code"]');
      await row.getByRole("heading", { name: /Test AI/ }).waitFor();
      const status = row.locator("[data-status]");
      await until(async () => (await status.getAttribute("data-status")) !== "checking", "the check to finish");
      const detected = await page.evaluate(() => globalThis.studiplan.providers.detectAll());
      const claude = detected.find((entry) => entry.id === "claude-code");
      assert.ok(claude, "the Test AI is not among the detected providers");
      assert.ok(["ready", "not-installed", "not-signed-in", "error"].includes(claude.detection.status));
      assert.equal(await status.getAttribute("data-status"), claude.detection.status);
      assert.ok(claude.detection.detail.length > 0);
      assert.ok((await status.innerText()).includes(claude.detection.detail), "the detected sentence is not shown");
      // Free is the app; the AI is the student's own, paid as they already pay it.
      const intro = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
      assert.match(intro, /Studiplan is free and never charges for AI\. It makes everything with the AI you already have/);
      assert.match(intro, /You pay that provider as you already do\./);
      assert.doesNotMatch(intro, /free AI|AI is free|free (model|credits)/i);
      // Only providers this build has are listed.
      assert.equal(await page.locator("[data-provider]").count(), listed.length);

      // The library folder: shown, and fixed for this run because the environment sets it.
      assert.equal(resolve(await page.getByTestId("library-root").innerText()), resolve(library));
      await page.getByText(/set from outside the app for this run \(STUDIPLAN_LIBRARY_DIR\)/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Change…" }).isDisabled(), true);
      await app.evaluate(() => (globalThis.__smokeFolders = []));
      await page.getByRole("main").getByRole("button", { name: "Open folder" }).click();
      const opened = await until(async () => {
        const folders = await app.evaluate(() => globalThis.__smokeFolders);
        return folders.length > 0 ? folders : null;
      }, "the library folder to be opened");
      assert.deepEqual(opened.map((folder) => resolve(folder)), [resolve(library)]);

      // Blue only where something needs doing: choosing an AI, when one is ready and none is chosen.
      const ready = claude.detection.status === "ready";
      const theme = await assertTheme(page, "settings");
      assert.equal(ready, true, "the Test AI is not ready");
      assert.deepEqual(theme.filled, ["Use Test AI"]);
      await shot("smoke-16-settings");

      // The head of an AI is a row: pressed anywhere along it (not only on its arrow) it folds
      // and opens the details; its own buttons do not.
      const head = row.getByTestId("provider-head");
      const details = row.getByTestId("provider-details");
      const wasOpen = (await details.count()) === 1;
      // Measured before each press: folding the details makes the screen shorter, and the row moves.
      const pressHead = async () => {
        await head.scrollIntoViewIfNeeded();
        const box = await head.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      await pressHead();
      await until(async () => ((await details.count()) === 1) !== wasOpen, "a press on the head to fold or open the details");
      await pressHead();
      await until(async () => ((await details.count()) === 1) === wasOpen, "a second press to put the details back");
      assert.equal(await row.getByRole("button", { name: "Details of Test AI" }).getAttribute("aria-expanded"), String(wasOpen));
      await page.mouse.move(2, 2);

      // Choosing it is one click, costs no request, and is remembered.
      await row.getByRole("button", { name: "Use Test AI" }).click();
      assert.equal((await details.count()) === 1, wasOpen, "pressing Use also folded the row");
      await row.getByText("Used for new results").waitFor();
      await sidebar.getByText("No AI yet").waitFor({ state: "detached" });
      const saved = await page.evaluate(() => globalThis.studiplan.providers.getSettings());
      assert.equal(saved.defaultProvider, "claude-code");
      assert.deepEqual((await assertTheme(page, "settings, AI chosen")).filled, []);

      // Test: the reply and how long it took, from the same button a real AI answers through.
      await row.getByRole("button", { name: "Test", exact: true }).click();
      const reply = row.getByTestId("test-result");
      await reply.getByText("It works. Test AI answered:").waitFor();
      assert.match((await reply.innerText()).replace(/\s+/g, " "), /“The Test AI is ready\..+” .+ · its own default model/);

      // A model name can be typed: lists go stale. A name that cannot be one is refused in place.
      const picker = row.getByRole("button", { name: /Model/ });
      await picker.click();
      await page.getByRole("option", { name: "Another model…" }).click();
      const typed = row.getByRole("textbox", { name: "Model name" });
      await typed.fill("not a model");
      await typed.press("Enter");
      await row.getByText(/That is not a usable model name\./).waitFor();
      await typed.fill("my-model:1");
      await typed.press("Enter");
      await typed.waitFor({ state: "detached" });
      await until(
        async () => (await page.evaluate(() => globalThis.studiplan.providers.getSettings())).models["claude-code"] === "my-model:1",
        "the typed model to be saved",
      );
      assert.match(await picker.innerText(), /my-model:1/);
      await shot("smoke-16-settings-ai-chosen");

      // The way back leads to where the user was: the open material.
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "a material without files explains what Make needs; Add files is the blue button",
    async run({ page, shot }) {
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      // By keyboard: Ctrl+N asks for a new material, Enter creates it, and the new screen's
      // heading has the focus, so Tab starts at its top.
      await page.keyboard.press("Control+n");
      await dialogOf(page).getByRole("heading", { name: "New material" }).waitFor();
      await submitName(page, "Empty");
      await page.getByRole("heading", { name: "Empty", level: 1 }).waitFor();
      await dialogOf(page).waitFor({ state: "detached" });
      await until(
        () => page.evaluate(() => document.activeElement?.tagName === "H1" && document.activeElement.textContent === "Empty"),
        "focus to land on the new screen's heading",
      );

      const needs = page.getByTestId("make-needs-files");
      await needs.waitFor();
      assert.match(await needs.innerText(), /^Add files first\./);
      assert.equal(await page.getByTestId("make").count(), 0, "Make is offered without files");
      await page.getByTestId("results-empty").waitFor();
      assert.deepEqual((await assertTheme(page, "material without files")).filled, ["Add files"]);
      await shot("smoke-17-make-needs-files");

      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await openMaterial(page, MATERIAL_2);
    },
  },
  {
    name: "Make offers six kinds in read, learn, test and the free request; the Make button stays where it is",
    async run({ page, shot }) {
      const make = page.getByTestId("make");
      await make.waitFor();
      const groups = await make.locator("[data-make-group]").evaluateAll((all) =>
        all.map((group) => [group.getAttribute("data-make-group"), [...group.querySelectorAll("button")].map((button) => button.textContent.trim())]),
      );
      assert.deepEqual(groups, [
        ["Read", ["Summary", "Explain it", "Cheat sheet"]],
        ["Learn", ["Flashcards"]],
        ["Test", ["Practice test"]],
        ["Or ask", ["Your own request"]],
      ]);
      // A quiz and a mock exam are no longer made.
      assert.equal(await make.getByText("Quiz", { exact: true }).count(), 0);
      assert.equal(await make.getByText("Mock exam", { exact: true }).count(), 0);

      const expected = {
        Summary: ["Make summary", /The material in short/, ["Short", "Medium", "Long"]],
        "Explain it": ["Make explanation", /A walkthrough in plain words, for when you missed the lesson\./, []],
        "Cheat sheet": ["Make cheat sheet", /One page of key terms, formulas and must-knows\./, []],
        Flashcards: ["Make flashcards", /Cards with a question on the front/, ["10 cards", "20 cards", "40 cards"]],
        "Practice test": [
          "Make practice test",
          /Questions like in an exam, marked with explanations\./,
          ["Quick · about 10 questions", "Standard · about 20", "Full exam · about 30", "With written questions", "Multiple choice only"],
        ],
      };
      const buttonTops = [];
      for (const [label, [action, hint, choices]] of Object.entries(expected)) {
        await chooseKind(page, label);
        const button = make.getByRole("button", { name: action, exact: true });
        await button.waitFor();
        assert.match(await make.getByTestId("make-hint").innerText(), hint);
        const offered = await make.getByTestId("make-options").getByRole("radio").evaluateAll((all) => all.map((radio) => radio.textContent.trim()));
        assert.deepEqual(offered, choices, `the choices of ${label}`);
        // A kind with nothing to choose says so, in the place the choice would be.
        if (choices.length === 0) await make.getByTestId("make-options").getByText("As long as your material needs.").waitFor();
        assert.deepEqual((await assertTheme(page, `make: ${label}`)).filled, [action]);
        buttonTops.push(Math.round((await button.boundingBox()).y));
        await shot(`smoke-18-make-${label.toLowerCase().replace(/\s+/g, "-")}`);
      }
      assert.equal(new Set(buttonTops).size, 1, `the Make button moves between kinds: ${buttonTops.join(", ")}`);
      // A practice test starts as a standard one with written questions.
      const chosen = await make.getByTestId("make-options").locator('[role="radio"][aria-checked="true"]').evaluateAll((all) => all.map((radio) => radio.textContent.trim()));
      assert.deepEqual(chosen, ["Standard · about 20", "With written questions"]);
      await chooseKind(page, "Summary");
    },
  },
  {
    name: "make a summary: progress, a file in sets/, a row in Results, the reader",
    async run({ page, shot, library }) {
      const make = page.getByTestId("make");
      await make.waitFor();
      // With files and an AI, making is the point of the screen: the one blue button.
      assert.deepEqual((await assertTheme(page, "material with files")).filled, ["Make summary"]);
      assert.match(await make.innerText(), /With Test AI \(my-model:1\)\./);
      // The material holds photos and the PDF made from them: only the photos go to the AI.
      assert.match(await page.getByTestId("make-pdf-not-sent").innerText(), /The PDF of your photos is not sent again\./);
      await page.getByTestId("results-empty").waitFor();
      await shot("smoke-18-make");

      await recordProgress(page);
      await make.getByRole("button", { name: "Make summary" }).click();
      const outcome = page.getByTestId("make-outcome");
      await outcome.getByText("is saved in Results").waitFor();
      const progress = await recordedProgress(page);
      assert.ok(progress.some((text) => text.includes("Making a summary")), `no progress title: ${JSON.stringify(progress)}`);
      assert.ok(
        progress.some((text) => /Reading the files…|Asking Test AI…|Checking the answer…|Saving…/.test(text)),
        `no progress sentence from the main process: ${JSON.stringify(progress)}`,
      );

      // On disk: one Markdown file in sets/, holding what the AI answered.
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const files = await readdir(sets);
      assert.equal(files.length, 1);
      assert.match(files[0], /^\d{4}-\d{2}-\d{2}-summary\.md$/);
      const text = await readFile(join(sets, files[0]), "utf8");
      assert.match(text, /## The cell cycle/);
      assert.match(text, /Test AI|claude-code/);

      // In the list: what it is, who made it, and that it is the new one.
      const row = page.locator(`[data-result="${files[0]}"]`);
      await row.waitFor();
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      assert.match(rowText, /New/);
      assert.match(rowText, /Summary · Medium/);
      assert.match(rowText, /Test AI/);
      assert.match(rowText, /\d{1,2} \w+ \d{4}/);
      assert.deepEqual((await assertTheme(page, "after making")).filled, ["Make summary"]);
      await shot("smoke-19-made-summary");

      // Open, from the message: the reader shows the document as headings and a list.
      await outcome.getByRole("button", { name: "Open" }).click();
      await page.getByRole("heading", { name: "The cell cycle" }).waitFor();
      const reader = (await page.getByRole("main").innerText()).replace(/\s+/g, " ");
      assert.match(reader, /Summary · .*Made \d{1,2} \w+ \d{4} with /);
      assert.match(reader, /Interphase: the cell grows \(G1\)/);
      assert.doesNotMatch(reader, /\*\*|## /, "Markdown is showing as characters");
      await shot("smoke-20-summary-reader");

      // Settings and back returns to the result; its way back leads to the material.
      await page.getByRole("navigation").getByRole("button", { name: /^Settings/ }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await page.getByRole("heading", { name: "The cell cycle" }).waitFor();
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      await row.waitFor();
    },
  },
  {
    name: "Explain it and Cheat sheet: each is saved as its own kind and read in a reader that suits it",
    async run({ page, shot, library }) {
      const make = page.getByTestId("make");
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const outcome = page.getByTestId("make-outcome");
      const backToMaterial = async () => {
        await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
        await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      };

      // An explanation: a walkthrough, in the reading column a summary has.
      await chooseKind(page, "Explain it");
      await recordProgress(page);
      await make.getByRole("button", { name: "Make explanation" }).click();
      await outcome.getByText("is saved in Results").waitFor();
      assert.ok((await recordedProgress(page)).some((text) => text.includes("Making an explanation")));
      const explained = (await readdir(sets)).find((name) => /^\d{4}-\d{2}-\d{2}-explain\.md$/.test(name));
      assert.ok(explained, "no explanation in sets/");
      assert.match(await readFile(join(sets, explained), "utf8"), /## What a cell does before it divides/);
      assert.match((await page.locator(`[data-result="${explained}"]`).innerText()).replace(/\s+/g, " "), /Explanation/);
      await outcome.getByRole("button", { name: "Open" }).click();
      await page.getByRole("heading", { name: "What a cell does before it divides" }).waitFor();
      assert.match((await page.getByRole("main").innerText()).replace(/\s+/g, " "), /Explanation · Made \d{1,2} \w+ \d{4} with /);
      assert.equal(await page.locator('article[data-reader="reading"]').count(), 1);
      assert.equal(await page.locator("article ol > li").count(), 2, "the numbered question and its answer are not lists");
      await assertTheme(page, "explanation");
      await shot("smoke-20-explanation");
      await backToMaterial();

      // A cheat sheet: tables as tables, a formula as code, in the denser, wider reader.
      await chooseKind(page, "Cheat sheet");
      await make.getByRole("button", { name: "Make cheat sheet" }).click();
      await outcome.getByText("is saved in Results").waitFor();
      const sheet = (await readdir(sets)).find((name) => /^\d{4}-\d{2}-\d{2}-cheatsheet\.md$/.test(name));
      assert.ok(sheet, "no cheat sheet in sets/");
      assert.match((await page.locator(`[data-result="${sheet}"]`).innerText()).replace(/\s+/g, " "), /Cheat sheet/);
      await outcome.getByRole("button", { name: "Open" }).click();
      await page.getByRole("heading", { name: "Key terms" }).waitFor();
      assert.match((await page.getByRole("main").innerText()).replace(/\s+/g, " "), /Cheat sheet · Made \d{1,2} \w+ \d{4} with /);
      const reader = page.locator('article[data-reader="dense"]');
      assert.equal(await reader.count(), 1);
      const tables = await reader.locator("table").evaluateAll((all) =>
        all.map((table) => ({
          header: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
          rows: table.querySelectorAll("tbody tr").length,
          fits: table.getBoundingClientRect().width <= table.parentElement.getBoundingClientRect().width + 1,
        })),
      );
      assert.deepEqual(tables, [
        { header: ["Term", "Meaning"], rows: 2, fits: true },
        { header: ["Formula", "Symbols", "Use"], rows: 1, fits: true },
      ]);
      // The formula is code, with its characters as written; the bold term is bold, not asterisks.
      assert.deepEqual(await reader.locator("td code").allInnerTexts(), ["N = 2ⁿ"]);
      assert.equal(await reader.locator("td strong").first().innerText(), "Interphase");
      assert.doesNotMatch(await reader.innerText(), /\||\*\*|`/, "Markdown is showing as characters");
      // Denser than a summary: a smaller size of type and a wider column.
      const widths = await reader.evaluate((article) => ({ font: parseFloat(getComputedStyle(article).fontSize), max: parseFloat(getComputedStyle(article).maxWidth) }));
      assert.ok(widths.font < 18 && widths.max > 37 * 18, JSON.stringify(widths));
      await assertTheme(page, "cheat sheet");
      await shot("smoke-20-cheat-sheet");
      await backToMaterial();
    },
  },
  {
    name: "make flashcards with a chosen size, flip, mark and reach the end",
    async run({ page, shot, library }) {
      const make = page.getByTestId("make");
      await chooseKind(page, "Flashcards");
      // Three sizes, the middle one chosen; another is one click.
      await make.getByText("20 cards", { exact: true }).waitFor();
      await make.getByText("10 cards", { exact: true }).click();
      assert.deepEqual((await assertTheme(page, "flashcards chosen")).filled, ["Make flashcards"]);
      await make.getByRole("button", { name: "Make flashcards" }).click();
      await page.getByTestId("make-outcome").getByText("is saved in Results").waitFor();

      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const file = (await readdir(sets)).find((name) => /-flashcards\.json$/.test(name));
      assert.ok(file, "no flashcards file in sets/");
      const saved = await readJson(join(sets, file));
      assert.equal(saved.kind, "flashcards");
      assert.equal(saved.content.cards.length, 3);

      const row = page.locator(`[data-result="${file}"]`);
      assert.match((await row.innerText()).replace(/\s+/g, " "), /Flashcards · 3 cards/);
      await row.click();
      const player = page.getByRole("region", { name: "Flashcards" });
      await player.getByText("Card 1 of 3").waitFor();
      await player.getByText("What does the Test AI stand in for?").first().waitFor();
      await shot("smoke-21-flashcards");

      // All by keyboard, from the first moment: the card has the focus, so Space flips it, and
      // flips it back, without a click or a Tab first.
      await until(
        () => page.evaluate(() => document.activeElement?.getAttribute("aria-keyshortcuts") === "Space"),
        "the first card to have the focus",
      );
      await page.keyboard.press("Space");
      await player.getByText("A real AI, while the app is being tested.").first().waitFor();
      await page.keyboard.press("Space");
      await player.getByText("What does the Test AI stand in for?").first().waitFor();
      await player.getByText("Card 1 of 3").waitFor();
      // Shuffle is not what Tab reaches first from the card: the next stop is under the card.
      await page.keyboard.press("Tab");
      const next = await page.evaluate(() => document.activeElement?.textContent ?? "");
      assert.doesNotMatch(next, /Shuffle/, "Tab from the card lands on Shuffle");
      await page.evaluate(() => document.querySelector('[aria-keyshortcuts="Space"]')?.focus());

      // Flip the first card and mark it; then go through the rest with the keyboard.
      await player.getByRole("button", { name: "Show answer" }).click();
      await player.getByText("A real AI, while the app is being tested.").first().waitFor();
      await player.getByRole("button", { name: "Again" }).click();
      await player.getByText("Card 2 of 3").waitFor();
      await page.keyboard.press("Space");
      await player.getByText("The S phase.").first().waitFor();
      await page.keyboard.press("2");
      await player.getByText("Card 3 of 3").waitFor();
      await page.keyboard.press("Space");
      await page.keyboard.press("2");
      await player.getByRole("heading", { name: "You got 2 of 3" }).waitFor();
      await player.getByRole("button", { name: "Redo the one you missed" }).waitFor();
      await assertTheme(page, "flashcards, end of round");
      await shot("smoke-22-flashcards-end");

      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "make a practice test, answer it, submit and see the score; a quiz of an earlier version still opens",
    async run({ page, shot, library }) {
      await chooseKind(page, "Practice test");
      await page.getByTestId("make").getByRole("button", { name: "Make practice test" }).click();
      await page.getByTestId("make-outcome").getByText("is saved in Results").waitFor();
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const file = (await readdir(sets)).find((name) => /-test\.json$/.test(name));
      assert.ok(file, "no practice test in sets/");
      const saved = await readJson(join(sets, file));
      assert.equal(saved.kind, "test");
      assert.equal(saved.content.questions.length, 3);
      assert.deepEqual([saved.content.length, saved.content.written], ["standard", true]);

      const row = page.locator(`[data-result="${file}"]`);
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      assert.match(rowText, /Practice test · 3 questions/);
      assert.match(rowText, /Standard · with written questions/);
      await row.click();
      const quiz = page.getByRole("region", { name: "Practice test" });
      await quiz.getByText("0 of 3 answered").waitFor();
      // The line under the title says what kind of test it is.
      assert.match(
        (await page.getByRole("main").innerText()).replace(/\s+/g, " "),
        /Practice test · Standard · 3 questions · 4 points · with written questions · Made /,
      );
      await quiz.getByText("0 of 3 answered").waitFor();

      // A result screen is left with its back button only (Escape would throw a round away),
      // so that button is the first thing Tab reaches from the heading; the questions follow.
      await until(() => page.evaluate(() => document.activeElement?.tagName === "H1"), "the heading to have the focus");
      await page.keyboard.press("Escape");
      await quiz.getByText("0 of 3 answered").waitFor();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), MATERIAL_2);
      await until(async () => {
        await page.keyboard.press("Tab");
        return page.evaluate(() => document.activeElement?.getAttribute("type") === "radio");
      }, "Tab to reach the first question's options");

      // The options are not in the order of the file (where the stand-in, like a real model,
      // has them fixed), and nothing is lost or added by the reordering.
      const inFile = saved.content.questions.map((question) => question.options);
      const shownOptions = () =>
        quiz.locator('[role="radiogroup"]').evaluateAll((groups) =>
          groups.map((group) => [...group.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "").filter(Boolean)),
        );
      const firstOrder = await shownOptions();
      assert.equal(firstOrder.length, 2);
      firstOrder.forEach((options, index) => {
        assert.deepEqual([...new Set(options)].sort(), [...inFile[index]].sort(), "options were lost or added");
        assert.notDeepEqual([...new Set(options)], inFile[index], "the options are in the file's order");
      });

      // A radio is round, everywhere: the theme says so, not the quiz.
      const radius = await quiz.locator(".radio__control").first().evaluate((control) => {
        const style = getComputedStyle(control);
        return parseFloat(style.borderTopLeftRadius) >= control.getBoundingClientRect().width / 2;
      });
      assert.equal(radius, true, "the radio is not round");

      await quiz.getByText("S phase", { exact: true }).click();
      await quiz.getByText("Four haploid cells", { exact: true }).click();
      await quiz.getByRole("textbox").fill("The surface grows more slowly than the volume.");
      await quiz.getByText("3 of 3 answered").waitFor();
      await shot("smoke-23-practice-test");
      await quiz.getByRole("button", { name: "Submit" }).click();

      // One right, one wrong, one written answer still to mark by the student.
      await quiz.getByText("Your score so far").waitFor();
      await quiz.getByText("1 / 4").waitFor();
      assert.match(await quiz.innerText(), /The DNA is replicated in the S \(synthesis\) phase\./);
      await quiz.getByRole("radio", { name: "2", exact: true }).or(quiz.getByRole("button", { name: "2", exact: true })).first().click();
      await quiz.getByText("3 / 4").waitFor();
      await quiz.getByText("Your score", { exact: true }).waitFor();
      await page.evaluate(() => document.querySelector("main .scrollbar")?.scrollTo(0, 0));
      await shot("smoke-24-practice-test-score");

      // Retake: the right answer is right wherever it now stands. Chosen by its text, both
      // multiple-choice questions score, and the written one waits to be marked.
      await quiz.getByRole("button", { name: "Retake" }).first().click();
      await quiz.getByText("0 of 3 answered").waitFor();
      await quiz.getByText("S phase", { exact: true }).click();
      await quiz.getByText("Two identical diploid cells", { exact: true }).click();
      await quiz.getByRole("button", { name: "Submit" }).click();
      await quiz.getByRole("button", { name: "Submit anyway" }).click();
      await quiz.getByText("2 / 4").waitFor();
      assert.equal(await quiz.getByText("Your answer, correct").count(), 2);

      // A quiz made by an earlier version of the app: its file is still listed and still opens,
      // under its old name, although a quiz can no longer be made.
      const old = { ...saved, kind: "quiz", title: "Old quiz", created: "2026-09-30T10:00:00.000Z", content: { questions: saved.content.questions } };
      await writeFile(join(sets, OLD_QUIZ), JSON.stringify(old, null, 2));
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      const oldRow = page.locator(`[data-result="${OLD_QUIZ}"]`);
      await oldRow.waitFor();
      assert.match((await oldRow.innerText()).replace(/\s+/g, " "), /Old quiz .*Quiz · 3 questions/);
      await oldRow.click();
      await page.getByRole("region", { name: "Quiz" }).getByText("0 of 3 answered").waitFor();
      assert.match((await page.getByRole("main").innerText()).replace(/\s+/g, " "), /Quiz · 3 questions · 4 points · Made 30 Sep 2026/);
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "a practice test of multiple choice only has no written question, and says so",
    async run({ page, shot, library }) {
      const make = page.getByTestId("make");
      await chooseKind(page, "Practice test");
      await make.getByText("Quick · about 10 questions", { exact: true }).click();
      await make.getByText("Multiple choice only", { exact: true }).click();
      await shot("smoke-24-practice-test-options");
      await make.getByRole("button", { name: "Make practice test" }).click();
      await page.getByTestId("make-outcome").getByText("is saved in Results").waitFor();
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const file = (await readdir(sets)).find((name) => /-test-2\.json$/.test(name));
      assert.ok(file, "no second practice test in sets/");
      const saved = await readJson(join(sets, file));
      assert.deepEqual([saved.content.length, saved.content.written], ["quick", false]);
      assert.deepEqual(saved.content.questions.map((question) => question.type), ["multiple_choice", "multiple_choice"]);
      const row = page.locator(`[data-result="${file}"]`);
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      assert.match(rowText, /Practice test · 2 questions/);
      assert.match(rowText, /Quick · multiple choice only/);
      await row.click();
      const test = page.getByRole("region", { name: "Practice test" });
      await test.getByText("0 of 2 answered").waitFor();
      assert.equal(await test.getByRole("textbox").count(), 0, "a multiple-choice test has a field to write in");
      assert.match((await page.getByRole("main").innerText()).replace(/\s+/g, " "), /Practice test · Quick · 2 questions · multiple choice only · Made /);
      // Nothing to mark by hand: the score is final as soon as it is submitted.
      await test.getByText("S phase", { exact: true }).click();
      await test.getByText("Two identical diploid cells", { exact: true }).click();
      await test.getByRole("button", { name: "Submit" }).click();
      await test.getByText("Your score", { exact: true }).waitFor();
      await test.getByText("2 / 2").waitFor();
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
  {
    name: "“Your own request” takes a request and saves a result that shows it",
    async run({ page, shot, library }) {
      const make = page.getByTestId("make");
      await chooseKind(page, "Your own request");
      const confirm = make.getByRole("button", { name: "Make it" });
      assert.equal(await confirm.isDisabled(), true, "an empty request can be sent");
      // Too long a request is said in numbers, and cannot be sent.
      await make.getByRole("textbox", { name: "What should it make?" }).fill("x".repeat(2001));
      await make.getByText("That is 2001 characters. Keep it under 2000.").waitFor();
      assert.equal(await confirm.isDisabled(), true, "a request that is too long can be sent");
      const request = "A timeline of the cell cycle, one line per phase";
      await make.getByRole("textbox", { name: "What should it make?" }).fill(request);
      assert.deepEqual((await assertTheme(page, "something else")).filled, ["Make it"]);
      await shot("smoke-25-something-else");
      await confirm.click();
      await page.getByTestId("make-outcome").getByText("is saved in Results").waitFor();

      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const file = (await readdir(sets)).find((name) => /-custom\.md$/.test(name));
      assert.ok(file, "no note in sets/");
      assert.ok((await readFile(join(sets, file), "utf8")).includes(request), "the request is not saved with the note");

      await page.getByTestId("make-outcome").getByRole("button", { name: "Open" }).click();
      await page.getByText("You asked:").waitFor();
      assert.ok((await page.getByRole("main").innerText()).includes(request));
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();

      // Every kind that was made, newest first, and the old quiz, which is older than all of them.
      const kinds = await page.evaluate(
        ([subject, material]) =>
          globalThis.studiplan.study.list({ subject, material }).then((list) => list.value.map((item) => item.kind)),
        [SUBJECT_2, MATERIAL_2],
      );
      assert.deepEqual(kinds, ["custom", "test", "test", "flashcards", "cheatsheet", "explain", "summary", "quiz"]);
      const shown = await page.locator("[data-result]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-result")));
      assert.deepEqual(
        shown.map((name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, "")),
        ["custom.md", "test-2.json", "test.json", "flashcards.json", "cheatsheet.md", "explain.md", "summary.md", "quiz.json"],
      );
      // Made on the same day, so each row also says when: that is what tells two summaries apart.
      const whens = await page
        .locator(`[data-result]:not([data-result="${OLD_QUIZ}"])`)
        .evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
      // What a row calls the kinds: a request is "Your request", no longer a "Note".
      assert.match(await page.locator('[data-result$="-custom.md"]').innerText(), /Your request/);
      for (const when of whens) {
        assert.match(when, new RegExp(`${today()}, \\d{2}:\\d{2}`), `no time of day in: ${when}`);
      }
      await page.getByTestId("make-outcome").getByRole("button", { name: "Close this message" }).click();
      await shot("smoke-26-results");
    },
  },
  {
    name: "rename a result and delete one; the library counts what is left",
    async run({ app, page, library }) {
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const names = await readdir(sets);
      const summary = names.find((name) => name.endsWith("-summary.md"));
      const cards = names.find((name) => name.endsWith("-flashcards.json"));

      const summaryRow = page.locator(`[data-result="${summary}"]`);
      await summaryRow.getByRole("button", { name: /^Options for / }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await dialogOf(page).getByRole("heading", { name: "Rename result" }).waitFor();
      await submitName(page, "Cell cycle in short");
      await dialogOf(page).waitFor({ state: "detached" });
      await summaryRow.getByText("Cell cycle in short").waitFor();
      // The file keeps its name and its content; only the title changed.
      assert.deepEqual((await readdir(sets)).sort(), names.sort());
      const text = await readFile(join(sets, summary), "utf8");
      assert.match(text, /Cell cycle in short/);
      assert.match(text, /## The cell cycle/);

      const cardsRow = page.locator(`[data-result="${cards}"]`);
      await cardsRow.getByRole("button", { name: /^Options for / }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: /^Delete “.+”\?$/ }).waitFor();
      assert.match(
        await dialog.innerText(),
        new RegExp(`This result will be moved to the ${binName()}\\. You can restore it from there\\. The material's files stay\\.`),
      );
      await dialog.getByRole("button", { name: "Delete result" }).click();
      await dialog.waitFor({ state: "detached" });
      await cardsRow.waitFor({ state: "detached" });
      assert.ok(!existsSync(join(sets, cards)), "the result is still on disk");
      assert.equal((await readdir(sets)).length, names.length - 1);
      const trashed = await app.evaluate(() => globalThis.__smokeTrashed);
      assert.equal(trashed.at(-1), resolve(sets, cards));
      // Three documents, the photo set with its two pages, and the PDF made from it.
      assert.equal((await tree(join(library, SUBJECT_2, MATERIAL_2, "files"))).length, 7, "files were touched");

      // The library row counts files and results.
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      const row = page.getByRole("row").filter({ hasText: MATERIAL_2 });
      await row.waitFor();
      // The PDF of the photo set is a file like the others, and is counted as one.
      assert.match((await row.innerText()).replace(/\s+/g, " "), new RegExp(`^Waves 5 files · ${names.length - 1} results `));
      await openMaterial(page, MATERIAL_2);
    },
  },
  {
    name: "a result that was damaged outside the app says so, and can still be deleted",
    async run({ page, shot, library }) {
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const quiz = (await readdir(sets)).find((name) => name.endsWith("-quiz.json"));
      const row = page.locator(`[data-result="${quiz}"]`);
      await row.waitFor();

      // Damaged while the list still shows it as fine: opening it says what is wrong.
      await writeFile(join(sets, quiz), '{ "kind": "quiz", "content": ');
      await row.click();
      const problem = page.getByTestId("study-error");
      await problem.getByText("This result could not be opened").waitFor();
      assert.match((await problem.innerText()).replace(/\s+/g, " "), /This result could not be opened \S.+\./);
      await shot("smoke-27-result-unreadable");

      // Back in the material the list is read again: the row carries the reason and cannot be opened.
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      await row.waitFor();
      const listed = await page.evaluate(
        ([subject, material]) => globalThis.studiplan.study.list({ subject, material }).then((list) => list.value),
        [SUBJECT_2, MATERIAL_2],
      );
      const broken = listed.find((item) => item.name === quiz);
      assert.ok(broken.problem, "the damaged file is listed without a problem");
      assert.ok((await row.innerText()).includes(broken.problem), "the row does not say what is wrong");
      await row.click();
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
      assert.equal(await page.getByTestId("study-error").count(), 0, "a damaged result was opened");
      await shot("smoke-28-result-problem-row");

      await row.getByRole("button", { name: /^Options for / }).click();
      assert.equal(await page.getByRole("menuitem", { name: "Rename", exact: true }).count(), 0);
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      await dialogOf(page).getByRole("button", { name: "Delete result" }).click();
      await dialogOf(page).waitFor({ state: "detached" });
      await row.waitFor({ state: "detached" });
      assert.ok(!existsSync(join(sets, quiz)));
    },
  },
  {
    name: "removing the photo set says its PDF stays, and the PDF is then an ordinary file",
    async run({ page, shot, library }) {
      const files = join(library, SUBJECT_2, MATERIAL_2, "files");
      const set = (await readdir(files)).find((name) => name.startsWith("notes-") && !name.endsWith(".pdf"));
      const pdfName = (await readdir(files)).find((name) => name.startsWith("notes-") && name.endsWith(".pdf"));
      await page.evaluate(() => document.querySelector("main .scrollbar")?.scrollTo(0, 0));
      await page.getByRole("button", { name: `Remove ${set}`, exact: true }).click();
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: `Remove “${set}”?` }).waitFor();
      assert.match(
        (await dialog.innerText()).replace(/\s+/g, " "),
        /Its PDF stays\. From then on it is read by your AI like any other file: a scan, which Claude Code and an AI used with an API key can read up to 20 pages of\./,
      );
      await shot("smoke-28-remove-photo-set");
      await dialog.getByRole("button", { name: "Remove file", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("button", { name: `Remove ${set}`, exact: true }).waitFor({ state: "detached" });

      assert.ok(!existsSync(join(files, set)), "the photo set is still on disk");
      assert.ok(existsSync(join(files, pdfName)), "the PDF went with the photos");
      const listed = await page.evaluate(
        ([subject, material]) => globalThis.studiplan.library.getMaterial({ subject, material }).then((result) => result.value.files),
        [SUBJECT_2, MATERIAL_2],
      );
      const pdfFile = listed.find((file) => file.name === pdfName);
      assert.equal(pdfFile.madeFrom, undefined, "the PDF still says it was made from a set that is gone");
      // On screen it is a file like the others: no link to a set, nothing about photos near Make.
      assert.equal(await page.locator("[data-made-from]").count(), 0);
      assert.doesNotMatch(await fileRow(page, pdfName).innerText(), /same pages as the photos/);
      assert.equal(await page.getByTestId("make-pdf-not-sent").count(), 0);
      await page.getByRole("heading", { name: "Files" }).getByText("4 files").waitFor();
      // And its preview now says what is true of it: a scan, with no text to read.
      await fileRow(page, pdfName).click();
      await page.getByTestId("pdf-no-text").waitFor();
      assert.equal(await page.getByTestId("pdf-from-photos").count(), 0);
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
    },
  },
];

/** Nothing clipped and no sideways scroll, at the smallest window and at a large one. */
const sizeSteps = [
  {
    name: "the smallest and a large window: nothing is cut off, nothing scrolls sideways",
    async run({ app, page, shot }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      const resize = (width, height) =>
        app.evaluate(({ BrowserWindow }, [w, h]) => {
          const [window] = BrowserWindow.getAllWindows();
          const before = window.getContentSize();
          window.setContentSize(w, h);
          return before;
        }, [width, height]);
      const overflow = () =>
        page.evaluate(() => {
          const wide = (element) => element.scrollWidth > element.clientWidth + 1;
          return {
            page: wide(document.documentElement),
            parts: [...document.querySelectorAll("main .scrollbar, main table, main [data-testid]")]
              // (React Aria keeps a hidden native select for form autofill; it is not on screen.)
              .filter((element) => element.getAttribute("data-testid") !== "hidden-select-container")
              .filter(wide)
              .map((element) => element.getAttribute("data-testid") ?? element.className.toString().slice(0, 60)),
          };
        });
      // The smallest the window can be made, and a large one.
      const [minWidth, minHeight] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
      const before = await resize(minWidth, minHeight);
      try {
        for (const [width, height, label] of [
          [minWidth, minHeight, "small"],
          [1600, 1000, "large"],
        ]) {
          await resize(width, height);
          await until(() => page.evaluate((w) => globalThis.innerWidth === w, width), `the window to be ${width} wide`);
          // Back to the subject's list from wherever the last step or round ended.
          for (let level = 0; level < 3; level++) {
            if ((await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).count()) > 0) break;
            await page.getByRole("main").getByRole("button").first().click();
          }
          await openMaterial(page, MATERIAL_2);
          await page.locator("[data-result]").first().waitFor();
          assert.deepEqual(await overflow(), { page: false, parts: [] }, `material, ${label} window`);
          await assertTitleBar(page, `material, ${label} window`);
          await page.getByRole("heading", { name: "Results" }).scrollIntoViewIfNeeded();
          await shot(`smoke-29-${label}-material`);
          await page.getByRole("navigation").getByRole("button", { name: /^Settings/ }).click();
          await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
          await page.locator("[data-status]:not([data-status='checking'])").first().waitFor();
          assert.deepEqual(await overflow(), { page: false, parts: [] }, `settings, ${label} window`);
          await shot(`smoke-29-${label}-settings`);
          await page.keyboard.press("Escape");
          await page.getByRole("heading", { name: MATERIAL_2, level: 1 }).waitFor();
          await page.locator("[data-result]").first().click();
          await page.getByRole("main").getByRole("heading", { level: 1 }).waitFor();
          assert.deepEqual(await overflow(), { page: false, parts: [] }, `study, ${label} window`);
          await shot(`smoke-29-${label}-study`);
        }
      } finally {
        await resize(before[0], before[1]);
      }
    },
  },
];

/** Steps of the second launch: the Test AI takes several seconds and can be cancelled. */
const slowSteps = [
  {
    name: "what was chosen in Settings is still chosen after a restart",
    async run({ page }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      const saved = await page.evaluate(() => globalThis.studiplan.providers.getSettings());
      assert.deepEqual(saved, { defaultProvider: "claude-code", models: { "claude-code": "my-model:1" } });
      await page.getByRole("navigation").getByRole("button", { name: /^Settings/ }).click();
      const row = page.locator('[data-provider="claude-code"]');
      await row.getByText("Used for new results").waitFor();
      assert.match(await row.getByRole("button", { name: /Model/ }).innerText(), /my-model:1/);
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
    },
  },
  {
    name: "slow AI: progress stays while looking elsewhere; Cancel leaves no file",
    async run({ page, shot, library }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await openMaterial(page, MATERIAL_2);
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const before = (await readdir(sets)).sort();

      const make = page.getByTestId("make");
      await make.getByRole("button", { name: "Make summary" }).click();
      const progress = page.getByTestId("make-progress");
      await progress.getByText("Making a summary").waitFor();
      await progress.getByText(/Asking Test AI…/).waitFor();
      await progress.getByRole("button", { name: "Cancel" }).waitFor();
      // Nothing else can be made meanwhile, and the screen has no blue button to press.
      assert.equal(await make.getByRole("button", { name: "Make summary" }).count(), 0);
      assert.deepEqual((await assertTheme(page, "generating")).filled, []);
      const running = await page.evaluate(() => globalThis.studiplan.study.current());
      assert.equal(running?.kind, "summary");
      await shot("smoke-30-generating");

      // Settings and back: the generation belongs to the app, not to the screen.
      await page.getByRole("navigation").getByRole("button", { name: /^Settings/ }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await progress.getByText("Making a summary").waitFor();

      await progress.getByRole("button", { name: "Cancel" }).click();
      const outcome = page.getByTestId("make-outcome");
      await outcome.getByText("Cancelled. Nothing was saved.").waitFor();
      assert.equal(await outcome.getAttribute("role"), "status", "a cancel is shown as an error");
      await make.getByRole("button", { name: "Make summary" }).waitFor();
      assert.deepEqual((await readdir(sets)).sort(), before, "a cancelled run left a file");
      assert.equal(await page.evaluate(() => globalThis.studiplan.study.current()), null);
      await shot("smoke-31-cancelled");
    },
  },
  {
    name: "slow AI: another material says what is being made and where",
    async run({ page, shot, library, fixtures }) {
      // A second material with a file, so its Make section is the full one.
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await openMaterial(page, "Empty");
      await page.locator('input[type="file"]').setInputFiles([join(fixtures, "chapter-3.pdf")]);
      await page.getByTestId("make").waitFor();
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await openMaterial(page, MATERIAL_2);

      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).click();
      await page.getByTestId("make-progress").getByText("Making a summary").waitFor();
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await openMaterial(page, "Empty");
      const elsewhere = page.getByTestId("make-progress");
      await elsewhere.getByText(`A summary is being made in “${MATERIAL_2}”`).waitFor();
      await elsewhere.getByText("One result is made at a time.").waitFor();
      assert.equal(await page.getByTestId("make").getByRole("button", { name: /^Make / }).count(), 0);
      await shot("smoke-32-generating-elsewhere");

      // Left alone, it finishes: Make comes back here, and the file is in the other material.
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).waitFor();
      const made = await readdir(join(library, SUBJECT_2, MATERIAL_2, "sets"));
      assert.equal(made.filter((name) => name.includes("-summary")).length, 2);
      assert.deepEqual(await tree(join(library, SUBJECT_2, "Empty", "sets")), []);
    },
  },
];

/** Still the slow Test AI: what the frame shows about a generation, and deleting during one. */
const frameSteps = [
  {
    name: "a scanned PDF says it has no readable text; a file added twice is said to be a second copy",
    async run({ app, page, shot, library, fixtures }) {
      await page.getByRole("main").getByRole("button").first().click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      await openMaterial(page, "Empty");
      // chapter-3.pdf is in this material already; the scan is new.
      await page.locator('input[type="file"]').setInputFiles([join(fixtures, "chapter-3.pdf"), join(fixtures, "scan.pdf"), join(fixtures, "partly.pdf")]);
      const copies = page.getByTestId("second-copies");
      await copies.waitFor();
      const stored = await tree(join(library, SUBJECT_2, "Empty", "files"));
      const copy = stored.find((name) => /^chapter-3-\d+\.pdf$/.test(name));
      assert.ok(copy, `no second copy on disk: ${stored.join(", ")}`);
      assert.equal(
        (await copies.innerText()).trim(),
        `“chapter-3.pdf” was already here, so a second copy was added as “${copy}”.`,
      );
      await shot("smoke-33-second-copy");

      await fileRow(page, /^scan.pdf/).click();
      const note = page.getByTestId("pdf-no-text");
      await note.waitFor();
      const said = (await note.innerText()).replace(/\s+/g, " ");
      assert.match(said, /This PDF has no text Studiplan can read\./);
      assert.match(said, /can read a scan of up to 20 pages; .+ Adding photos of the pages always works\./);
      // The viewer still shows the pages: the scan's grey block is drawn inside the frame. Seen
      // from outside, as pixels, and the picture is taken by the window itself.
      const box = await page.getByTestId("pdf-frame").boundingBox();
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      await until(
        () =>
          app.evaluate(async ({ BrowserWindow }, area) => {
            const [window] = BrowserWindow.getAllWindows();
            const bitmap = (await window.webContents.capturePage(area)).toBitmap();
            // The fixture's pages are white paper with one mid-grey block, on the viewer's dark ground.
            let dark = 0;
            let grey = 0;
            for (let at = 0; at < bitmap.length; at += 4) {
              const [b, g, r] = [bitmap[at], bitmap[at + 1], bitmap[at + 2]];
              if (b < 90 && g < 90 && r < 90) dark += 1;
              else if (b > 105 && b < 150 && g > 105 && g < 150 && r > 105 && r < 150) grey += 1;
            }
            const pixels = bitmap.length / 4;
            return dark / pixels > 0.03 && grey / pixels > 0.05;
          }, rect),
        "the viewer to draw the scanned PDF",
      );
      const picture = await app.evaluate(async ({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        return (await window.webContents.capturePage()).toPNG().toString("base64");
      });
      await writeFile(join(artifacts, "smoke-33-scan-preview.png"), Buffer.from(picture, "base64"));
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: "Empty", level: 1 }).waitFor();

      // A PDF that is partly a scan says how much of it is, and is not called textless.
      await fileRow(page, "partly.pdf").click();
      const partly = page.getByTestId("pdf-partly-scanned");
      await partly.waitFor();
      assert.match(
        (await partly.innerText()).replace(/\s+/g, " "),
        /^Mostly a scan: 3 of 4 pages are pictures with no readable text\. .+ Adding photos of those pages always works\.$/,
      );
      assert.equal(await page.getByTestId("pdf-no-text").count(), 0);
      await shot("smoke-33-partly-scanned");
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: "Empty", level: 1 }).waitFor();

      // A PDF with text has no such note.
      await page.getByRole("row").filter({ hasText: /^chapter-3\.pdf/ }).first().click();
      await page.getByTestId("pdf-frame").waitFor();
      await until(
        () =>
          page.evaluate(() =>
            globalThis.studiplan.library.extractText({ subject: "Physics", material: "Empty" }, "chapter-3.pdf").then((r) => r.ok),
          ),
        "the text of the PDF to be read",
      );
      assert.equal(await page.getByTestId("pdf-no-text").count(), 0);
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: "Empty", level: 1 }).waitFor();
    },
  },
  {
    name: "the sidebar goes to the subject from a material and a result, shows what is being made, and keeps its outcome",
    async run({ page, shot, library }) {
      const sidebar = page.getByRole("navigation");
      // From a material: the marked subject is still a way to its list.
      await sidebar.getByRole("option", { name: SUBJECT_2 }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      await openMaterial(page, MATERIAL_2);
      const before = (await readdir(join(library, SUBJECT_2, MATERIAL_2, "sets"))).length;
      // From a result, too.
      await page.locator("[data-result]").first().click();
      await page.getByRole("main").getByRole("button", { name: MATERIAL_2, exact: true }).waitFor();
      await sidebar.getByRole("option", { name: SUBJECT_2 }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      // And from Settings.
      await sidebar.getByRole("button", { name: /^Settings/ }).click();
      await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
      await sidebar.getByRole("option", { name: SUBJECT_2 }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();

      // Start a summary, then leave for the list: the frame says what is being made, with Cancel.
      await openMaterial(page, MATERIAL_2);
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).click();
      await page.getByTestId("make-progress").waitFor();
      await sidebar.getByRole("option", { name: SUBJECT_2 }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      const status = page.getByTestId("generation-status");
      await status.getByText(`Making a summary in “${MATERIAL_2}”`).waitFor();
      await status.getByRole("button", { name: "Cancel" }).waitFor();
      await shot("smoke-33-making-in-sidebar");

      // It ends while the student is elsewhere: the outcome waits in the same place.
      await status.getByText(`A summary is saved in “${MATERIAL_2}”`).waitFor();
      assert.equal((await readdir(join(library, SUBJECT_2, MATERIAL_2, "sets"))).length, before + 1);
      await shot("smoke-33-made-in-sidebar");
      await status.getByRole("button", { name: "Open" }).click();
      await page.getByRole("heading", { name: "The cell cycle" }).waitFor();
      await status.waitFor({ state: "detached" });
      await sidebar.getByRole("option", { name: SUBJECT_2 }).click();
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
    },
  },
  {
    name: "deleting a material while something is made from it says so, stops it, and saves nothing",
    async run({ app, page, shot, library }) {
      await keepOutOfRecycleBin(app, library);
      await openMaterial(page, "Empty");
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).click();
      await page.getByTestId("make-progress").getByText(/Asking Test AI…/).waitFor();

      await chooseOption(page, "Options for Empty", "Delete");
      const dialog = dialogOf(page);
      await dialog.getByRole("heading", { name: "Delete “Empty”?" }).waitFor();
      assert.match(
        (await dialog.innerText()).replace(/\s+/g, " "),
        /A summary is being made from it right now\. Deleting stops that, and nothing is saved from it\./,
      );
      await shot("smoke-33-delete-while-making");
      await dialog.getByRole("button", { name: "Delete material" }).click();
      await dialog.waitFor({ state: "detached" });

      // Back on the list, without it; nothing is running, nothing is announced, nothing was saved.
      await page.getByRole("heading", { name: SUBJECT_2, level: 1 }).waitFor();
      await page.getByRole("row").filter({ hasText: "Empty" }).waitFor({ state: "detached" });
      await until(async () => (await page.evaluate(() => globalThis.studiplan.study.current())) === null, "the generation to stop");
      assert.equal(await page.getByTestId("generation-status").count(), 0);
      assert.ok(!existsSync(join(library, SUBJECT_2, "Empty")), "the material is still on disk");

      // And something can be made again at once, in another material.
      await openMaterial(page, MATERIAL_2);
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).waitFor();
      assert.equal(await page.getByTestId("make-progress").count(), 0);
      assert.equal(await page.getByTestId("make-outcome").count(), 0);
    },
  },
];

/** Still the slow Test AI: the window is reloaded while a result is being made. */
const reloadSteps = [
  {
    name: "a window reloaded mid-generation stops it cleanly: nothing running, nothing half-saved",
    async run({ page, shot, library }) {
      await page.getByRole("main").getByRole("button", { name: SUBJECT_2, exact: true }).click();
      await openMaterial(page, MATERIAL_2);
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const before = (await readdir(sets)).sort();
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).click();
      await page.getByTestId("make-progress").getByText(/Asking Test AI…/).waitFor();

      // The main process stops every running call when its page goes away, so the new page
      // finds nothing running and can make something at once.
      await page.reload();
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await until(async () => (await page.evaluate(() => globalThis.studiplan.study.current())) === null, "nothing to be running");
      await openMaterial(page, MATERIAL_2);
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).waitFor();
      assert.equal(await page.getByTestId("make-progress").count(), 0);
      assert.deepEqual((await readdir(sets)).sort(), before, "a stopped run left a file");
      await shot("smoke-33-after-reload");
    },
  },
];

/** Steps of the launch where the Test AI's first answer of every generation is unusable. */
const retrySteps = [
  {
    name: "an answer that fails the check is asked for once more, and the second is saved",
    async run({ page, shot, library }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await openMaterial(page, MATERIAL_2);
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const before = (await readdir(sets)).length;
      await chooseKind(page, "Flashcards");
      await recordProgress(page);
      await page.getByTestId("make").getByRole("button", { name: "Make flashcards" }).click();
      await page.getByTestId("make-outcome").getByText("is saved in Results").waitFor();
      const progress = await recordedProgress(page);
      assert.ok(
        progress.some((text) => text.includes("The first answer could not be used. Asking Test AI once more…")),
        `the second attempt was not said: ${JSON.stringify(progress)}`,
      );
      assert.equal((await readdir(sets)).length, before + 1);
      await shot("smoke-34-retried");
    },
  },
];

/** Steps of the last launch: the Test AI refuses with the usage-limit sentence. */
const limitSteps = [
  {
    name: "a usage limit is said in a sentence, and nothing is saved",
    async run({ page, shot, library }) {
      await page.getByTestId("app-shell").waitFor({ state: "visible" });
      await openMaterial(page, MATERIAL_2);
      const sets = join(library, SUBJECT_2, MATERIAL_2, "sets");
      const before = (await readdir(sets)).sort();
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).click();
      const outcome = page.getByTestId("make-outcome");
      await outcome.getByText("Nothing was made").waitFor();
      assert.equal(await outcome.getAttribute("role"), "alert");
      assert.match(
        (await outcome.innerText()).replace(/\s+/g, " "),
        /Your Test AI usage limit is reached for now\. Wait until it resets, or choose another AI in Settings\./,
      );
      assert.deepEqual((await readdir(sets)).sort(), before, "a failed run left a file");
      // Trying again is possible at once.
      await page.getByTestId("make").getByRole("button", { name: "Make summary" }).waitFor();
      await shot("smoke-35-usage-limit");
    },
  },
];

/* ── Runner ──────────────────────────────────────────────────────────────────────────────── */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The launches of one smoke run. They share the profile and the library, so what one launch
 * made is there in the next. What differs is how the Test AI behaves (`STUDIPLAN_FAKE_AI`):
 * no launch ever reaches a real AI.
 */
const launches = [
  { fakeAi: "1", steps: firstRunSteps },
  { fakeAi: "1", steps: [...steps, ...sizeSteps] },
  { fakeAi: "slow", steps: [...slowSteps, ...frameSteps, ...reloadSteps] },
  { fakeAi: "retry", steps: retrySteps },
  { fakeAi: "limit", steps: limitSteps },
  // No stand-in: the real list of AIs, in whatever state this computer has them. No request is sent.
  { fakeAi: null, steps: realProviderSteps },
];

/** Starts the built app, runs `steps` in it, and closes it. Returns false when a step failed. */
async function runLaunch({ fakeAi, steps: launchSteps }, { userData, libraryDir, fixtures }) {
  const env = {
    ...process.env,
    STUDIPLAN_USER_DATA_DIR: userData,
    STUDIPLAN_LIBRARY_DIR: libraryDir,
  };
  if (fakeAi === null) delete env.STUDIPLAN_FAKE_AI;
  else env.STUDIPLAN_FAKE_AI = fakeAi;
  // Set by some terminals and editors; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;

  /** Problems the page reported while it ran: console errors, uncaught exceptions, CSP blocks. */
  const pageProblems = [];
  let app;
  let passed = true;
  console.log(`\n  launch ${fakeAi === null ? "without the stand-in AI" : `with STUDIPLAN_FAKE_AI=${fakeAi}`}`);

  try {
    app = await electron.launch({ args: [root], cwd: root, env, timeout: 30_000 });
    const page = await app.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.on("console", (message) => {
      if (message.type() === "error") pageProblems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => pageProblems.push(`uncaught: ${error.message}`));
    await page.waitForLoadState("domcontentloaded");

    const shot = async (name) => {
      // Overlays fade in and out; a screenshot waits for that to finish.
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            // An indeterminate progress bar never finishes.
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      await page.screenshot({ path: join(artifacts, `${name}.png`) });
    };

    for (const step of [
      ...launchSteps,
      {
        name: "no errors in the page console",
        async run() {
          assert.deepEqual(pageProblems, []);
        },
      },
    ]) {
      const started = Date.now();
      try {
        await withTimeout(
          step.run({ app, page, shot, library: libraryDir, fixtures, userData }),
          STEP_TIMEOUT_MS * 2,
          `"${step.name}"`,
        );
        console.log(`  ok    ${step.name} (${Date.now() - started} ms)`);
      } catch (error) {
        passed = false;
        console.error(`  FAIL  ${step.name}`);
        console.error(String(error?.stack ?? error).replace(/^/gm, "        "));
        if (pageProblems.length > 0) console.error("        page problems:", pageProblems);
        await page.screenshot({ path: join(artifacts, "smoke-failure.png") }).catch(() => {});
        break;
      }
    }
  } finally {
    await withTimeout(app?.close() ?? Promise.resolve(), 10_000, "closing the app").catch(() => {
      app?.process().kill();
    });
  }
  return passed;
}

async function main() {
  if (!existsSync(join(root, "out/main/index.js"))) {
    throw new Error("No build found in out/. Use `npm run smoke`, which builds it.");
  }
  // The throwaway profile and library below only exist for a build with the development hooks
  // on. A release build ignores them: this test would then run in the real profile and create,
  // rename and delete things in the real library. So it does not start on one.
  if ((await bundleKind(root)) !== "test") {
    throw new Error(
      "The build in out/ is a release build, which ignores the test's throwaway folders. " +
        "Use `npm run smoke`, which builds with `electron-vite build --mode test-build`.",
    );
  }
  await mkdir(artifacts, { recursive: true });
  // Screenshots of an earlier run would pass for this one's.
  for (const name of await readdir(artifacts)) {
    if (/^smoke.*\.png$/.test(name)) await rm(join(artifacts, name), { force: true });
  }

  const userData = await mkdtemp(join(tmpdir(), "studiplan-smoke-"));
  // A throwaway library too, so a smoke run never touches the real Documents folder.
  const libraryDir = join(userData, "library");
  const fixtures = await writeFixtures(join(userData, "fixtures"));

  let failed = false;
  try {
    for (const launch of launches) {
      if (!(await runLaunch(launch, { userData, libraryDir, fixtures }))) {
        failed = true;
        break;
      }
    }
  } finally {
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  if (failed) throw new Error("Smoke test failed.");
  console.log(`\nSmoke test passed. Screenshots: ${join("artifacts", "smoke-NN-*.png")}`);
}

const watchdog = setTimeout(() => {
  console.error(`Smoke test did not finish within ${RUN_TIMEOUT_MS} ms.`);
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

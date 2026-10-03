/**
 * Writes build/THIRD-PARTY-NOTICES.txt: the name, version, licence and full licence text of
 * every piece of third-party code that ships inside the installer. `npm run notices` runs it
 * alone; `npm run dist` runs it before electron-builder, which copies the file into the app
 * (see `extraFiles` in electron-builder.yml).
 *
 * What counts as shipped is worked out, not listed by hand:
 *
 *  1. Runtime modules. The production `dependencies` in package.json and everything they depend
 *     on. electron-builder copies exactly these into app.asar.
 *  2. Bundled code. The app is built once more into a throwaway folder with source maps on, and
 *     the maps are read: every file under node_modules that contributed code to out/main,
 *     out/preload or out/renderer names its package. Build tools that leave nothing behind
 *     (electron-builder, ESLint, Vitest, Playwright, TypeScript) therefore do not appear.
 *  3. Stylesheets. Source maps do not cover CSS, so the renderer's .css files are read for
 *     `@import "<package>"`; such a package is listed with the packages it depends on.
 *  4. What npm cannot know (`EXTRAS` below): PDF.js, which `unpdf` carries inside its own
 *     bundle, and the Inter font files.
 *
 * Electron and Chromium are not listed here. electron-builder puts their own files,
 * LICENSE.electron.txt and LICENSES.chromium.html, next to the program.
 *
 * The script fails, and writes nothing, when a package has a licence that is not on the list of
 * permissive ones below, or has no licence text and none can be supplied. A new dependency with
 * a copyleft or unknown licence therefore stops `npm run dist` until someone has looked at it.
 *
 * Flags: `--list` prints one line per package and writes nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = path.join(root, "build", "THIRD-PARTY-NOTICES.txt");
/** Inside node_modules: ignored by git and ESLint, and on the same drive as the sources. */
const scratch = path.join(root, "node_modules", ".cache", "studiplan-notices");
const licenceTexts = path.join(root, "scripts", "licenses");
const rendererSources = path.join(root, "src", "renderer");

/** Licences that allow shipping the code in this MIT app with nothing more than their notice. */
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "OFL-1.1",
  "Unlicense",
  "Zlib",
]);

/**
 * Standard texts for a package that names its licence but ships no licence file. Only licences
 * whose text is the same for everyone belong here; MIT, ISC and BSD texts carry a copyright
 * line of their own and cannot be supplied this way.
 */
const STANDARD_TEXTS = { "Apache-2.0": "Apache-2.0.txt" };

/** Third-party material that is in the app but is not an npm package of its own. */
const EXTRAS = [
  {
    name: "PDF.js (pdfjs-dist)",
    license: "Apache-2.0",
    source: "https://github.com/mozilla/pdf.js",
    reasons: ["inside the runtime module unpdf"],
    async describe() {
      const unpdf = await readJson(path.join(root, "node_modules", "unpdf", "package.json"));
      const range = unpdf.devDependencies?.["pdfjs-dist"];
      return {
        version: range === undefined ? `as built into unpdf ${unpdf.version}` : `${range}, as built into unpdf ${unpdf.version}`,
        files: [
          {
            name: "Copyright",
            text: "Copyright Mozilla Foundation and the PDF.js contributors.",
          },
          { name: "LICENSE", text: await readFile(path.join(licenceTexts, "Apache-2.0.txt"), "utf8") },
        ],
      };
    },
  },
  {
    name: "Inter typeface",
    license: "OFL-1.1",
    source: "https://github.com/rsms/inter",
    reasons: ["the font files of the window (Inter-Variable.woff2, Inter-Italic-Variable.woff2)"],
    async describe() {
      const text = await readFile(path.join(rendererSources, "src", "assets", "fonts", "OFL.txt"), "utf8");
      return { version: "", files: [{ name: "OFL.txt", text }] };
    },
  },
];

/** What stops the build. */
const problems = [];
/** What is worth knowing but stops nothing. */
const notes = [];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** The folder of package `name` as Node would find it from `fromDirectory`, or `undefined`. */
function findPackage(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.resolve(directory) === root) return undefined;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** package folder -> the reasons it ships */
const shipped = new Map();

function add(directory, reason) {
  const key = path.resolve(directory);
  const reasons = shipped.get(key) ?? new Set();
  reasons.add(reason);
  const isNew = !shipped.has(key);
  shipped.set(key, reasons);
  return isNew;
}

/** `directory` and everything it depends on at run time. */
async function addWithDependencies(directory, reason, seen = new Set()) {
  const key = path.resolve(directory);
  if (seen.has(key)) return;
  seen.add(key);
  add(directory, reason);
  const manifest = await readJson(path.join(directory, "package.json"));
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  for (const name of new Set([...required, ...optional])) {
    const found = findPackage(name, directory);
    if (found !== undefined) await addWithDependencies(found, reason, seen);
    else if (required.includes(name) && !optional.includes(name)) {
      problems.push(`${manifest.name} depends on ${name}, which is not installed. Run "npm ci".`);
    }
  }
}

/* ── 1. Runtime modules ──────────────────────────────────────────────────────────────────── */

async function collectRuntimeModules() {
  const manifest = await readJson(path.join(root, "package.json"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const found = findPackage(name, root);
    if (found === undefined) problems.push(`The dependency ${name} is not installed. Run "npm ci".`);
    else await addWithDependencies(found, "runtime module in app.asar");
  }
}

/* ── 2. Bundled code ─────────────────────────────────────────────────────────────────────── */

/** The package folder a file under node_modules belongs to, or `undefined`. */
function packageOfFile(file) {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1 || at + 1 >= parts.length) return undefined;
  const scoped = parts[at + 1].startsWith("@");
  const end = at + (scoped ? 3 : 2);
  if (end > parts.length) return undefined;
  return parts.slice(0, end).join(path.sep);
}

async function filesBelow(directory, suffix) {
  const found = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

async function collectBundledCode() {
  await rm(scratch, { recursive: true, force: true });
  const cli = path.join(root, "node_modules", "electron-vite", "bin", "electron-vite.js");
  // Flags from `electron-vite build --help` (5.0.0). No shell: Node runs the tool's own script.
  const build = spawnSync(
    process.execPath,
    [cli, "build", "--outDir", scratch, "--sourcemap", "--logLevel", "error"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) throw new Error("The build for the source maps failed; see the output above.");

  const maps = await filesBelow(scratch, ".map");
  if (maps.length === 0) throw new Error("The build wrote no source maps, so nothing can be said about what is bundled.");

  for (const mapFile of maps) {
    const bundle = path.relative(scratch, mapFile).split(path.sep)[0];
    const map = await readJson(mapFile);
    for (const source of map.sources ?? []) {
      if (typeof source !== "string") continue;
      // Helpers the bundler itself adds (module preload, CommonJS interop) have made-up names.
      if (source.includes("\0") || /(^|\/)vite\/(modulepreload-polyfill|preload-helper)/.test(source)) {
        const vite = findPackage("vite", root);
        if (vite !== undefined) add(vite, `helper code bundled into out/${bundle}`);
        continue;
      }
      const file = source.startsWith("file:")
        ? fileURLToPath(source)
        : path.resolve(path.dirname(mapFile), map.sourceRoot ?? "", source);
      const directory = packageOfFile(file);
      if (directory === undefined) {
        // The app's own sources. Anything else would be code of unknown origin.
        if (!path.resolve(file).startsWith(path.join(root, "src") + path.sep)) {
          problems.push(`Bundled into out/${bundle} from outside src/ and node_modules: ${source}`);
        }
        continue;
      }
      if (!existsSync(path.join(directory, "package.json"))) {
        problems.push(`Bundled into out/${bundle}, but its package folder was not found: ${source}`);
        continue;
      }
      add(directory, `bundled into out/${bundle}`);
    }
  }
  await rm(scratch, { recursive: true, force: true });
}

/* ── 3. Stylesheets ──────────────────────────────────────────────────────────────────────── */

const CSS_REFERENCE = /@(?:import|plugin|config|reference)\s+(?:url\()?["']([^"']+)["']/g;

function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z]+:/i.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function collectStylesheets() {
  const sheets = (await filesBelow(rendererSources, ".css")).filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`));
  for (const sheet of sheets) {
    const text = await readFile(sheet, "utf8");
    for (const match of text.matchAll(CSS_REFERENCE)) {
      const name = packageNameOf(match[1]);
      if (name === undefined) continue;
      const found = findPackage(name, path.dirname(sheet));
      if (found === undefined) problems.push(`${path.relative(root, sheet)} imports ${name}, which is not installed.`);
      else await addWithDependencies(found, "styles compiled into out/renderer");
    }
  }
}

/* ── Licences ────────────────────────────────────────────────────────────────────────────── */

function licenceOf(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === "string" ? entry : entry?.type)).filter(Boolean).join(" OR ");
  if (value !== null && typeof value === "object" && typeof value.type === "string") return value.type;
  return "";
}

/**
 * The permissive way to use something under an SPDX expression, or `undefined` when there is
 * none. `A OR B` is a choice, so one permissive side is enough and that side is what the app
 * uses; `A AND B` needs both. An expression that mixes the two is only accepted when every
 * licence in it is permissive, which needs no parsing of the brackets.
 */
function permissiveChoice(expression) {
  const flat = expression.replace(/[()]/g, " ").trim();
  const allOf = (part) => {
    const ids = part.split(/\s+AND\s+/i).map((id) => id.trim()).filter(Boolean);
    return ids.length > 0 && ids.every((id) => PERMISSIVE.has(id));
  };
  const alternatives = flat.split(/\s+OR\s+/i);
  if (alternatives.every(allOf)) return expression;
  if (/\sAND\s/i.test(flat)) return undefined;
  return alternatives.map((id) => id.trim()).find((id) => PERMISSIVE.has(id));
}

const isPermissive = (expression) => permissiveChoice(expression) !== undefined;

/** `(MIT OR GPL-3.0-or-later)` -> `(MIT OR GPL-3.0-or-later), used under MIT`. */
function licenceLabel(expression) {
  const choice = permissiveChoice(expression);
  return choice === undefined || choice === expression ? expression : `${expression}, used under ${choice}`;
}

/**
 * The licence a package prints in its README instead of shipping a file: everything from a
 * "License" heading to the end, when that really is a licence text and not just its name.
 */
async function licenceFromReadme(directory) {
  const readme = (await readdir(directory)).find((name) => /^readme(?:\.(?:md|markdown|txt))?$/i.test(name));
  if (readme === undefined) return undefined;
  const text = await readFile(path.join(directory, readme), "utf8");
  const heading = /^#+\s*licen[sc]e\b.*$/im.exec(text);
  if (heading === null) return undefined;
  const section = text.slice(heading.index + heading[0].length).replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  if (!/copyright/i.test(section) || !/permission/i.test(section)) return undefined;
  return { name: `${readme}, section "License"`, text: section };
}

const LICENCE_FILE = /^(?:licen[sc]e|copying|notice|unlicense)(?:[-._][\w.-]*)?$/i;
const NOT_TEXT = /\.(?:js|cjs|mjs|ts|json|map|html)$/i;

async function licenceFilesOf(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name) && !NOT_TEXT.test(entry.name))
    .map((entry) => entry.name)
    // Licence first, then NOTICE, each group in name order: the same output on every machine.
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b, "en"));
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(directory, name), "utf8") })));
}

function repositoryOf(manifest) {
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const address = repository ?? manifest.homepage ?? "";
  return String(address).replace(/^git\+/, "").replace(/\.git$/, "");
}

async function describePackage(directory, reasons) {
  const manifest = await readJson(path.join(directory, "package.json"));
  const label = `${manifest.name}@${manifest.version}`;
  const license = licenceOf(manifest);
  const files = await licenceFilesOf(directory);

  if (license === "") problems.push(`${label} names no licence in its package.json.`);
  else if (!isPermissive(license)) problems.push(`${label} is under "${license}", which is not on the permissive list. It needs a decision.`);

  if (!files.some((file) => !/^notice/i.test(file.name))) {
    const standard = STANDARD_TEXTS[license];
    const fromReadme = await licenceFromReadme(directory);
    if (fromReadme !== undefined) {
      files.unshift(fromReadme);
    } else if (standard !== undefined) {
      files.unshift({ name: `LICENSE (standard ${license} text; the package ships none)`, text: await readFile(path.join(licenceTexts, standard), "utf8") });
    } else {
      problems.push(`${label} (${license || "no licence named"}) ships no licence file, and its text cannot be supplied from a standard one.`);
    }
  }
  // A package may say one thing in package.json and ship another text. Both are carried; the
  // difference is printed so that it is seen.
  let shown = licenceLabel(license);
  const shipsApache = files.some((file) => /^\s*Apache License\s+Version 2\.0/.test(file.text));
  if (shipsApache && !license.includes("Apache-2.0")) {
    shown = `${license} according to its package.json; the licence file it ships is the Apache License 2.0`;
    notes.push(`${label}: package.json says ${license}, but the licence file is the Apache License 2.0. Both are permissive; the file is included as shipped.`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: shown,
    source: repositoryOf(manifest),
    reasons: [...reasons].sort(),
    files,
  };
}

/* ── Output ──────────────────────────────────────────────────────────────────────────────── */

const RULE = "=".repeat(100);
/** Some licence files start with a byte order mark. */
const withoutByteOrderMark = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const tidy = (text) => withoutByteOrderMark(text).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

const titleOf = (entry) => (entry.version === "" ? entry.name : `${entry.name} ${entry.version}`);

function render(entries) {
  const lines = [
    "THIRD-PARTY NOTICES",
    "",
    "Studiplan is published under the MIT licence. It includes the software and the typeface listed",
    "below, each under its own licence. This file names every one of them with its version and",
    "licence, followed by the full licence text and any NOTICE file it comes with.",
    "",
    "Electron and Chromium are not listed here: their licences are in LICENSE.electron.txt and",
    "LICENSES.chromium.html, in the same folder as this file.",
    "",
    "CONTENTS",
    "",
    ...entries.map((entry) => `  ${titleOf(entry)}: ${entry.license}`),
    "",
  ];
  for (const entry of entries) {
    lines.push(RULE, titleOf(entry), `Licence: ${entry.license}`);
    if (entry.source !== "") lines.push(`Source: ${entry.source}`);
    lines.push(`In the app as: ${entry.reasons.join("; ")}`, RULE, "");
    for (const file of entry.files) lines.push(`--- ${file.name} ---`, "", tidy(file.text), "");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const listOnly = process.argv.includes("--list");

  await collectRuntimeModules();
  await collectBundledCode();
  await collectStylesheets();

  const entries = [];
  for (const [directory, reasons] of shipped) entries.push(await describePackage(directory, reasons));
  for (const extra of EXTRAS) {
    const { describe, ...rest } = extra;
    if (!isPermissive(rest.license)) problems.push(`${rest.name} is under "${rest.license}", which is not on the permissive list.`);
    entries.push({ ...rest, ...(await describe()) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "en") || String(a.version).localeCompare(String(b.version), "en"));

  if (problems.length > 0) {
    console.error(`Third-party notices: ${problems.length} problem(s). Nothing was written.`);
    for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  for (const note of notes) console.warn(`Note: ${note}`);

  if (listOnly) {
    for (const entry of entries) console.log(`${titleOf(entry)}\t${entry.license}\t${entry.reasons.join("; ")}`);
    return;
  }

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, render(entries), "utf8");

  const counts = new Map();
  for (const entry of entries) counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
  const summary = [...counts].sort().map(([license, count]) => `${count} ${license}`).join(", ");
  console.log(`Third-party notices: ${entries.length} entries (${summary}) -> ${path.relative(root, outputFile)}`);
}

await main();

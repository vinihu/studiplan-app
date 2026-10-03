/**
 * Checks the RELEASE build from the outside: that the packed Studiplan.exe starts, and that
 * none of the ways into it that a development build has are open.
 *
 *   npm run dist                                   builds release/win-unpacked and the installer
 *   npm run verify:release                         checks release/win-unpacked/Studiplan.exe
 *   node scripts/verify-release.mjs <Studiplan.exe> [--control=<Studiplan Test.exe>]
 *
 * `scripts/smoke-packaged.mjs` drives a test build with Playwright. A release build cannot be
 * driven: it has no debugger to attach to and ignores the test's throwaway folders. So this
 * script only starts it as an ordinary program and looks at what happens around it:
 *
 *   - the fuses in the .exe are the ones `scripts/after-pack.mjs` sets for a release;
 *   - it starts, shows its window, and quits with code 0 when its window is closed;
 *   - `--remote-debugging-port` and `--inspect` open no port;
 *   - `ELECTRON_RENDERER_URL` is not loaded (a local web server counts the requests);
 *   - `STUDIPLAN_USER_DATA_DIR`, `STUDIPLAN_LIBRARY_DIR` and `NODE_OPTIONS` do nothing;
 *   - `ELECTRON_RUN_AS_NODE` does not turn it into Node.js;
 *   - a changed app.asar, or an `app` folder in its place, stops it from starting.
 *
 * With `--control`, the same probes are first run against a test build, where the port must
 * open and the page must be requested. That shows the probes can see what they look for. The
 * test build in artifacts/test-build is used when it is there.
 *
 * ## It never touches the real profile or the real library
 *
 * A release build keeps its settings in the profile folder of the Windows account
 * (%APPDATA%\Studiplan) and cannot be told otherwise. Windows works that folder out from
 * USERPROFILE, so every release process here is started with USERPROFILE pointing into a
 * temporary folder. Before anything is started, the script asks Windows (through PowerShell,
 * with the same environment) where the profile folder would be, and stops if the answer is not
 * inside the temporary folder. Afterwards it compares the real profile folder and the real
 * library folder (Documents\Studiplan) with how they were before: nothing may have been made or
 * changed. The Documents folder itself cannot always be redirected (it can be moved to another
 * drive); the app only makes the library folder when the first subject is made, and this script
 * never presses anything, so it is not made. That too is checked, not assumed.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { RELEASE_FUSES } from "./after-pack.mjs";
import { packagedKind, RELEASE_NAME, TEST_NAME } from "./build-kind.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const executable = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(root, "release/win-unpacked", `${RELEASE_NAME}.exe`));
const controlArg = args.find((arg) => arg.startsWith("--control="))?.slice("--control=".length);
const defaultControl = join(root, "artifacts/test-build/win-unpacked", `${TEST_NAME}.exe`);
const control = controlArg ? resolve(controlArg) : existsSync(defaultControl) ? defaultControl : null;

const START_TIMEOUT_MS = 40_000;
const QUIT_TIMEOUT_MS = 20_000;
/** How long a started app is left alone before the probes look: time for a port to open or a page to be fetched. */
const SETTLE_MS = 4_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ── Looking from outside ────────────────────────────────────────────────────────────────── */

function powershell(command, env = process.env) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Whether the process has a window on screen. The app shows its window once the page is drawn. */
function hasWindow(pid) {
  const handle = powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle } else { 0 }`);
  return Number(handle) !== 0;
}

/** A port nothing listens on right now. */
function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** Whether something accepts connections on the port, on either loopback address. */
async function portIsOpen(port) {
  const tryHost = (host) =>
    new Promise((done) => {
      const socket = net.connect({ port, host });
      socket.setTimeout(1_500);
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      for (const event of ["error", "timeout"]) {
        socket.once(event, () => {
          socket.destroy();
          done(false);
        });
      }
    });
  return (await tryHost("127.0.0.1")) || (await tryHost("::1"));
}

/** A web server on this computer that counts what is asked of it. */
async function countingServer() {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>not the app</title><p>If this is in the window, the app loaded a page from outside.</p>");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/`, hits, close: () => new Promise((done) => server.close(done)) };
}

/** Every file and folder under `folder` with its size and time of change; `null` when it is not there. */
async function snapshot(folder) {
  if (!existsSync(folder)) return null;
  const entries = {};
  const self = await stat(folder);
  entries["."] = `${self.mtimeMs}`;
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const info = await stat(full).catch(() => null);
    entries[full.slice(folder.length + 1)] = info === null ? "unreadable" : `${entry.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`;
  }
  return entries;
}

/* ── Starting the app as an ordinary program ─────────────────────────────────────────────── */

/**
 * Starts `exe` and watches it. `exited` resolves to the exit code (or the signal) once it is gone.
 */
function start(exe, { env, args: programArgs = [], cwd }) {
  const child = spawn(exe, programArgs, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let gone = null;
  const exited = new Promise((done) => {
    child.once("exit", (code, signal) => {
      gone = { code, signal };
      done(gone);
    });
    child.once("error", (error) => {
      gone = { code: null, signal: null, error };
      done(gone);
    });
  });
  return { pid: child.pid, exited, gone: () => gone, output: () => output, kill: () => child.kill() };
}

/** Waits for the app's window. Returns "window", or "exited" when the process ended first, or "nothing". */
async function waitForWindow(app, timeout = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app.gone() !== null) return "exited";
    if (hasWindow(app.pid)) return "window";
    await sleep(400);
  }
  return app.gone() !== null ? "exited" : "nothing";
}

/** Asks the app to close the way a user would (its window is closed) and returns how it ended. */
async function closeNicely(app) {
  if (app.gone() !== null) return app.gone();
  // Without /F this sends the window a close message; it does not end the process by force.
  spawnSync("taskkill.exe", ["/PID", String(app.pid)], { stdio: "ignore" });
  const ended = await Promise.race([app.exited, sleep(QUIT_TIMEOUT_MS).then(() => null)]);
  if (ended !== null) return ended;
  spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  await app.exited;
  return { code: null, signal: "forced" };
}

async function endByForce(app) {
  if (app.gone() !== null) return;
  spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  await Promise.race([app.exited, sleep(5_000)]);
}

/* ── The checks ──────────────────────────────────────────────────────────────────────────── */

let failed = 0;

async function check(name, run) {
  try {
    const note = await run();
    console.log(`  ok    ${name}${note ? `  (${note})` : ""}`);
    return true;
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(String(error?.message ?? error).replace(/^/gm, "        "));
    return false;
  }
}

/** The hooks and switches a development build obeys, all at once, pointed at things this script watches. */
async function hostileLaunch(scratch, label, server) {
  const overrideProfile = join(scratch, `${label}-override-profile`);
  const overrideLibrary = join(scratch, `${label}-override-library`);
  const nodeMarker = join(scratch, `${label}-node-options-ran.txt`);
  const preload = join(scratch, `${label}-preload.cjs`);
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(nodeMarker)}, "NODE_OPTIONS was obeyed");\n`);
  return {
    overrideProfile,
    overrideLibrary,
    nodeMarker,
    debugPort: await freePort(),
    inspectPort: await freePort(),
    env: {
      ELECTRON_RENDERER_URL: server.url,
      STUDIPLAN_USER_DATA_DIR: overrideProfile,
      STUDIPLAN_LIBRARY_DIR: overrideLibrary,
      STUDIPLAN_FAKE_AI: "1",
      NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
    },
  };
}

async function main() {
  if (process.platform !== "win32") throw new Error("The release check runs on Windows only.");
  if (!existsSync(executable)) throw new Error(`No release build at ${executable}. Run \`npm run dist\` first.`);
  if ((await packagedKind(executable)) !== "release") {
    throw new Error(`${executable} is a test build, not a release. Run \`npm run dist\` and check that.`);
  }

  const scratch = await mkdtemp(join(tmpdir(), "studiplan-verify-"));
  const home = join(scratch, "home");
  const redirectedAppData = join(home, "AppData", "Roaming");
  await mkdir(redirectedAppData, { recursive: true });
  await mkdir(join(home, "AppData", "Local"), { recursive: true });

  // The environment every release process below gets: a home of its own, and none of the
  // variables that would change how Electron starts unless a check adds one on purpose.
  const sandbox = { ...process.env, USERPROFILE: home, APPDATA: redirectedAppData, LOCALAPPDATA: join(home, "AppData", "Local") };
  for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "ELECTRON_RENDERER_URL", "STUDIPLAN_USER_DATA_DIR", "STUDIPLAN_LIBRARY_DIR", "STUDIPLAN_FAKE_AI"]) {
    delete sandbox[name];
  }

  const realProfile = join(powershell("[Environment]::GetFolderPath('ApplicationData')"), RELEASE_NAME);
  const realLibrary = join(powershell("[Environment]::GetFolderPath('MyDocuments')"), RELEASE_NAME);
  const redirectedProfile = join(redirectedAppData, RELEASE_NAME);

  console.log(`\n  ${executable}`);
  console.log(`  real profile   ${realProfile}${existsSync(realProfile) ? "" : "  (does not exist)"}`);
  console.log(`  real library   ${realLibrary}${existsSync(realLibrary) ? "" : "  (does not exist)"}`);
  console.log(`  profile used   ${redirectedProfile}\n`);

  // Before anything is started: would Windows put the profile into the temporary home?
  const answered = powershell("[Environment]::GetFolderPath('ApplicationData')", sandbox);
  if (resolve(answered).toLowerCase() !== resolve(redirectedAppData).toLowerCase()) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error(
      `On this computer the profile folder cannot be moved for one process (Windows answered ${answered}). ` +
        "The release build would use the real profile, so nothing was started.",
    );
  }
  const documentsInSandbox = powershell("[Environment]::GetFolderPath('MyDocuments')", sandbox);
  const documentsRedirected = resolve(documentsInSandbox).toLowerCase().startsWith(resolve(home).toLowerCase());

  const before = { profile: await snapshot(realProfile), library: await snapshot(realLibrary) };
  const server = await countingServer();

  try {
    await check("the fuses in the .exe are the release's", async () => {
      assert.equal(basename(executable), `${RELEASE_NAME}.exe`);
      const wire = await getCurrentFuseWire(executable);
      const states = [];
      for (const [fuse, wanted] of Object.entries(RELEASE_FUSES)) {
        const state = String.fromCharCode(wire[fuse]);
        assert.equal(state, wanted ? "1" : "0", `fuse ${FuseV1Options[fuse]} is "${state}"`);
        states.push(`${FuseV1Options[fuse]}=${wanted ? "on" : "off"}`);
      }
      assert.equal(Object.keys(RELEASE_FUSES).length, Object.keys(wire).filter((key) => key !== "version").length, "the .exe has a fuse that is not decided");
      return states.join(", ");
    });

    /* The control: the same probes must see an open port and a requested page on a test build. */
    if (control === null) {
      console.log("  --    no test build given or found: the probes are not shown to work on a build with the hooks on");
    } else {
      await check("control: on a test build the same probes DO see the debugger ports and the page request", async () => {
        assert.equal(await packagedKind(control), "test", `${control} is not a test build`);
        const hostile = await hostileLaunch(scratch, "control", server);
        const hitsBefore = server.hits.length;
        const env = { ...process.env, ...hostile.env };
        // A test build would obey this one too, and it is not what is being looked at here.
        delete env.NODE_OPTIONS;
        delete env.ELECTRON_RUN_AS_NODE;
        const app = start(control, { env, cwd: scratch, args: [`--remote-debugging-port=${hostile.debugPort}`, `--inspect=${hostile.inspectPort}`] });
        try {
          assert.equal(await waitForWindow(app), "window", `the test build did not show a window:\n${app.output()}`);
          await sleep(SETTLE_MS);
          assert.equal(await portIsOpen(hostile.debugPort), true, "the probe did not see the remote-debugging port of a test build");
          assert.equal(await portIsOpen(hostile.inspectPort), true, "the probe did not see the inspector port of a test build");
          assert.ok(server.hits.length > hitsBefore, "the test build did not request ELECTRON_RENDERER_URL");
          assert.ok(existsSync(hostile.overrideProfile), "the test build did not use STUDIPLAN_USER_DATA_DIR");
        } finally {
          await closeNicely(app);
          await endByForce(app);
        }
        return `ports ${hostile.debugPort} and ${hostile.inspectPort} open, ${server.hits.length - hitsBefore} request(s)`;
      });
    }

    /* The release, started with every hook and switch at once. */
    const hostile = await hostileLaunch(scratch, "release", server);
    const hitsBefore = server.hits.length;
    const app = start(executable, {
      env: { ...sandbox, ...hostile.env },
      cwd: scratch,
      args: [`--remote-debugging-port=${hostile.debugPort}`, `--inspect=${hostile.inspectPort}`],
    });
    let up = false;
    try {
      up = await check("it starts and shows its window, given every development hook and switch at once", async () => {
        const outcome = await waitForWindow(app);
        assert.equal(outcome, "window", `no window (${outcome}); exit ${JSON.stringify(app.gone())}\n${app.output()}`);
        await sleep(SETTLE_MS);
        assert.equal(app.gone(), null, "it quit by itself");
      });
      if (up) {
        await check(`--remote-debugging-port=${hostile.debugPort} opens no port`, async () => {
          assert.equal(await portIsOpen(hostile.debugPort), false, "the remote-debugging port is open");
          assert.doesNotMatch(app.output(), /DevTools listening/i);
        });
        await check(`--inspect=${hostile.inspectPort} opens no inspector`, async () => {
          assert.equal(await portIsOpen(hostile.inspectPort), false, "the inspector port is open");
          assert.doesNotMatch(app.output(), /Debugger listening/i);
        });
        await check("ELECTRON_RENDERER_URL is not loaded", async () => {
          assert.deepEqual(server.hits.slice(hitsBefore), [], "the app asked the local server for a page");
        });
        await check("NODE_OPTIONS loads nothing into the app", async () => {
          assert.ok(!existsSync(hostile.nodeMarker), "the script named in NODE_OPTIONS ran");
        });
        await check("STUDIPLAN_USER_DATA_DIR and STUDIPLAN_LIBRARY_DIR are ignored", async () => {
          assert.ok(!existsSync(hostile.overrideProfile), "the profile folder from the variable was made");
          assert.ok(!existsSync(hostile.overrideLibrary), "the library folder from the variable was made");
          assert.ok(existsSync(redirectedProfile), `the app's own profile folder was not made at ${redirectedProfile}`);
          return `profile at ${redirectedProfile}`;
        });
      }
    } finally {
      if (up) {
        await check("it quits with code 0 when its window is closed", async () => {
          const ended = await closeNicely(app);
          assert.deepEqual(ended, { code: 0, signal: null });
          // Written on the way out, into the app's own profile: it closed, it did not just die.
          assert.ok(existsSync(join(redirectedProfile, "window.json")), "window.json was not written on closing");
        });
      }
      await endByForce(app);
    }

    await check('ELECTRON_RUN_AS_NODE=1 with -e "process.exit(42)" does not run it as Node.js', async () => {
      const node = start(executable, { env: { ...sandbox, ELECTRON_RUN_AS_NODE: "1" }, cwd: scratch, args: ["-e", "process.exit(42)"] });
      try {
        const outcome = await waitForWindow(node);
        assert.notEqual(node.gone()?.code, 42, "it ran the script: it behaved as Node.js");
        assert.equal(outcome, "window", `it neither ran as Node.js nor opened its window (${outcome}, ${JSON.stringify(node.gone())})`);
        return "it opened the app's window instead";
      } finally {
        await closeNicely(node);
        await endByForce(node);
      }
    });

    /* A copy of the build, changed. The original is never written to. */
    const copy = join(scratch, "copy");
    await cp(dirname(executable), copy, { recursive: true });
    const copyExe = join(copy, basename(executable));
    const archive = join(copy, "resources", "app.asar");
    const pristine = await readFile(archive);

    await check("a single changed byte in app.asar stops it from starting", async () => {
      // One letter inside a piece of text in the main script: the script would still run.
      const at = pristine.indexOf(Buffer.from("studiplan-build-kind:release"));
      assert.ok(at > 0, "the place to change was not found in app.asar");
      const changed = Buffer.from(pristine);
      changed[at] = changed[at] ^ 0x01;
      await writeFile(archive, changed);
      const tampered = start(copyExe, { env: sandbox, cwd: scratch });
      try {
        const outcome = await waitForWindow(tampered, 25_000);
        assert.equal(outcome, "exited", `the changed app ${outcome === "window" ? "started and showed its window" : "kept running"}`);
        assert.notEqual(tampered.gone().code, 0, "the changed app quit as if nothing was wrong");
        return `ended with ${JSON.stringify(tampered.gone())}`;
      } finally {
        await endByForce(tampered);
        await writeFile(archive, pristine);
      }
    });

    await check("an `app` folder in place of app.asar is not run", async () => {
      const marker = join(scratch, "loose-app-ran.txt");
      const loose = join(copy, "resources", "app");
      await rm(archive);
      await mkdir(loose);
      await writeFile(join(loose, "package.json"), JSON.stringify({ name: "loose", main: "main.js" }));
      await writeFile(join(loose, "main.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(43);\n`);
      const replaced = start(copyExe, { env: sandbox, cwd: scratch });
      try {
        const outcome = await waitForWindow(replaced, 20_000);
        assert.ok(!existsSync(marker), "the script in the `app` folder ran");
        assert.notEqual(replaced.gone()?.code, 43, "the script in the `app` folder ran");
        assert.notEqual(outcome, "window", "it opened a window without app.asar");
        return `ended with ${JSON.stringify(replaced.gone())}`;
      } finally {
        await endByForce(replaced);
      }
    });

    await check("the real profile and the real library folder were not made or changed", async () => {
      // Give anything still writing a moment, then look.
      await sleep(1_000);
      for (const [folder, was] of [[realProfile, before.profile], [realLibrary, before.library]]) {
        const now = await snapshot(folder);
        const names = new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})]);
        const changed = [...names].filter((name) => (was ?? {})[name] !== (now ?? {})[name]);
        assert.deepEqual(
          changed,
          [],
          `${folder} changed while the check ran (${changed.length} entries, for instance ${changed.slice(0, 6).join(", ")}). ` +
            "If the installed Studiplan is open, that is its own doing: close it and run the check again.",
        );
      }
      const library = documentsRedirected ? join(documentsInSandbox, RELEASE_NAME) : null;
      if (library !== null) assert.ok(!existsSync(library), "the app made a library folder on its own");
      return documentsRedirected
        ? "Documents followed the temporary home"
        : `Documents stayed at ${documentsInSandbox}; no library folder was made there`;
    });
  } finally {
    await server.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }

  if (failed > 0) throw new Error(`Release check failed: ${failed} problem(s).`);
  console.log("\nRelease check passed.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`\n${error?.message ?? error}`);
    process.exit(1);
  },
);

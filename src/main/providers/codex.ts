/**
 * The Codex provider: runs the user's installed `codex` command headless (`codex exec`) with
 * every tool switched off.
 *
 * Every flag below was checked against `codex --help`, `codex exec --help` and the config
 * reference (Codex CLI 0.150.1) and exercised with real calls. See `buildCodexArgs` for what each
 * one is for.
 *
 * ## How this differs from the Claude Code provider
 *
 * Codex has no file-reading tool. It reads files by running shell commands, and on Windows its
 * read-only sandbox (the default, unelevated backend) blocks writing and the network but lets a
 * command read any file the user can read. So "may read the material folder, nothing else" cannot
 * be had by leaving it a tool. Instead:
 *
 *  - no tool works at all (shell, code mode and the image viewer are switched off);
 *  - photos are attached by the CLI itself (`--image`), from neutral-named copies in a private
 *    temporary folder, so no file name of the student's appears on the command line;
 *  - the process runs in that temporary folder, not in the material's folder: it has nothing to
 *    read there, and an `AGENTS.md` or `.codex` folder among the student's files is never seen;
 *  - PDFs cannot be attached (only pictures can), so `readsScannedPdfs` is off and a `file` part
 *    is refused.
 *
 * The app's instructions travel in a file (`model_instructions_file`), which replaces Codex's own
 * coding-agent prompt; the schema travels in a file too (`--output-schema`). The material goes on
 * stdin. Nothing of the prompt is in argv.
 */
import { copyFile, lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { consoleLog, failure, ProviderFailure, type ProviderLog } from "./errors";
import { stripCodeFence } from "./fence";
import { findExecutable, isFileOnDisk, pathDirectories, type IsFileFn } from "./locate";
import { toWorkingDirectoryParts } from "./paths";
import { ProcessFailure, runProcess, type RunDeps, type RunOptions, type RunResult } from "./process";
import { assemblePrompt } from "./prompt";
import type { GenerateRequest, Provider } from "./provider";
import { isModelId } from "@shared/providers";
import type { ProviderDetection, ProviderErrorCode, ProviderModel } from "@shared/providers";

const LABEL = "Codex";

const NOT_SIGNED_IN =
  'Codex is installed but not signed in. Open a terminal, run "codex login" and sign in, then try again.';
const NOT_INSTALLED =
  "Codex was not found on this computer. Install it: open a terminal and run \"npm install -g @openai/codex\", sign in, then check again.";

/**
 * The models `codex debug models` lists as selectable (Codex CLI 0.150.1, ChatGPT sign-in).
 * The catalog changes with Codex versions and plans; any other name may be typed in Settings.
 */
export const CODEX_MODELS: readonly ProviderModel[] = [
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced)" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fast, uses less of your limit)" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DETECT_TIMEOUT_MS = 15 * 1000;

/** Windows allows 32,767 characters for a whole command line; only attached photos add to it. */
export const MAX_ARGV_CHARS = 30_000;

/**
 * Everything Codex could act with, switched off. The names are from `codex features list`
 * (0.150.1), run with the flags below: every feature that gives the model a tool, whether it is
 * on by default in this version or not. `shell_tool` and `unified_exec` are the two ways it
 * runs commands; with `code_mode_host` off the remaining "code mode" tool (which wraps patching
 * files) fails closed on every call.
 *
 * This is a deny-list, and a later Codex can add a tool under a new name. It is therefore not
 * what the app relies on alone: a run in which Codex used any tool is thrown away
 * (`TOOL_ITEM_TYPES`, `readCodexResult`). Note for 0.150.1: `codex features list` goes on
 * showing `unified_exec` as on whatever is passed; whether that tool is offered to the model
 * with `shell_tool` off is not something the list tells.
 */
export const DISABLED_FEATURES: readonly string[] = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "code_mode",
  "code_mode_only",
  "view_image",
  "apps",
  "enable_mcp_apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "memories",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "in_app_local_automation",
  "computer_use",
  "tool_suggest",
  "tool_search",
  "search_tool",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "goals",
  "js_repl",
  "js_repl_tools_only",
  "apply_patch_freeform",
  "artifact",
  "standalone_web_search",
  "web_search_request",
  "web_search_cached",
  "request_permissions_tool",
  "remote_control",
  "realtime_conversation",
];

/**
 * What Codex reports when the model used a tool: a command, a change to a file, an MCP tool, a
 * sub-agent, a web search. None of these may happen in a request of this app. If one does, the
 * run is thrown away, whatever it answered.
 */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
]);

const USED_A_TOOL =
  "Codex tried to do something other than read your material and answer, which Studiplan does not allow. Nothing was saved. Try again, or pick another AI in Settings.";

/** A TOML basic string. `-c key=value` parses the value as TOML. */
export function tomlString(value: string): string {
  // JSON's escapes are all valid in a TOML basic string; DEL is the one character JSON leaves
  // bare and TOML does not allow.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

export interface CodexArgsInput {
  /** The file holding the app's instructions. In the request's private temporary folder. */
  instructionsFile: string;
  /** The file holding the JSON Schema, when the answer must be JSON. */
  schemaFile?: string | undefined;
  model?: string | undefined;
  /** Photos to attach: absolute paths of the neutral-named copies. */
  images: readonly string[];
}

/**
 * The arguments for one headless request. Neither the material (stdin) nor the instructions
 * and the schema (files) are among them; only the paths of those files and of the photo copies.
 *
 * Read-only is enforced by everything up to `--json` and is the same for every request.
 */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = [
    // Non-interactive: run one turn and exit.
    "exec",
    // The sandbox for anything Codex would run or write: no writing, no network. A second guard;
    // with the tools off nothing reaches it.
    "--sandbox",
    "read-only",
    // Nobody answers approval prompts: anything that would ask is refused.
    "-c",
    'approval_policy="never"',
    // The user's own config.toml is not loaded: no MCP servers, no instructions, no model or
    // sandbox settings of theirs. Sign-in still works.
    "--ignore-user-config",
    // No user or project rules that could allow a command.
    "--ignore-rules",
    // Nothing about the request is saved to the user's Codex sessions or history.
    "--ephemeral",
    "-c",
    'history.persistence="none"',
    // The working folder is a temporary one, not a Git repository.
    "--skip-git-repo-check",
    // No AGENTS.md from any folder is put in front of the model.
    "-c",
    "project_doc_max_bytes=0",
    // No built-in skills listed to the model.
    "-c",
    "skills.bundled.enabled=false",
    // No web search.
    "-c",
    'web_search="disabled"',
    "-c",
    "analytics.enabled=false",
  ];
  // As configuration, not as `--disable <name>`: that flag stops Codex with "Unknown feature
  // flag" when a version does not know a name, and a name it does not know needs no switching
  // off. This form is accepted for any name (checked with `codex features list`, 0.150.1).
  for (const feature of DISABLED_FEATURES) args.push("-c", `features.${feature}=false`);
  args.push(
    // Replaces Codex's own (coding agent) instructions with the app's.
    "-c",
    `model_instructions_file=${tomlString(input.instructionsFile)}`,
  );
  if (input.model !== undefined) args.push("--model", input.model);
  if (input.schemaFile !== undefined) args.push("--output-schema", input.schemaFile);
  // One flag per photo, so a path can never be taken for an option or for the prompt.
  for (const image of input.images) args.push("--image", image);
  args.push(
    "--color",
    "never",
    // Events on stdout, one JSON object per line: the answer, or how the run failed.
    "--json",
    // The prompt is read from stdin.
    "-",
  );
  return args;
}

/** A careful upper bound of the command line Windows will see, with its quoting. */
function commandLineLength(command: string, args: readonly string[]): number {
  let total = command.length + 2;
  for (const arg of args) total += arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3;
  return total;
}

/** What the `--json` event lines of one run say. */
export interface CodexEvents {
  /** True when at least one line was an event object. */
  sawEvents: boolean;
  /** The text of the last `agent_message` item. Earlier ones are progress notes. */
  answer: string | undefined;
  /** True when the turn ended normally. */
  completed: boolean;
  /** The message of `turn.failed`, or of the last top-level `error` event. */
  error: string | undefined;
  /** The kinds of tool the model used (`TOOL_ITEM_TYPES`). Empty in every run that is kept. */
  toolsUsed: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the JSON lines `codex exec --json` prints. Lines that are not JSON objects are skipped.
 *
 * An `item.completed` whose item has type `error` is a warning (Codex prints one to say code
 * mode is off, which is intended), not a failure of the run.
 */
export function readCodexEvents(stdout: string): CodexEvents {
  const events: CodexEvents = { sawEvents: false, answer: undefined, completed: false, error: undefined, toolsUsed: [] };
  let turnFailed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (event === undefined || typeof event["type"] !== "string") continue;
    events.sawEvents = true;
    // Whatever the event says happened to it (started, updated, completed): a tool was used.
    if (event["type"].startsWith("item.")) {
      const kind = asRecord(event["item"])?.["type"];
      if (typeof kind === "string" && TOOL_ITEM_TYPES.has(kind) && !events.toolsUsed.includes(kind)) events.toolsUsed.push(kind);
    }
    switch (event["type"]) {
      case "item.completed": {
        const item = asRecord(event["item"]);
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") events.answer = item["text"];
        break;
      }
      case "turn.completed":
        events.completed = true;
        break;
      case "turn.failed": {
        const message = asRecord(event["error"])?.["message"];
        turnFailed = true;
        events.completed = false;
        events.error = typeof message === "string" ? message : (events.error ?? "");
        break;
      }
      case "error":
        if (!turnFailed && typeof event["message"] === "string") events.error = event["message"];
        break;
      default:
        break;
    }
  }
  return events;
}

/**
 * Turns Codex's own error text into one of our codes. Seen with real calls (0.150.1): the 401
 * of a signed-out run and the 400 of an unknown model. The usage-limit, busy, too-large and
 * offline patterns are from Codex's messages and OpenAI's error codes, not from a real failure.
 * Anything unrecognised is `failed`.
 */
export function classifyCodexError(text: string): ProviderErrorCode {
  const statusMatch = /unexpected status (\d{3})|"status"\s*:\s*(\d{3})/.exec(text);
  const status = statusMatch === null ? undefined : Number(statusMatch[1] ?? statusMatch[2]);

  if (
    status === 401 ||
    /not logged in|codex login|log(ged)? ?in again|sign in again|missing bearer|invalid[_ ]api[_ ]key|(token|session|login)[\w\s]{0,20}(revoked|expired|invalid)|refresh[_ ]token/i.test(
      text,
    )
  ) {
    return "not-signed-in";
  }
  if (/usage limit|usage_limit|hit your [\w\s-]{0,30}limit|insufficient_quota|exceeded your current quota|out of credits|credit balance/i.test(text)) {
    return "usage-limit";
  }
  if (
    /model/i.test(text) &&
    /not supported|not found|not_found|does not exist|do(es)? not have access|not available|invalid model/i.test(text)
  ) {
    return "model-unavailable";
  }
  if (/context[_ ](length|window)|too large|too long|exceeds? the (maximum|limit)|maximum context/i.test(text) || status === 413) {
    return "too-large";
  }
  if (/invalid_json_schema|invalid schema|output[_-]schema/i.test(text)) {
    return "invalid-request";
  }
  if ((status !== undefined && status >= 500) || /overloaded|at capacity|high demand|server_error|temporarily unavailable/i.test(text)) {
    return "busy";
  }
  if (status === 429 || /rate limit|too many requests/i.test(text)) {
    return "usage-limit";
  }
  if (status === 404) return "model-unavailable";
  if (
    /stream disconnected|error sending request|connection (error|refused|reset|closed)|failed to connect|dns error|network (error|is unreachable)|timed out|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(
      text,
    )
  ) {
    return "offline";
  }
  return "failed";
}

function sentence(code: ProviderErrorCode): ProviderFailure {
  return failure(code, LABEL, code === "not-signed-in" ? NOT_SIGNED_IN : code === "not-installed" ? NOT_INSTALLED : undefined);
}

/**
 * The answer from a finished run, or a `ProviderFailure`.
 * `structured` says whether a JSON schema was asked for.
 */
export function readCodexResult(run: RunResult, structured: boolean, log: ProviderLog = consoleLog): string {
  const events = readCodexEvents(run.stdout);

  // Before anything else: an answer from a run that used a tool is not an answer to keep.
  if (events.toolsUsed.length > 0) {
    log("codex: the model used a tool; the run is discarded", { tools: events.toolsUsed });
    throw failure("failed", LABEL, USED_A_TOOL);
  }

  if (!events.completed) {
    // The tool's own short error message: a status, a URL, a request id. Never material.
    const message = events.error ?? "";
    log("codex: request failed", {
      exitCode: run.exitCode,
      sawEvents: events.sawEvents,
      message: message.slice(0, 300),
      stderr: events.sawEvents ? undefined : run.stderr.slice(0, 500),
    });
    if (!events.sawEvents && run.exitCode === 0) throw sentence("bad-output");
    throw sentence(classifyCodexError(events.error ?? run.stderr));
  }

  const answer = events.answer ?? "";

  if (structured) {
    const text = stripCodeFence(answer);
    try {
      JSON.parse(text);
    } catch {
      log("codex: structured answer is not JSON", { answerChars: answer.length });
      throw sentence("bad-output");
    }
    return text;
  }

  const text = answer.trim();
  if (text.length === 0) {
    log("codex: empty answer", { exitCode: run.exitCode });
    throw sentence("bad-output");
  }
  return text;
}

/**
 * The folders to look in for the real executable, besides PATH itself.
 *
 * `npm install -g @openai/codex` puts a `.cmd` shim (Windows) or a Node script (elsewhere) on
 * PATH; the native executable it starts sits in a platform package nested under the same
 * folder. A `.cmd` shim needs a shell, so on Windows the native executable is started directly.
 */
export function codexInstallDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  arch: string = process.arch,
): string[] {
  if (platform === "win32") {
    const cpu = arch === "arm64" ? "arm64" : "x64";
    const triple = cpu === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const packageName = `codex-win32-${cpu}`;
    const join = path.win32.join;
    // Every folder that may hold npm's shim: PATH (covers a custom npm prefix) and npm's default.
    const shimFolders = pathDirectories(env, platform);
    const appData = env["APPDATA"];
    if (appData !== undefined && appData.length > 0) shimFolders.push(join(appData, "npm"));
    const directories: string[] = [];
    for (const folder of shimFolders) {
      const scope = join(folder, "node_modules", "@openai");
      directories.push(
        join(scope, "codex", "node_modules", "@openai", packageName, "vendor", triple, "bin"),
        join(scope, packageName, "vendor", triple, "bin"),
      );
    }
    return directories;
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.posix.join(home, ".local", "bin"),
    path.posix.join(home, ".npm-global", "bin"),
  ];
}

/** The disk operations of one request, injectable for tests. */
export interface CodexFiles {
  /** Makes a new private folder inside `parent` and returns its path. */
  makeDirectory(parent: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** True for a regular file. False for a link, a folder or nothing. */
  isPlainFile(file: string): Promise<boolean>;
  /** Removes the folder and everything in it. */
  remove(directory: string): Promise<void>;
}

const diskFiles: CodexFiles = {
  makeDirectory: (parent) => mkdtemp(path.join(parent, "studiplan-codex-")),
  writeText: (file, text) => writeFile(file, text, "utf8"),
  copy: (from, to) => copyFile(from, to),
  isPlainFile: async (file) => {
    try {
      return (await lstat(file)).isFile();
    } catch {
      return false;
    }
  },
  // Right after a kill on Windows the files can stay locked for a moment: retry.
  remove: (directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
};

export interface CodexOptions {
  /** Used when a request names no model. Left out, Codex picks its own default. */
  defaultModel?: string;
  /** How long one request may take. Default: ten minutes. */
  timeoutMs?: number;
  log?: ProviderLog;
  // Everything below exists for tests.
  run?: (options: RunOptions) => Promise<RunResult>;
  processDeps?: RunDeps;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  isFile?: IsFileFn;
  isDirectory?: (directory: string) => Promise<boolean>;
  /** Where the per-request temporary folders are made. Default: the system's temp folder. */
  tempRoot?: string;
  files?: CodexFiles;
}

async function isDirectoryOnDisk(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** `.jpg` from `page.JPG`; a neutral `.img` when the name has no plain extension. */
function imageExtension(file: string, pathApi: path.PlatformPath): string {
  const extension = pathApi.extname(file).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".img";
}

export function createCodexProvider(options: CodexOptions = {}): Provider {
  const log = options.log ?? consoleLog;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? os.homedir();
  const isFile = options.isFile ?? isFileOnDisk;
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const files = options.files ?? diskFiles;
  const run = options.run ?? ((runOptions: RunOptions) => runProcess(runOptions, options.processDeps));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  function locate(): Promise<string | undefined> {
    const names = platform === "win32" ? ["codex.exe"] : ["codex"];
    const directories = [...pathDirectories(env, platform), ...codexInstallDirectories(env, platform, home, arch)];
    return findExecutable(names, directories, platform, isFile);
  }

  async function detect(): Promise<ProviderDetection> {
    try {
      const command = await locate();
      if (command === undefined) {
        return { available: false, status: "not-installed", detail: NOT_INSTALLED };
      }
      const base = { command, cwd: tempRoot, env, timeoutMs: DETECT_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 };

      const versionRun = await run({ ...base, args: ["--version"] });
      const version = /\d+\.\d+\.\d+/.exec(versionRun.stdout)?.[0];
      if (versionRun.exitCode !== 0 || version === undefined) {
        log("codex: --version failed", { exitCode: versionRun.exitCode });
        return {
          available: false,
          status: "error",
          detail: "Codex was found but did not start properly. Reinstall or update it, then check again.",
        };
      }

      // Reads the local sign-in state. It sends no request to the model and costs nothing.
      // Its output can name the sign-in method or a masked key: it is matched, never shown or logged.
      const loginRun = await run({ ...base, args: ["login", "status"] });
      const said = `${loginRun.stdout}\n${loginRun.stderr}`;
      if (/not logged in/i.test(said)) {
        return { available: false, status: "not-signed-in", detail: NOT_SIGNED_IN, version };
      }
      if (loginRun.exitCode !== 0 || !/logged in/i.test(said)) {
        // An older or newer version without this command: usable, sign-in unknown.
        log("codex: login status not understood", { exitCode: loginRun.exitCode });
        return {
          available: true,
          status: "ready",
          detail: `Codex ${version} is installed. Press Test to check that it is signed in.`,
          version,
        };
      }
      return { available: true, status: "ready", detail: `Codex ${version} is installed and signed in.`, version };
    } catch (error) {
      log("codex: detection failed", { kind: error instanceof ProcessFailure ? error.kind : "unexpected" });
      return {
        available: false,
        status: "error",
        detail: "Codex was found but could not be checked. Try again, or reinstall it.",
      };
    }
  }

  async function generate(request: GenerateRequest): Promise<string> {
    if (request.signal.aborted) throw sentence("cancelled");

    const model = request.model ?? options.defaultModel;
    if (model !== undefined && !isModelId(model)) throw sentence("model-unavailable");

    // Throws `invalid-request` when a file is outside the material folder.
    const parts = toWorkingDirectoryParts(request.parts, request.workingDirectory, pathApi);
    // Codex can be handed pictures, nothing else (see `readsScannedPdfs`).
    if (parts.some((part) => part.type === "file")) throw sentence("invalid-request");
    const images = parts.flatMap((part) => (part.type === "image" ? [part.path] : []));

    const materialFolder = request.workingDirectory;
    if (materialFolder !== undefined) {
      if (!pathApi.isAbsolute(materialFolder)) throw sentence("invalid-request");
      if (!(await isDirectory(materialFolder))) {
        throw failure(
          "failed",
          LABEL,
          "The material's folder could not be found. It may have been moved or deleted; go back to the library and open it again.",
        );
      }
    }

    const command = await locate();
    if (command === undefined) throw sentence("not-installed");

    const prompt = assemblePrompt({ instructions: request.instructions, parts, files: "attachments" });

    let workspace: string | undefined;
    try {
      let args: string[];
      try {
        workspace = await files.makeDirectory(tempRoot);
        const instructionsFile = pathApi.join(workspace, "instructions.md");
        await files.writeText(instructionsFile, prompt.system);

        let schemaFile: string | undefined;
        if (request.jsonSchema !== undefined) {
          schemaFile = pathApi.join(workspace, "schema.json");
          await files.writeText(schemaFile, JSON.stringify(request.jsonSchema));
        }

        const attached: string[] = [];
        for (const [index, image] of images.entries()) {
          const source = pathApi.resolve(materialFolder ?? "", image);
          // A link could point outside the material folder; only real files are copied.
          if (!(await files.isPlainFile(source))) {
            log("codex: a photo is missing or not a plain file", { index });
            throw failure(
              "failed",
              LABEL,
              "One of the photos could not be read. It may have been moved or deleted; go back to the library and open the material again.",
            );
          }
          if (request.signal.aborted) throw sentence("cancelled");
          const target = pathApi.join(workspace, `photo-${String(index + 1).padStart(3, "0")}${imageExtension(image, pathApi)}`);
          await files.copy(source, target);
          attached.push(target);
        }

        args = buildCodexArgs({ instructionsFile, schemaFile, model, images: attached });
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        log("codex: could not prepare the temporary folder", { name: error instanceof Error ? error.name : typeof error });
        throw failure("failed", LABEL, "Studiplan could not prepare the request on disk. Check that there is free space, then try again.");
      }

      if (commandLineLength(command, args) > MAX_ARGV_CHARS) {
        log("codex: too many photos for a command line", { photos: images.length });
        throw sentence("too-large");
      }
      if (request.signal.aborted) throw sentence("cancelled");

      let result: RunResult;
      try {
        result = await run({ command, args, cwd: workspace, env, stdin: prompt.user, signal: request.signal, timeoutMs });
      } catch (error) {
        if (!(error instanceof ProcessFailure)) {
          log("codex: unexpected error while running", { name: error instanceof Error ? error.name : typeof error });
          throw sentence("failed");
        }
        log("codex: process failure", { kind: error.kind, errno: error.errno });
        switch (error.kind) {
          case "aborted":
            throw sentence("cancelled");
          case "timed-out":
            throw sentence("timed-out");
          case "output-limit":
            throw sentence("too-large");
          case "not-found":
            throw sentence("not-installed");
          case "spawn-failed":
            throw failure("failed", LABEL, "Codex could not be started. Update or reinstall it, then press Test in Settings.");
        }
      }

      // A run that ended because of the abort can still close normally; the user's cancel wins.
      if (request.signal.aborted) throw sentence("cancelled");
      return readCodexResult(result, request.jsonSchema !== undefined, log);
    } finally {
      // The instructions, the schema and the photo copies go, whatever happened — also on abort.
      if (workspace !== undefined) {
        try {
          await files.remove(workspace);
        } catch (error) {
          log("codex: could not remove the temporary folder", { name: error instanceof Error ? error.name : typeof error });
        }
      }
    }
  }

  return {
    id: "codex",
    label: LABEL,
    suggestedModels: CODEX_MODELS,
    // `--image` takes pictures only; a PDF given that way is silently not shown to the model.
    readsScannedPdfs: false,
    detect,
    generate,
  };
}

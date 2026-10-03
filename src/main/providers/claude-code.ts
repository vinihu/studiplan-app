/**
 * The Claude Code provider: runs the user's installed `claude` command headless, read-only,
 * with the material's folder as its working directory.
 *
 * Every flag below was checked against `claude --help` (Claude Code 2.1.287) and exercised with
 * real calls. See `buildClaudeArgs` for what each one is for.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

const LABEL = "Claude Code";

const NOT_SIGNED_IN =
  'Claude Code is installed but not signed in. Open a terminal, run "claude" and sign in, then try again.';
const NOT_INSTALLED =
  "Claude Code was not found on this computer. Install it from claude.com/claude-code, sign in, then check again.";

/** Aliases `claude --model` accepts; a full model name may be typed in Settings instead. */
export const CLAUDE_CODE_MODELS: readonly ProviderModel[] = [
  { id: "sonnet", label: "Sonnet (balanced)" },
  { id: "opus", label: "Opus (most capable, uses more of your limit)" },
  { id: "haiku", label: "Haiku (fastest)" },
];

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DETECT_TIMEOUT_MS = 15 * 1000;

/**
 * Windows allows 32,767 characters for a whole command line. The schema travels in argv, so
 * its size is checked before starting the tool.
 */
export const MAX_ARGV_CHARS = 30_000;

export interface ClaudeArgsInput {
  /**
   * The file that holds the assembled system prompt: the app's instructions and the material
   * rules. No material. In the request's private temporary folder.
   */
  systemFile: string;
  jsonSchema?: object | undefined;
  model?: string | undefined;
  /** True when the request has material files for the tool to read. */
  readFiles: boolean;
}

/**
 * The arguments for one headless request. The material is never among them: it goes on stdin,
 * as the prompt. Nor is the system prompt — the app's own instructions, which for "Something
 * else…" include the request the student typed: it is in a file, and only the file's path is
 * an argument, so nothing a student wrote shows in the list of running programs. What does
 * travel as an argument is the schema, which is the app's own text.
 *
 * Read-only is enforced by the first block and is the same for every request.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    // Non-interactive: print the answer and exit. The prompt (the material) is read from stdin.
    "--print",
    // Removes the tools that run commands or code and WebFetch, confines the file tools to the
    // working directory, and ignores the user's, the project's and local settings files.
    "--restricted",
    // Turns off every customisation: CLAUDE.md (the user's, and any file of that name inside a
    // material folder), skills, plugins, hooks, MCP servers, custom agents. Sign-in still works.
    "--safe-mode",
    // The only built-in tool that exists in the session: Read. No Write, Edit, Bash, web or
    // subagents. With no material files, no tool at all.
    "--tools",
    input.readFiles ? "Read" : "",
    // Nobody answers permission prompts: anything that would ask is denied.
    "--permission-prompts",
    "none",
    // No MCP servers from any configuration.
    "--strict-mcp-config",
    // No skills or slash commands.
    "--disable-slash-commands",
    // Nothing about the request is saved to the user's Claude Code history.
    "--no-session-persistence",
    // One JSON object on stdout with the answer and how the run ended.
    "--output-format",
    "json",
    // Replaces Claude Code's own (coding) system prompt with the app's instructions, read from
    // a file. (`claude --help`, 2.1.288, names the option as `--system-prompt[-file]`.)
    "--system-prompt-file",
    input.systemFile,
  ];
  if (input.model !== undefined) args.push("--model", input.model);
  if (input.jsonSchema !== undefined) args.push("--json-schema", JSON.stringify(input.jsonSchema));
  return args;
}

/** A careful upper bound of the command line Windows will see, with its quoting. */
function commandLineLength(command: string, args: readonly string[]): number {
  let total = command.length + 2;
  for (const arg of args) total += arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3;
  return total;
}

/** The fields of the `--output-format json` result object this provider reads. */
export interface ClaudeEnvelope {
  is_error?: unknown;
  subtype?: unknown;
  result?: unknown;
  structured_output?: unknown;
  api_error_status?: unknown;
  terminal_reason?: unknown;
  permission_denials?: unknown;
  num_turns?: unknown;
}

/** The result object from stdout, or `undefined` when stdout is not one. */
export function parseEnvelope(stdout: string): ClaudeEnvelope | undefined {
  const tryParse = (text: string): ClaudeEnvelope | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      return (value as { type?: unknown }).type === "result" ? (value as ClaudeEnvelope) : undefined;
    } catch {
      return undefined;
    }
  };
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  // Tolerate a stray line printed before the result.
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return lastLine === trimmed ? undefined : tryParse(lastLine);
}

/**
 * Turns the tool's own error text and HTTP status into one of our codes. The patterns are the
 * messages found in Claude Code 2.1.287; anything unrecognised is `failed`.
 */
export function classifyClaudeError(text: string, apiStatus?: number): ProviderErrorCode {
  if (
    apiStatus === 401 ||
    /not logged in|\/login|invalid api key|authentication_error|(token|login|session) (has )?(revoked|expired)/i.test(text)
  ) {
    return "not-signed-in";
  }
  if (apiStatus === 529 || (apiStatus !== undefined && apiStatus >= 500) || /overloaded|temporarily limiting/i.test(text)) {
    return "busy";
  }
  if (
    apiStatus === 429 ||
    /usage limit|limit reached|hit your [\w\s-]{0,30}limit|spend limit|credit balance|rate limit/i.test(text)
  ) {
    return "usage-limit";
  }
  if (apiStatus === 413 || /prompt is too long|context limit|too large|exceeds? the maximum/i.test(text)) {
    return "too-large";
  }
  if (
    apiStatus === 404 ||
    (/model/i.test(text) && /not available|not found|not exist|invalid|not_found|issue with the selected/i.test(text))
  ) {
    return "model-unavailable";
  }
  if (/internet connection|unable to connect|connection error|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(text)) {
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
export function readClaudeResult(run: RunResult, structured: boolean, log: ProviderLog = consoleLog): string {
  const envelope = parseEnvelope(run.stdout);

  if (envelope === undefined) {
    // No result object: the tool died early, or printed something else entirely.
    log("claude: no result object", {
      exitCode: run.exitCode,
      stdoutBytes: run.stdout.length,
      stderr: run.stderr.slice(0, 500),
    });
    if (run.exitCode === 0) throw sentence("bad-output");
    throw sentence(classifyClaudeError(run.stderr));
  }

  const subtype = typeof envelope.subtype === "string" ? envelope.subtype : "";
  const apiStatus = typeof envelope.api_error_status === "number" ? envelope.api_error_status : undefined;
  const result = typeof envelope.result === "string" ? envelope.result : "";
  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials.length : 0;

  if (envelope.is_error === true || subtype !== "success") {
    // On an error the result text is the tool's own short message, not material.
    log("claude: request failed", {
      exitCode: run.exitCode,
      subtype,
      apiStatus,
      terminalReason: envelope.terminal_reason,
      message: result.slice(0, 300),
    });
    if (subtype === "error_max_structured_output_retries") throw sentence("bad-output");
    throw sentence(classifyClaudeError(`${result}\n${run.stderr}`, apiStatus));
  }

  if (denials > 0) {
    // The model tried something the read-only setup refused (for example reading outside the
    // material folder). The answer is still returned; the attempt is worth a log line.
    log("claude: denied tool use", { count: denials });
  }

  if (structured) {
    const output = envelope.structured_output;
    if (typeof output === "object" && output !== null) return JSON.stringify(output);
    const text = stripCodeFence(result);
    try {
      JSON.parse(text);
    } catch {
      log("claude: structured answer is not JSON", { resultChars: result.length });
      throw sentence("bad-output");
    }
    return text;
  }

  const text = result.trim();
  if (text.length === 0) {
    log("claude: empty answer", { numTurns: envelope.num_turns });
    throw sentence("bad-output");
  }
  return text;
}

/** The folders to look in besides PATH: where the installers and npm put the executable. */
export function claudeInstallDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    const directories = [path.win32.join(home, ".local", "bin")];
    const appData = env["APPDATA"];
    if (appData !== undefined && appData.length > 0) {
      // `npm install -g` puts a .cmd shim in %APPDATA%\npm; the real executable is here.
      directories.push(path.win32.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin"));
    }
    return directories;
  }
  return [
    path.posix.join(home, ".local", "bin"),
    path.posix.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.posix.join(home, ".npm-global", "bin"),
  ];
}

export interface ClaudeCodeOptions {
  /** Used when a request names no model. Left out, Claude Code picks its own default. */
  defaultModel?: string;
  /** How long one request may take. Default: ten minutes. */
  timeoutMs?: number;
  log?: ProviderLog;
  // Everything below exists for tests.
  run?: (options: RunOptions) => Promise<RunResult>;
  processDeps?: RunDeps;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: IsFileFn;
  isDirectory?: (directory: string) => Promise<boolean>;
  /** An empty folder to run in when a request has no material files. */
  emptyDirectory?: () => Promise<string>;
  /** Writes the system prompt where the tool can read it. */
  systemPromptFile?: (text: string) => Promise<SystemPromptFile>;
}

async function isDirectoryOnDisk(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Where one request's system prompt is kept while the tool runs. */
export interface SystemPromptFile {
  file: string;
  remove(): Promise<void>;
}

/** A private temporary folder with the prompt in it, removed when the request ends. */
async function defaultSystemPromptFile(text: string): Promise<SystemPromptFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "studiplan-claude-"));
  const file = path.join(directory, "instructions.md");
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return {
    file,
    // Right after a kill on Windows the file can stay locked for a moment: retry.
    remove: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined),
  };
}

async function defaultEmptyDirectory(): Promise<string> {
  const directory = path.join(os.tmpdir(), "studiplan-no-material");
  await mkdir(directory, { recursive: true });
  return directory;
}

export function createClaudeCodeProvider(options: ClaudeCodeOptions = {}): Provider {
  const log = options.log ?? consoleLog;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const isFile = options.isFile ?? isFileOnDisk;
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  const emptyDirectory = options.emptyDirectory ?? defaultEmptyDirectory;
  const systemPromptFile = options.systemPromptFile ?? defaultSystemPromptFile;
  const run = options.run ?? ((runOptions: RunOptions) => runProcess(runOptions, options.processDeps));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function locate(): Promise<string | undefined> {
    const names = platform === "win32" ? ["claude.exe"] : ["claude"];
    const directories = [...pathDirectories(env, platform), ...claudeInstallDirectories(env, platform, home)];
    return findExecutable(names, directories, platform, isFile);
  }

  async function detect(): Promise<ProviderDetection> {
    try {
      const command = await locate();
      if (command === undefined) {
        return { available: false, status: "not-installed", detail: NOT_INSTALLED };
      }
      const cwd = await emptyDirectory();
      const base = { command, cwd, env, timeoutMs: DETECT_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 };

      const versionRun = await run({ ...base, args: ["--version"] });
      const version = /\d+\.\d+\.\d+/.exec(versionRun.stdout)?.[0];
      if (versionRun.exitCode !== 0 || version === undefined) {
        log("claude: --version failed", { exitCode: versionRun.exitCode });
        return {
          available: false,
          status: "error",
          detail: "Claude Code was found but did not start properly. Reinstall or update it, then check again.",
        };
      }

      // Reads the local sign-in state. It sends no request to the model and costs nothing.
      const authRun = await run({ ...base, args: ["auth", "status", "--json"] });
      let loggedIn: unknown;
      try {
        loggedIn = (JSON.parse(authRun.stdout) as { loggedIn?: unknown }).loggedIn;
      } catch {
        loggedIn = undefined;
      }
      if (loggedIn === false) {
        return { available: false, status: "not-signed-in", detail: NOT_SIGNED_IN, version };
      }
      if (loggedIn !== true) {
        // An older or newer version without this command: usable, sign-in unknown.
        log("claude: auth status not understood", { exitCode: authRun.exitCode });
        return {
          available: true,
          status: "ready",
          detail: `Claude Code ${version} is installed. Press Test to check that it is signed in.`,
          version,
        };
      }
      return { available: true, status: "ready", detail: `Claude Code ${version} is installed and signed in.`, version };
    } catch (error) {
      log("claude: detection failed", { kind: error instanceof ProcessFailure ? error.kind : "unexpected" });
      return {
        available: false,
        status: "error",
        detail: "Claude Code was found but could not be checked. Try again, or reinstall it.",
      };
    }
  }

  async function generate(request: GenerateRequest): Promise<string> {
    if (request.signal.aborted) throw sentence("cancelled");

    const model = request.model ?? options.defaultModel;
    if (model !== undefined && !isModelId(model)) throw sentence("model-unavailable");

    // Throws `invalid-request` when a file is outside the material folder.
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const parts = toWorkingDirectoryParts(request.parts, request.workingDirectory, pathApi);
    const readFiles = parts.some((part) => part.type !== "text");

    let cwd: string;
    if (request.workingDirectory !== undefined) {
      cwd = request.workingDirectory;
      if (!pathApi.isAbsolute(cwd)) throw sentence("invalid-request");
      if (!(await isDirectory(cwd))) {
        throw failure(
          "failed",
          LABEL,
          "The material's folder could not be found. It may have been moved or deleted; go back to the library and open it again.",
        );
      }
    } else {
      cwd = await emptyDirectory();
    }

    const command = await locate();
    if (command === undefined) throw sentence("not-installed");

    const prompt = assemblePrompt({ instructions: request.instructions, parts, files: "paths" });
    let system: SystemPromptFile;
    try {
      system = await systemPromptFile(prompt.system);
    } catch (error) {
      log("claude: the instructions could not be written to a temporary file", { name: error instanceof Error ? error.name : typeof error });
      throw failure("failed", LABEL, "Studiplan could not write a temporary file. Check that the disk is not full and try again.");
    }

    let result: RunResult;
    try {
      const args = buildClaudeArgs({ systemFile: system.file, jsonSchema: request.jsonSchema, model, readFiles });
      if (commandLineLength(command, args) > MAX_ARGV_CHARS) {
        log("claude: the schema is too long for a command line", { argChars: commandLineLength(command, args) });
        throw sentence("invalid-request");
      }
      result = await run({ command, args, cwd, env, stdin: prompt.user, signal: request.signal, timeoutMs });
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (!(error instanceof ProcessFailure)) {
        log("claude: unexpected error while running", { name: error instanceof Error ? error.name : typeof error });
        throw sentence("failed");
      }
      log("claude: process failure", { kind: error.kind, errno: error.errno });
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
          throw failure(
            "failed",
            LABEL,
            "Claude Code could not be started. Update or reinstall it, then press Test in Settings.",
          );
      }
    } finally {
      await system.remove();
    }

    // A run that ended because of the abort can still close normally; the user's cancel wins.
    if (request.signal.aborted) throw sentence("cancelled");
    return readClaudeResult(result, request.jsonSchema !== undefined, log);
  }

  return {
    id: "claude-code",
    label: LABEL,
    suggestedModels: CLAUDE_CODE_MODELS,
    // Its Read tool shows the pages of a PDF to the model as pictures, 20 at a time.
    // Its Read tool hands a whole PDF to the model as a document, pictures included. Reading a
    // page range instead (`pages`) needs poppler's `pdftoppm` on the computer, which a student
    // does not have: so no page ranges (checked with Claude Code 2.1.287 on Windows).
    readsScannedPdfs: true,
    detect,
    generate,
  };
}

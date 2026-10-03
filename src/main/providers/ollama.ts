/**
 * The Ollama provider: models that run on the user's own computer, over Ollama's local HTTP API.
 *
 * Built from docs.ollama.com on 2026-10-02 (`/api/chat`, `/api/tags`, `/api/show`,
 * `/api/version`, "Structured outputs", "Vision", "Thinking", "Context length", "Errors", the
 * FAQ) and `envconfig/config.go` in the Ollama repository for `OLLAMA_HOST`. Ollama was not
 * installed where this was written: it is tested against a fake server only.
 *
 * - Address: `http://127.0.0.1:11434`, or what the user's own `OLLAMA_HOST` says. Nothing else
 *   is ever contacted. `node:http` is used rather than `fetch`, because `fetch` gives up after
 *   five minutes without response headers and a local model reading a long prompt on a CPU can
 *   take longer than that before its first word.
 * - `POST /api/chat` with `stream: true`. Closing the connection stops generation on the
 *   server, which is how cancel and the time limit work.
 * - Structured output: `format` is the JSON schema (Ollama 0.5.0 and later); when the server
 *   rejects that, the request is repeated once with `format: "json"`. The schema is also put in
 *   the system prompt, as Ollama's guide recommends.
 * - Photos go in `images` as base64, and only to a model whose `/api/show` capabilities include
 *   `vision`. A PDF cannot be sent: the caller inlines its text.
 * - Context: Ollama's default context is 4,096 tokens on most computers and a longer prompt is
 *   cut silently. The provider sets `options.num_ctx` to fit the request, up to
 *   `maxContextTokens` and the model's own limit, and refuses a request that cannot fit.
 * - Models that Ollama runs in its cloud (`remote_host` in the model list) are left out: they
 *   would send the material off this computer.
 */
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { isModelId } from "@shared/providers";
import type { ProviderDetection, ProviderModel } from "@shared/providers";
import { loadAttachments } from "./api-key-attachments";
import { consoleLog, failure, ProviderFailure, type ProviderLog } from "./errors";
import { stripCodeFence } from "./fence";
import { findExecutable, isFileOnDisk, pathDirectories, type IsFileFn } from "./locate";
import { assemblePrompt } from "./prompt";
import type { GenerateRequest, Provider, TextBudgetInput } from "./provider";

const LABEL = "Ollama";

const NOT_RUNNING =
  "Ollama is installed but not running. Start Ollama (open the Ollama app, or run \"ollama serve\" in a terminal), then check again.";
const NOT_INSTALLED =
  "Ollama was not found on this computer. Install it from ollama.com, start it, then check again.";
const NO_MODEL =
  'Ollama is running but has no model yet. Open a terminal and run "ollama pull gemma4" (or another model from ollama.com/library), then check again.';
const NO_VISION =
  "has no vision, so it cannot read photos. Choose a vision model in Settings (one marked \"reads photos\"), or pull one in a terminal, for example \"ollama pull gemma4\".";

export const DEFAULT_OLLAMA_ADDRESS = "http://127.0.0.1:11434";

/** Local generation is slow, above all on a computer without a graphics card. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DETECT_TIMEOUT_MS = 4 * 1000;
const INFO_TIMEOUT_MS = 15 * 1000;

/** The largest answer read, and the largest reply to a small question such as the model list. */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const MAX_INFO_BYTES = 4 * 1024 * 1024;

// ── Context ─────────────────────────────────────────────────────────────────────────────────

/** A careful estimate: English is about 4 characters per token, languages with long words nearer 3. */
export const CHARS_PER_TOKEN = 3;
/** Tokens kept free for the answer. */
export const OUTPUT_RESERVE_TOKENS = 4096;
/** Tokens allowed for the chat template and anything the estimate missed. */
export const OVERHEAD_TOKENS = 512;
/** What one photo is assumed to cost. Models differ; this is on the high side. */
export const IMAGE_TOKENS = 800;
/** The context sizes asked for, smallest that fits first. Each step costs more memory. */
export const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072] as const;
/**
 * The largest context the provider asks for unless told otherwise. 16,384 tokens fits about
 * 35,000 characters of material and stays within what a laptop with 8 GB can hold next to a
 * small model.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 16_384;

/** Characters of material text that fit a context of `contextTokens`, leaving room for the answer. */
export function textBudgetFor(contextTokens: number): number {
  return Math.max(0, contextTokens - OUTPUT_RESERVE_TOKENS - OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
}

/** The `num_ctx` for a request, or `undefined` when it does not fit in `limit` tokens. */
export function contextFor(promptChars: number, images: number, limit: number): number | undefined {
  const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + OUTPUT_RESERVE_TOKENS + OVERHEAD_TOKENS;
  if (needed > limit) return undefined;
  return Math.min(CONTEXT_STEPS.find((step) => step >= needed) ?? limit, limit);
}

// ── Address ─────────────────────────────────────────────────────────────────────────────────

export interface OllamaAddress {
  /** `http://127.0.0.1:11434`, without a trailing slash. */
  base: string;
  /** True when it points at this computer. */
  local: boolean;
}

/**
 * The server's address from `OLLAMA_HOST`, read the way Ollama's own client reads it: no scheme
 * means `http` and port 11434; `http://` and `https://` default to ports 80 and 443; a missing
 * host means 127.0.0.1. `0.0.0.0` (what people set to make the server listen on every
 * interface) is reached at 127.0.0.1. Anything unreadable falls back to the default.
 */
export function resolveOllamaAddress(env: NodeJS.ProcessEnv): OllamaAddress {
  const fallback: OllamaAddress = { base: DEFAULT_OLLAMA_ADDRESS, local: true };
  const raw = (env["OLLAMA_HOST"] ?? "").trim().replace(/^["']|["']$/g, "");
  if (raw.length === 0) return fallback;

  let scheme = "http";
  let rest = raw;
  let defaultPort = "11434";
  const cut = raw.indexOf("://");
  if (cut >= 0) {
    scheme = raw.slice(0, cut).toLowerCase();
    rest = raw.slice(cut + 3);
    if (scheme === "http") defaultPort = "80";
    else if (scheme === "https") defaultPort = "443";
    else return fallback;
  }

  const hostport = rest.split("/")[0] ?? "";
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${hostport.startsWith(":") ? `127.0.0.1${hostport}` : hostport || "127.0.0.1"}`);
  } catch {
    return fallback;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) return fallback;

  let host = parsed.hostname;
  // `localhost` is this computer by name; the address is used, so that no name is looked up.
  if (host === "0.0.0.0" || host === "[::]" || host.length === 0 || host === "localhost") host = "127.0.0.1";
  // `URL` drops a port that is the scheme's default; an explicit one is kept.
  const explicit = /:(\d{1,5})$/.exec(hostport)?.[1];
  const port = explicit ?? defaultPort;
  const local = host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  return { base: `${scheme}://${host}:${port}`, local };
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────

type CallFailureKind = "aborted" | "timed-out" | "too-large" | "unreachable" | "network";

class CallFailure extends Error {
  readonly kind: CallFailureKind;
  readonly errno: string | undefined;
  constructor(kind: CallFailureKind, errno?: string) {
    super(kind);
    this.name = "CallFailure";
    this.kind = kind;
    this.errno = errno;
  }
}

interface CallOptions {
  base: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  maxBytes: number;
  /** Called for each complete line of the body as it arrives, when the status is 200. */
  onLine?: (line: string) => void;
}

interface CallResult {
  status: number;
  /** The whole body, unless `onLine` consumed it. */
  text: string;
}

/**
 * One request to the Ollama server. Destroying the socket is what stops a running generation,
 * so abort and the time limit both do exactly that. Rejects only with a `CallFailure`.
 */
function call(options: CallOptions): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new CallFailure("aborted"));
      return;
    }
    const url = new URL(options.base + options.path);
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    const transport = url.protocol === "https:" ? https : http;

    let settled = false;
    let timedOut = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const request = transport.request(
      url,
      {
        method: options.method,
        headers:
          payload === undefined
            ? { accept: "application/json" }
            : { "content-type": "application/json", "content-length": String(payload.length) },
        // A fresh connection each time: closing it must end this request and nothing else.
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const streaming = options.onLine !== undefined && status === 200;
        const chunks: Buffer[] = [];
        let total = 0;
        let pending = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          total += Buffer.byteLength(chunk, "utf8");
          if (total > options.maxBytes) {
            request.destroy();
            finish(() => reject(new CallFailure("too-large")));
            return;
          }
          if (!streaming) {
            chunks.push(Buffer.from(chunk, "utf8"));
            return;
          }
          pending += chunk;
          for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
            const line = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            if (line.length === 0) continue;
            try {
              options.onLine?.(line);
            } catch (error) {
              request.destroy();
              finish(() => reject(error instanceof Error ? error : new CallFailure("network")));
              return;
            }
          }
        });
        response.on("end", () => {
          finish(() => {
            try {
              if (streaming && pending.trim().length > 0) options.onLine?.(pending.trim());
              resolve({ status, text: Buffer.concat(chunks).toString("utf8") });
            } catch (error) {
              reject(error instanceof Error ? error : new CallFailure("network"));
            }
          });
        });
        response.on("error", () => finish(() => reject(new CallFailure("network"))));
        // The server went away in the middle of the answer.
        response.on("close", () => {
          if (!response.complete) finish(() => reject(new CallFailure("network")));
        });
      },
    );

    function onAbort(): void {
      request.destroy();
      finish(() => reject(new CallFailure("aborted")));
    }
    const timer = setTimeout(() => {
      timedOut = true;
      request.destroy();
      finish(() => reject(new CallFailure("timed-out")));
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === "string" ? error.code : undefined;
      const unreachable = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EAI_AGAIN";
      finish(() => reject(new CallFailure(timedOut ? "timed-out" : unreachable ? "unreachable" : "network", code)));
    });
    request.end(payload);
  });
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Models ──────────────────────────────────────────────────────────────────────────────────

export interface OllamaModelDetails {
  /** `undefined` when the server is too old to report capabilities. */
  capabilities: string[] | undefined;
  /** The model's own context window in tokens, when reported. */
  contextLength: number | undefined;
  /** True when Ollama would run it on its servers instead of this computer. */
  remote: boolean;
}

/** What `/api/show` says about one model. */
export function readModelDetails(body: Record<string, unknown>): OllamaModelDetails {
  const capabilities = Array.isArray(body["capabilities"])
    ? body["capabilities"].filter((item): item is string => typeof item === "string")
    : undefined;

  let contextLength: number | undefined;
  const info = body["model_info"];
  if (typeof info === "object" && info !== null) {
    for (const [key, value] of Object.entries(info)) {
      // The key is prefixed with the architecture: "llama.context_length", "gemma4.context_length".
      if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
        contextLength = value;
      }
    }
  }
  const remote =
    (typeof body["remote_host"] === "string" && body["remote_host"].length > 0) ||
    (typeof body["remote_model"] === "string" && body["remote_model"].length > 0);
  return { capabilities, contextLength, remote };
}

/**
 * Ollama's cloud models carry `cloud` as their tag or at its end (`gpt-oss:120b-cloud`,
 * `name:cloud`). They are refused by name as well as by what the server says about them, so a
 * server that leaves `remote_host` out does not get one through.
 */
export function isCloudModelName(name: string): boolean {
  return /(^|[:-])cloud$/i.test(name);
}

/** Why nothing is sent to an Ollama on another computer. */
export const REMOTE_HOST_SENTENCE =
  "Ollama is set to another computer (OLLAMA_HOST), so Studiplan will not send your material there. Remove that setting or use Ollama on this computer.";

interface InstalledModel {
  name: string;
  size: string;
  remote: boolean;
}

function readInstalled(body: Record<string, unknown> | undefined): InstalledModel[] {
  const models = Array.isArray(body?.["models"]) ? (body["models"] as unknown[]) : [];
  const result: InstalledModel[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item["name"] === "string" ? item["name"] : typeof item["model"] === "string" ? item["model"] : "";
    // A name that is not a plain model id cannot have come from `ollama pull`; leave it out.
    if (!isModelId(name)) continue;
    const details = typeof item["details"] === "object" && item["details"] !== null ? (item["details"] as Record<string, unknown>) : {};
    const size = typeof details["parameter_size"] === "string" && /^[\w.]{1,12}$/.test(details["parameter_size"]) ? details["parameter_size"] : "";
    const remote =
      isCloudModelName(name) ||
      (typeof item["remote_host"] === "string" && item["remote_host"].length > 0) ||
      (typeof item["remote_model"] === "string" && item["remote_model"].length > 0);
    result.push({ name, size, remote });
  }
  return result;
}

/** The folders to look in besides PATH: where Ollama's installers put the executable. */
export function ollamaInstallDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
    return [path.win32.join(local, "Programs", "Ollama")];
  }
  if (platform === "darwin") {
    return ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Ollama.app/Contents/Resources"];
  }
  return ["/usr/local/bin", "/usr/bin", path.posix.join(home, ".local", "bin")];
}

// ── The provider ────────────────────────────────────────────────────────────────────────────

export interface OllamaOptions {
  /** Used when a request names no model. Left out, the first installed model that fits is used. */
  defaultModel?: string;
  /** How long one request may take. Default: thirty minutes. */
  timeoutMs?: number;
  /** The largest `num_ctx` the provider asks for. Default: 16,384. */
  maxContextTokens?: number;
  log?: ProviderLog;
  // Everything below exists for tests.
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: IsFileFn;
  makeCode?: () => string;
}

/** The Ollama provider with the two additions it needs from the `Provider` interface. */
export interface OllamaProvider extends Provider {
  /** The models installed on this computer that can write text, for the model picker. Never throws. */
  listModels(): Promise<ProviderModel[]>;
  /**
   * About how many characters of material text one request can carry with this model, so the
   * caller can pass it as `maxTextChars`. `undefined` when it cannot be told (Ollama not
   * running): use the default then.
   */
  maxTextChars(model?: string, input?: TextBudgetInput): Promise<number | undefined>;
}

export function createOllamaProvider(options: OllamaOptions = {}): OllamaProvider {
  const log = options.log ?? consoleLog;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const isFile = options.isFile ?? isFileOnDisk;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  const address = (): OllamaAddress => resolveOllamaAddress(env);

  function unreachable(local: boolean): ProviderFailure {
    return failure(
      "not-installed",
      LABEL,
      local
        ? "Ollama is not running. Start Ollama (open the Ollama app, or run \"ollama serve\" in a terminal), then try again."
        : "Ollama could not be reached at the address set in OLLAMA_HOST. Check that it is running there, then try again.",
    );
  }

  function fromCall(error: unknown, local: boolean): ProviderFailure {
    if (error instanceof ProviderFailure) return error;
    if (!(error instanceof CallFailure)) {
      log("ollama: unexpected error", { name: error instanceof Error ? error.name : typeof error });
      return failure("failed", LABEL);
    }
    log("ollama: request did not complete", { kind: error.kind, errno: error.errno });
    switch (error.kind) {
      case "aborted":
        return failure("cancelled", LABEL);
      case "timed-out":
        return failure("timed-out", LABEL);
      case "too-large":
        return failure("too-large", LABEL);
      case "unreachable":
        return unreachable(local);
      case "network":
        return failure(
          "failed",
          LABEL,
          "The connection to Ollama broke off. It may have stopped or run out of memory; start it again, or try a smaller model.",
        );
    }
  }

  async function installed(base: string, signal?: AbortSignal): Promise<InstalledModel[]> {
    const tags = await call({ base, method: "GET", path: "/api/tags", signal, timeoutMs: INFO_TIMEOUT_MS, maxBytes: MAX_INFO_BYTES });
    if (tags.status !== 200) throw new CallFailure("network");
    return readInstalled(parseObject(tags.text)).filter((model) => !model.remote);
  }

  /** `undefined` when the model is not installed. */
  async function show(base: string, model: string, signal?: AbortSignal): Promise<OllamaModelDetails | undefined> {
    const result = await call({
      base,
      method: "POST",
      path: "/api/show",
      body: { model },
      signal,
      timeoutMs: INFO_TIMEOUT_MS,
      maxBytes: MAX_INFO_BYTES,
    });
    if (result.status === 404) return undefined;
    const body = parseObject(result.text);
    if (result.status !== 200 || body === undefined) throw new CallFailure("network");
    return readModelDetails(body);
  }

  async function detect(): Promise<ProviderDetection> {
    const { base, local } = address();
    // Before any request: an Ollama on another computer is not asked anything at all.
    if (!local) return { available: false, status: "error", detail: REMOTE_HOST_SENTENCE };
    try {
      let version: string | undefined;
      try {
        const reply = await call({ base, method: "GET", path: "/api/version", timeoutMs: DETECT_TIMEOUT_MS, maxBytes: 64 * 1024 });
        const text = parseObject(reply.text)?.["version"];
        // A version is a few characters; a server may answer with anything.
        version = reply.status === 200 && typeof text === "string" ? /\d+\.\d+\.\d+/.exec(text.slice(0, 64))?.[0] : undefined;
        if (reply.status !== 200) throw new CallFailure("unreachable");
      } catch (error) {
        // Not answering: either not started or not there at all. The executable tells which.
        const names = platform === "win32" ? ["ollama.exe"] : ["ollama"];
        const directories = [...pathDirectories(env, platform), ...ollamaInstallDirectories(env, platform, home)];
        const found = await findExecutable(names, directories, platform, isFile);
        log("ollama: not answering", { kind: error instanceof CallFailure ? error.kind : "unexpected", installed: found !== undefined });
        return { available: false, status: "not-installed", detail: found === undefined ? NOT_INSTALLED : NOT_RUNNING };
      }

      const models = await installed(base);
      const withVersion = version === undefined ? {} : { version };
      if (models.length === 0) {
        return { available: false, status: "error", detail: NO_MODEL, ...withVersion };
      }
      return {
        available: true,
        status: "ready",
        detail: `Ollama${version === undefined ? "" : ` ${version}`} is running with ${models.length} ${models.length === 1 ? "model" : "models"}. Everything stays on this computer.`,
        ...withVersion,
      };
    } catch (error) {
      log("ollama: detection failed", { kind: error instanceof CallFailure ? error.kind : "unexpected" });
      return { available: false, status: "error", detail: "Ollama is running but could not be checked. Restart it, then check again." };
    }
  }

  async function listModels(): Promise<ProviderModel[]> {
    const { base, local } = address();
    if (!local) return [];
    try {
      const models = (await installed(base)).slice(0, 50);
      const described = await Promise.all(
        models.map(async (model) => {
          try {
            return { model, details: await show(base, model.name) };
          } catch {
            return { model, details: undefined };
          }
        }),
      );
      return described
        .filter(({ details }) => details?.remote !== true)
        // An embedding model cannot write. Unknown capabilities (an old server) are let through.
        .filter(({ details }) => details?.capabilities === undefined || details.capabilities.includes("completion"))
        .map(({ model, details }) => {
          const notes = [model.size, details?.capabilities?.includes("vision") === true ? "reads photos" : ""].filter(
            (note) => note.length > 0,
          );
          return { id: model.name, label: notes.length === 0 ? model.name : `${model.name} (${notes.join(", ")})` };
        });
    } catch {
      return [];
    }
  }

  function contextLimit(details: OllamaModelDetails): number {
    return Math.min(maxContextTokens, details.contextLength ?? maxContextTokens);
  }

  async function maxTextChars(model?: string, input?: TextBudgetInput): Promise<number | undefined> {
    const { base, local } = address();
    if (!local) return undefined;
    try {
      const name = model ?? options.defaultModel ?? (await installed(base))[0]?.name;
      if (name === undefined || !isModelId(name)) return undefined;
      const details = await show(base, name);
      if (details === undefined) return undefined;
      // A model without vision is refused before anything is sent, so its photos cost nothing here.
      const sees = details.capabilities === undefined || details.capabilities.includes("vision");
      const taken = (sees ? (input?.images ?? 0) * IMAGE_TOKENS * CHARS_PER_TOKEN : 0) + (input?.instructionChars ?? 0);
      return Math.max(0, textBudgetFor(contextLimit(details)) - taken);
    } catch {
      return undefined;
    }
  }

  /** The model to use when none was chosen: the first installed one that can do the job. */
  async function pickModel(base: string, needsVision: boolean, signal: AbortSignal): Promise<string> {
    const models = await installed(base, signal);
    if (models.length === 0) throw failure("model-unavailable", LABEL, NO_MODEL);
    let firstWriter: string | undefined;
    for (const model of models.slice(0, 50)) {
      const details = await show(base, model.name, signal);
      if (details === undefined || details.remote) continue;
      if (details.capabilities !== undefined && !details.capabilities.includes("completion")) continue;
      firstWriter ??= model.name;
      if (!needsVision || details.capabilities === undefined || details.capabilities.includes("vision")) return model.name;
    }
    if (firstWriter === undefined) throw failure("model-unavailable", LABEL, NO_MODEL);
    // Only models without vision: name the one that would be used, and say what is missing.
    return firstWriter;
  }

  async function generate(request: GenerateRequest): Promise<string> {
    if (request.signal.aborted) throw failure("cancelled", LABEL);
    const { base, local } = address();
    // Before anything is read or sent: the material stays on this computer, or the request fails.
    if (!local) throw failure("failed", LABEL, REMOTE_HOST_SENTENCE);

    const asked = request.model ?? options.defaultModel;
    if (asked !== undefined && !isModelId(asked)) throw failure("model-unavailable", LABEL);
    if (asked !== undefined && isCloudModelName(asked)) throw failure("model-unavailable", LABEL, cloudModelSentence(asked));

    // Ollama takes pictures, not PDFs: a `file` part is refused as `invalid-request`.
    const attachments = await loadAttachments(request.parts, request.workingDirectory, { allowPdf: false, label: LABEL });
    const images = attachments.map((file) => file.base64);

    try {
      const model = asked ?? (await pickModel(base, images.length > 0, request.signal));
      const details = await show(base, model, request.signal);
      if (details === undefined) {
        throw failure(
          "model-unavailable",
          LABEL,
          `The model ${model} is not installed in Ollama. Open a terminal and run "ollama pull ${model}", or pick another model in Settings.`,
        );
      }
      if (details.remote || isCloudModelName(model)) throw failure("model-unavailable", LABEL, cloudModelSentence(model));
      if (details.capabilities !== undefined && !details.capabilities.includes("completion")) {
        throw failure("model-unavailable", LABEL, `The model ${model} cannot write text. Pick another model in Settings.`);
      }
      // Checked before anything is sent: a model without vision would ignore the photos or fail.
      if (images.length > 0 && details.capabilities !== undefined && !details.capabilities.includes("vision")) {
        throw failure("model-unavailable", LABEL, `This material has photos, and the model ${model} ${NO_VISION}`);
      }

      const prompt = assemblePrompt({
        instructions: request.instructions,
        parts: request.parts,
        files: "attachments",
        ...(options.makeCode === undefined ? {} : { makeCode: options.makeCode }),
      });
      const system =
        request.jsonSchema === undefined
          ? prompt.system
          : `${prompt.system}\n\n## Answer format\nAnswer with one JSON object and nothing else: no Markdown, no code fence, no text before or after. It must match this JSON schema:\n${JSON.stringify(request.jsonSchema)}`;

      const numCtx = contextFor(system.length + prompt.user.length, images.length, contextLimit(details));
      if (numCtx === undefined) {
        log("ollama: request does not fit the context", { chars: system.length + prompt.user.length, images: images.length, limit: contextLimit(details) });
        throw failure(
          "too-large",
          LABEL,
          "This is more material than the local model can read in one go. Try again with fewer or shorter files, or pick a larger model in Settings.",
        );
      }

      const send = async (format: unknown): Promise<string> => {
        let answer = "";
        let streamError: string | undefined;
        let doneReason = "";
        let finished = false;
        let promptTokens = 0;
        const result = await call({
          base,
          method: "POST",
          path: "/api/chat",
          body: {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt.user, ...(images.length === 0 ? {} : { images }) },
            ],
            stream: true,
            ...(format === undefined ? {} : { format }),
            options: { num_ctx: numCtx },
          },
          signal: request.signal,
          timeoutMs,
          maxBytes: MAX_ANSWER_BYTES,
          onLine: (line) => {
            const chunk = parseObject(line);
            if (chunk === undefined) return;
            if (typeof chunk["error"] === "string") {
              streamError = chunk["error"];
              return;
            }
            const message = chunk["message"];
            if (typeof message === "object" && message !== null) {
              // `message.thinking` (a reasoning model's notes) is not part of the answer.
              const content = (message as { content?: unknown }).content;
              if (typeof content === "string") answer += content;
            }
            if (chunk["done"] === true) {
              finished = true;
              if (typeof chunk["done_reason"] === "string") doneReason = chunk["done_reason"];
              if (typeof chunk["prompt_eval_count"] === "number") promptTokens = chunk["prompt_eval_count"];
            }
          },
        });

        if (result.status !== 200) {
          const text = parseObject(result.text)?.["error"];
          throw new OllamaError(result.status, typeof text === "string" ? text : "");
        }
        if (streamError !== undefined) throw new OllamaError(500, streamError);
        if (!finished) throw new CallFailure("network");
        if (doneReason === "length") {
          throw failure(
            "too-large",
            LABEL,
            "The local model ran out of room before the answer was finished. Try again with less material, or ask for fewer cards or questions.",
          );
        }
        if (promptTokens >= numCtx) {
          // The server filled the whole context: the start of the material was dropped.
          log("ollama: the prompt filled the context", { promptTokens, numCtx });
          throw failure(
            "too-large",
            LABEL,
            "This is more material than the local model can read in one go. Try again with fewer or shorter files, or pick a larger model in Settings.",
          );
        }
        return answer;
      };

      let text: string;
      try {
        text = await send(request.jsonSchema);
      } catch (error) {
        // A server older than 0.5.0 knows only `format: "json"`.
        const oldFormat = error instanceof OllamaError && error.status === 400 && /format/i.test(error.text);
        if (!oldFormat || request.jsonSchema === undefined) throw error;
        log("ollama: schema format refused, using plain JSON mode", {});
        text = await send("json");
      }
      if (request.signal.aborted) throw failure("cancelled", LABEL);

      if (request.jsonSchema !== undefined) {
        const json = stripCodeFence(text);
        try {
          JSON.parse(json);
        } catch {
          log("ollama: structured answer is not JSON", { chars: text.length });
          throw failure("bad-output", LABEL);
        }
        return json;
      }
      const answer = text.trim();
      if (answer.length === 0) {
        log("ollama: empty answer", {});
        throw failure("bad-output", LABEL);
      }
      return answer;
    } catch (error) {
      if (request.signal.aborted) throw failure("cancelled", LABEL);
      if (error instanceof OllamaError) {
        // The server's own short message. It can name the model, never the material.
        log("ollama: server reported a problem", { status: error.status, message: error.text.slice(0, 300) });
        throw sentenceForServerError(error);
      }
      throw fromCall(error, local);
    }
  }

  return {
    id: "ollama",
    label: LABEL,
    // The real list depends on what is installed: see `listModels`.
    suggestedModels: [],
    detect,
    generate,
    listModels,
    maxTextChars,
  };
}

class OllamaError extends Error {
  readonly status: number;
  readonly text: string;
  constructor(status: number, text: string) {
    super("ollama error");
    this.name = "OllamaError";
    this.status = status;
    this.text = text;
  }
}

const cloudModelSentence = (model: string): string =>
  `${model} is a cloud model: Ollama would send your material to its servers. Pick a model that runs on this computer in Settings.`;

/** The sentence for an error the server answered with. */
export function sentenceForServerError(error: { status: number; text: string }): ProviderFailure {
  // The start of the server's text says what went wrong; it may send megabytes.
  const text = error.text.slice(0, 2_000).toLowerCase();
  if (error.status === 404 || /model .*not found|pull/.test(text)) {
    return failure(
      "model-unavailable",
      LABEL,
      'The chosen model is not installed in Ollama. Open a terminal and run "ollama pull" with its name, or pick another model in Settings.',
    );
  }
  if (/does not support (image|vision)|vision|multimodal|image input/.test(text)) {
    return failure("model-unavailable", LABEL, `This material has photos, and the chosen model ${NO_VISION}`);
  }
  if (/memory|vram|out of ram|oom/.test(text)) {
    return failure(
      "failed",
      LABEL,
      "This computer does not have enough free memory for the chosen model. Close other programs, or pick a smaller model in Settings.",
    );
  }
  if (/context|too long|exceed/.test(text)) return failure("too-large", LABEL);
  if (error.status === 401 || error.status === 403) {
    return failure("not-signed-in", LABEL, "Ollama asked for a sign-in, which only its cloud models need. Pick a model that runs on this computer in Settings.");
  }
  if (error.status === 429) return failure("usage-limit", LABEL);
  if (error.status === 502 || error.status === 503) return failure("busy", LABEL, "Ollama is busy or still loading the model. Wait a minute and try again.");
  if (error.status === 400) return failure("invalid-request", LABEL);
  return failure(
    "failed",
    LABEL,
    "Ollama ran into a problem while running the model. Try again; if it keeps failing, restart Ollama or pick a smaller model in Settings.",
  );
}

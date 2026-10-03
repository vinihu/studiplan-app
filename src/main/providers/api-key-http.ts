/**
 * The one HTTP call the vendor clients make, and the types they share.
 *
 * One POST with a JSON body, the user's cancel wired to `fetch`, a time limit, a cap on the
 * size of the answer, and no redirects — so a key in a header can never be forwarded to a host
 * other than the one the client named.
 */
import type { ProviderErrorCode } from "@shared/providers";
import type { LoadedAttachment } from "./api-key-attachments";

/** What a vendor client turns into a request. */
export interface VendorInput {
  apiKey: string;
  model: string;
  /** The assembled system prompt: the app's instructions and the material rules. */
  system: string;
  /** The material text, wrapped in markers by `assemblePrompt`. */
  user: string;
  attachments: readonly LoadedAttachment[];
  jsonSchema?: object | undefined;
}

export interface VendorRequest {
  url: string;
  /** The key is in exactly one of these and nowhere else in the request. */
  headers: Record<string, string>;
  body: unknown;
}

export interface VendorResponse {
  status: number;
  /** The raw body. May be anything when the status is not 200. */
  text: string;
}

/** Why a vendor's answer cannot be used, before it becomes a sentence. */
export type VendorProblem =
  | ProviderErrorCode
  | "key-rejected" // 401/403: the key is wrong, revoked or not allowed
  | "out-of-credit" // billing: no credit, spend limit reached
  | "declined" // the model or a safety filter refused
  | "cut-off"; // the answer hit the output limit

export class VendorFailure extends Error {
  readonly problem: VendorProblem;
  /** The vendor's own short message, for the log only. Redact before logging. */
  readonly detail: string;

  constructor(problem: VendorProblem, detail = "") {
    super(problem);
    this.name = "VendorFailure";
    this.problem = problem;
    this.detail = detail;
  }
}

export interface VendorClient {
  /** The only host this client talks to. */
  readonly host: string;
  /** The largest request body the vendor documents, in bytes. */
  readonly maxRequestBytes: number;
  buildRequest(input: VendorInput): VendorRequest;
  /** The answer text, or a `VendorFailure`. */
  readResponse(response: VendorResponse): string;
}

export type HttpFailureKind = "aborted" | "timed-out" | "too-large" | "network" | "insecure";

export class HttpFailure extends Error {
  readonly kind: HttpFailureKind;
  /** The error's code (`ENOTFOUND`, …) when there is one. Never a URL or a header. */
  readonly errno: string | undefined;

  constructor(kind: HttpFailureKind, errno?: string) {
    super(kind);
    this.name = "HttpFailure";
    this.kind = kind;
    this.errno = errno;
  }
}

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  /** Already serialised. */
  body: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof fetch;
  /** The environment to look at for `NODE_TLS_REJECT_UNAUTHORIZED`. Replaced in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * True when certificate checks are switched off for this process. `fetch` here is Node's, and
 * Node then accepts any certificate: whoever sits between this computer and the vendor could
 * read the key and the material. The variable is sometimes set for another tool and forgotten.
 */
export function certificateChecksAreOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0";
}

function errnoOf(error: unknown): string | undefined {
  // `fetch` wraps the real reason: TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }).
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Sends the request and returns the status and the whole body as text.
 * Rejects only with an `HttpFailure`.
 */
export async function postJson(options: PostOptions): Promise<VendorResponse> {
  const send = options.fetch ?? fetch;
  if (options.signal.aborted) throw new HttpFailure("aborted");
  // Before anything is sent.
  if (certificateChecksAreOff(options.env)) throw new HttpFailure("insecure");

  const controller = new AbortController();
  let timedOut = false;
  const stop = (): void => controller.abort();
  options.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);

  const fail = (error: unknown): HttpFailure => {
    if (error instanceof HttpFailure) return error;
    if (options.signal.aborted) return new HttpFailure("aborted");
    if (timedOut) return new HttpFailure("timed-out");
    const errno = errnoOf(error);
    // Node's `fetch` gives up on its own after five minutes without response headers.
    if (errno === "UND_ERR_HEADERS_TIMEOUT" || errno === "UND_ERR_BODY_TIMEOUT") return new HttpFailure("timed-out", errno);
    return new HttpFailure("network", errno);
  };

  try {
    const response = await send(options.url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      // A redirect would carry the key to wherever it points.
      redirect: "error",
      // No cookies, no cache: nothing about a request outlives it.
      credentials: "omit",
      cache: "no-store",
    });

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
      stop();
      throw new HttpFailure("too-large");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxResponseBytes) {
          stop();
          await reader.cancel().catch(() => {});
          throw new HttpFailure("too-large");
        }
        chunks.push(value);
      }
    }
    return { status: response.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    throw fail(error);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
  }
}

/** `JSON.parse` that returns `undefined` instead of throwing, and only for an object. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The problem behind an HTTP error status, from the status and the vendor's message. The
 * statuses mean the same at all three vendors; each client adds what is its own before
 * falling back to this.
 */
export function classifyStatus(status: number, message: string): VendorProblem {
  const text = message.toLowerCase();
  if (status === 401) return "key-rejected";
  if (status === 402) return "out-of-credit";
  if (status === 404) return "model-unavailable";
  if (status === 413) return "too-large";
  if (status === 429) {
    return /quota|credit|billing|spend|budget|usage limit|insufficient|plan/.test(text) ? "out-of-credit" : "usage-limit";
  }
  if (status === 504) return "timed-out";
  if (status >= 500) return "busy";
  if (status === 403) {
    return /model/.test(text) ? "model-unavailable" : "key-rejected";
  }
  if (status === 400 || status === 422 || status === 416) {
    if (/api[ _-]?key/.test(text)) return "key-rejected";
    if (/credit balance|billing|payment|prepay/.test(text)) return "out-of-credit";
    if (/too long|too large|too many|context (length|window)|exceeds? (the )?(maximum|limit|context)|maximum (context|number of)|token limit|page limit|size limit/.test(text)) {
      return "too-large";
    }
    if (/model/.test(text) && /not (found|exist|supported|available)|does not exist|unknown|invalid model|no access/.test(text)) {
      return "model-unavailable";
    }
    if (/schema|response_format|output_config|text\.format|unknown parameter|unrecognized|extra inputs|invalid json|malformed/.test(text)) {
      return "invalid-request";
    }
    return "failed";
  }
  return "failed";
}

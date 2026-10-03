/**
 * The API-key provider: one provider, three vendors behind it (Anthropic, OpenAI, Google).
 *
 * The user saves a key per vendor (`api-key-store.ts`) and picks a model. The vendor of a
 * request follows from the model's name (`claude-…`, `gpt-…`, `gemini-…`); with no model chosen
 * it is the first vendor that has a key, with that vendor's default model.
 *
 * One request per `generate`, not streamed: Node's `fetch` gives up after five minutes without
 * response headers, so the time limit here is just under that. The key goes into one header of
 * one request to the vendor's own host and nowhere else: not into the log, an error message,
 * a URL, or the environment or arguments of any process.
 */
import { isModelId, PROVIDER_LABELS } from "@shared/providers";
import type { ProviderDetection, ProviderModel } from "@shared/providers";
import { anthropicClient } from "./api-key-anthropic";
import { loadAttachments } from "./api-key-attachments";
import { googleClient } from "./api-key-google";
import { HttpFailure, postJson, VendorFailure, type VendorClient, type VendorProblem } from "./api-key-http";
import { openaiClient } from "./api-key-openai";
import {
  API_KEY_VENDORS,
  redactSecrets,
  VENDOR_LABELS,
  type ApiKeyStore,
  type ApiKeyVendor,
} from "./api-key-store";
import { consoleLog, failure, ProviderFailure, type ProviderLog } from "./errors";
import { stripCodeFence } from "./fence";
import { assemblePrompt } from "./prompt";
import type { GenerateRequest, Provider } from "./provider";

const LABEL = "The API key";

/**
 * Models offered per vendor. The first of each list is the vendor's default: capable, and not
 * the most expensive. Taken on 2026-10-02 from:
 * - Anthropic: the model table of the Claude API reference (cached 2026-09-25) —
 *   platform.claude.com/docs/en/about-claude/models/overview
 * - OpenAI: developers.openai.com/api/docs/models
 * - Google: ai.google.dev/gemini-api/docs/models
 */
export const API_KEY_MODELS: Record<ApiKeyVendor, readonly ProviderModel[]> = {
  anthropic: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 (Anthropic, recommended)" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Anthropic, cheaper)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic, cheapest)" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1 (Anthropic, strongest, most expensive)" },
  ],
  openai: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (OpenAI, recommended)" },
    { id: "gpt-6-luna", label: "GPT-6 Luna (OpenAI, cheaper)" },
    { id: "gpt-6-astra", label: "GPT-6 Astra (OpenAI, strongest, most expensive)" },
  ],
  google: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Google, recommended)" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (Google, cheaper)" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro preview (Google, strongest)" },
  ],
};

export const API_KEY_SUGGESTED_MODELS: readonly ProviderModel[] = API_KEY_VENDORS.flatMap((vendor) => API_KEY_MODELS[vendor]);

/** Just under the five minutes after which Node's `fetch` gives up waiting for an answer. */
export const DEFAULT_TIMEOUT_MS = 280 * 1000;

/** The largest answer read. The longest real answer is a few hundred kilobytes. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Kept free in a request for the instructions, the material text and the JSON around them. */
export const REQUEST_TEXT_RESERVE_BYTES = 1024 * 1024;

const CLIENTS: Record<ApiKeyVendor, VendorClient> = {
  anthropic: anthropicClient,
  openai: openaiClient,
  google: googleClient,
};

/** The hosts this provider may contact. Nothing else is ever requested. */
export const API_KEY_HOSTS: Record<ApiKeyVendor, string> = {
  anthropic: anthropicClient.host,
  openai: openaiClient.host,
  google: googleClient.host,
};

/** The vendor a model name belongs to, or `undefined` when the name does not say. */
export function vendorOfModel(model: string): ApiKeyVendor | undefined {
  const name = model.toLowerCase();
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gemini") || name.startsWith("gemma") || name.startsWith("models/")) return "google";
  if (/^(gpt|chatgpt|o\d|codex)/.test(name)) return "openai";
  return undefined;
}

const NO_KEY = "No API key is saved yet. Paste a key from Anthropic, OpenAI or Google in Settings, then try again.";
const NO_KEY_DETAIL = "No API key is saved yet.";

function sentenceFor(problem: VendorProblem, vendor: ApiKeyVendor): ProviderFailure {
  const name = VENDOR_LABELS[vendor];
  const label = `${name} (API key)`;
  switch (problem) {
    case "key-rejected":
      return failure(
        "not-signed-in",
        label,
        `${name} did not accept the API key. It may be mistyped or revoked, or its account may not be set up for the API yet. Remove it in Settings and paste it again.`,
      );
    case "out-of-credit":
      return failure(
        "usage-limit",
        label,
        `The ${name} account behind this API key has no credit or quota left. Check its billing page, wait until the quota resets, or choose another AI in Settings.`,
      );
    case "usage-limit":
      return failure(
        "usage-limit",
        label,
        `${name} is limiting how fast this API key may send requests. Wait a minute and try again, or try with less material.`,
      );
    case "declined":
      return failure(
        "bad-output",
        label,
        `${name}'s model declined to answer for this material (its safety filter stopped it). Try another model or another AI in Settings.`,
      );
    case "cut-off":
      return failure(
        "too-large",
        label,
        `The answer from ${name} was cut off before it was finished. Try again with less material, or ask for fewer cards or questions.`,
      );
    case "model-unavailable":
      return failure(
        "model-unavailable",
        label,
        `${name} does not offer the chosen model to this API key. Pick another model in Settings.`,
      );
    default:
      return failure(problem, label);
  }
}

export interface ApiKeyProviderOptions {
  store: ApiKeyStore;
  /** Used when a request names no model. Left out, the vendor's first suggested model is used. */
  defaultModel?: string;
  /**
   * The vendor to use when the model's name does not say which one it belongs to (a model id
   * typed by hand). Left out, the first vendor with a saved key.
   */
  vendor?: () => ApiKeyVendor | undefined | Promise<ApiKeyVendor | undefined>;
  /** How long one request may take. Default and upper limit: 280 seconds. */
  timeoutMs?: number;
  log?: ProviderLog;
  // For tests.
  fetch?: typeof fetch;
  clients?: Partial<Record<ApiKeyVendor, VendorClient>>;
  makeCode?: () => string;
}

export function createApiKeyProvider(options: ApiKeyProviderOptions): Provider {
  const { store } = options;
  const log = options.log ?? consoleLog;
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const clients = { ...CLIENTS, ...options.clients };

  async function detect(): Promise<ProviderDetection> {
    try {
      const saved = await store.saved();
      if (saved.length === 0) {
        return { available: false, status: "not-signed-in", detail: NO_KEY_DETAIL };
      }
      const names = saved.map((vendor) => VENDOR_LABELS[vendor]).join(", ");
      return {
        available: true,
        status: "ready",
        detail: `An API key is saved for ${names}. Press Test to check that it works.`,
      };
    } catch {
      return { available: false, status: "error", detail: "The saved API key could not be checked. Try again." };
    }
  }

  /** Which vendor, key and model a request uses. */
  async function resolve(request: GenerateRequest): Promise<{ vendor: ApiKeyVendor; apiKey: string; model: string }> {
    const asked = request.model ?? options.defaultModel;
    if (asked !== undefined && !isModelId(asked)) throw failure("model-unavailable", LABEL);

    const saved = await store.saved();
    if (saved.length === 0) throw failure("not-signed-in", LABEL, NO_KEY);

    const vendor = (asked === undefined ? undefined : vendorOfModel(asked)) ?? (await options.vendor?.()) ?? saved[0];
    if (vendor === undefined) throw failure("not-signed-in", LABEL, NO_KEY);

    const apiKey = await store.get(vendor);
    if (apiKey === undefined) {
      throw failure(
        "not-signed-in",
        LABEL,
        saved.includes(vendor)
          ? `The saved ${VENDOR_LABELS[vendor]} key can no longer be read on this computer. Paste it again in Settings.`
          : `The chosen model is from ${VENDOR_LABELS[vendor]}, but no ${VENDOR_LABELS[vendor]} key is saved. Paste one in Settings, or pick a model from ${saved.map((item) => VENDOR_LABELS[item]).join(" or ")}.`,
      );
    }

    // A hand-typed model with the `models/` prefix Google's own listings use.
    const named = asked === undefined ? undefined : vendor === "google" ? asked.replace(/^models\//, "") : asked;
    const model = named ?? API_KEY_MODELS[vendor][0]?.id;
    if (model === undefined) throw failure("model-unavailable", LABEL);
    return { vendor, apiKey, model };
  }

  async function generate(request: GenerateRequest): Promise<string> {
    if (request.signal.aborted) throw failure("cancelled", LABEL);

    const { vendor, apiKey, model } = await resolve(request);
    const label = `${VENDOR_LABELS[vendor]} (API key)`;
    const client = clients[vendor];

    // Throws `invalid-request` for a file outside the material's folder, `too-large` past the budget.
    const attachments = await loadAttachments(request.parts, request.workingDirectory, { allowPdf: true, label });
    if (request.signal.aborted) throw failure("cancelled", label);

    const prompt = assemblePrompt({
      instructions: request.instructions,
      parts: request.parts,
      files: "attachments",
      ...(options.makeCode === undefined ? {} : { makeCode: options.makeCode }),
    });

    const built = client.buildRequest({
      apiKey,
      model,
      system: prompt.system,
      user: prompt.user,
      attachments,
      jsonSchema: request.jsonSchema,
    });

    // The only host a key is ever sent to is the vendor's own, over TLS.
    const url = new URL(built.url);
    if (url.protocol !== "https:" || url.host !== client.host) {
      log("api-key: refused a request to an unexpected host", { vendor });
      throw failure("invalid-request", label);
    }

    const body = JSON.stringify(built.body);
    if (Buffer.byteLength(body, "utf8") > client.maxRequestBytes) {
      log("api-key: request too large for the vendor", { vendor, bytes: body.length });
      throw failure("too-large", label);
    }

    let text: string;
    try {
      const response = await postJson({
        url: built.url,
        headers: built.headers,
        body,
        signal: request.signal,
        timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (request.signal.aborted) throw new HttpFailure("aborted");
      text = client.readResponse(response);
    } catch (error) {
      if (error instanceof HttpFailure) {
        log("api-key: request did not complete", { vendor, kind: error.kind, errno: error.errno });
        switch (error.kind) {
          case "aborted":
            throw failure("cancelled", label);
          case "timed-out":
            throw failure("timed-out", label);
          case "too-large":
            throw failure("too-large", label);
          case "network":
            throw failure("offline", label);
          case "insecure":
            throw failure(
              "failed",
              label,
              "Certificate checks are switched off on this computer (NODE_TLS_REJECT_UNAUTHORIZED is 0), so Studiplan will not send your key or your material. Remove that setting, restart Studiplan and try again.",
            );
        }
      }
      if (error instanceof VendorFailure) {
        // The vendor's own message: short, and with anything key-shaped removed.
        log("api-key: vendor reported a problem", {
          vendor,
          model,
          problem: error.problem,
          detail: redactSecrets(error.detail, [apiKey]).slice(0, 300),
        });
        throw sentenceFor(error.problem, vendor);
      }
      if (error instanceof ProviderFailure) throw error;
      log("api-key: unexpected error", { vendor, name: error instanceof Error ? error.name : typeof error });
      throw failure("failed", label);
    }

    if (request.jsonSchema !== undefined) {
      const json = stripCodeFence(text);
      try {
        JSON.parse(json);
      } catch {
        log("api-key: structured answer is not JSON", { vendor, model, chars: text.length });
        throw failure("bad-output", label);
      }
      return json;
    }

    const answer = text.trim();
    if (answer.length === 0) {
      log("api-key: empty answer", { vendor, model });
      throw failure("bad-output", label);
    }
    return answer;
  }

  /** The models of the vendors that have a key; every suggested model while none has. */
  async function listModels(): Promise<ProviderModel[]> {
    try {
      const saved = await store.saved();
      return saved.length === 0 ? [...API_KEY_SUGGESTED_MODELS] : saved.flatMap((vendor) => API_KEY_MODELS[vendor]);
    } catch {
      return [...API_KEY_SUGGESTED_MODELS];
    }
  }

  /**
   * The files one request can carry: the vendor's request limit, less room for the text, and
   * less the third that base64 adds. Google: 20 MB per request, so about 14 MB of files.
   */
  async function maxAttachmentBytes(model?: string): Promise<number | undefined> {
    try {
      const asked = model ?? options.defaultModel;
      const vendor = (asked === undefined ? undefined : vendorOfModel(asked)) ?? (await options.vendor?.()) ?? (await store.saved())[0];
      if (vendor === undefined) return undefined;
      return Math.floor(((clients[vendor].maxRequestBytes - REQUEST_TEXT_RESERVE_BYTES) * 3) / 4);
    } catch {
      return undefined;
    }
  }

  return {
    id: "api-key",
    label: PROVIDER_LABELS["api-key"],
    suggestedModels: API_KEY_SUGGESTED_MODELS,
    // All three vendors read a PDF's pages as pictures as well as text. The file goes whole.
    readsScannedPdfs: true,
    detect,
    generate,
    listModels,
    maxAttachmentBytes,
  };
}

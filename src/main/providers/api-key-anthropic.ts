/**
 * The Anthropic client: one `POST https://api.anthropic.com/v1/messages`.
 *
 * Shapes taken from the Claude API reference (the `claude-api` skill bundled with Claude Code,
 * cached 2026-09-25) and platform.claude.com/docs/en/build-with-claude/structured-outputs and
 * /pdf-support, read on 2026-10-02. Not exercised against the real API: no key was available.
 *
 * - Auth: `x-api-key`. Version: `anthropic-version: 2023-06-01`. No beta header.
 * - Structured output: `output_config.format = { type: "json_schema", schema }`; the JSON comes
 *   back as the text block. Every object in the schema must have `additionalProperties: false`;
 *   no recursion, no `minimum`/`maximum`, no `minLength`/`maxLength`, `minItems` only 0 or 1.
 * - A photo is an `image` block and a PDF a `document` block, both base64, placed before the
 *   text. A PDF's pages are read as text and as pictures, so a scan works. Limits: 32 MB per
 *   request, 600 pages (100 for models with a context window under 1M tokens).
 * - `thinking`, `effort` and sampling parameters are left out on purpose: which of them a model
 *   accepts differs between models, and leaving them out is valid for all of them.
 */
import {
  asArray,
  asObject,
  asString,
  classifyStatus,
  parseObject,
  VendorFailure,
  type VendorClient,
  type VendorInput,
  type VendorRequest,
  type VendorResponse,
} from "./api-key-http";

export const ANTHROPIC_HOST = "api.anthropic.com";
const ENDPOINT = `https://${ANTHROPIC_HOST}/v1/messages`;
const API_VERSION = "2023-06-01";

/**
 * The most the model may write, thinking included. Without streaming this also bounds how long
 * the single response can take; 32,000 tokens is far more than the longest mock exam.
 */
export const ANTHROPIC_MAX_TOKENS = 32_000;

function buildRequest(input: VendorInput): VendorRequest {
  const content: unknown[] = input.attachments.map((file) => ({
    type: file.kind === "pdf" ? "document" : "image",
    source: { type: "base64", media_type: file.mediaType, data: file.base64 },
  }));
  content.push({ type: "text", text: input.user });

  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: input.system,
    messages: [{ role: "user", content }],
  };
  if (input.jsonSchema !== undefined) {
    body["output_config"] = { format: { type: "json_schema", schema: input.jsonSchema } };
  }

  return {
    url: ENDPOINT,
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": API_VERSION,
    },
    body,
  };
}

function readResponse(response: VendorResponse): string {
  const body = parseObject(response.text);

  if (response.status !== 200) {
    const error = asObject(body?.["error"]);
    const type = asString(error?.["type"]);
    const message = asString(error?.["message"]);
    const detail = `${response.status} ${type} ${message}`.trim();
    switch (type) {
      case "authentication_error":
        throw new VendorFailure("key-rejected", detail);
      case "billing_error":
        throw new VendorFailure("out-of-credit", detail);
      case "rate_limit_error":
        throw new VendorFailure("usage-limit", detail);
      case "overloaded_error":
      case "api_error":
        throw new VendorFailure("busy", detail);
      case "request_too_large":
        throw new VendorFailure("too-large", detail);
      case "not_found_error":
        throw new VendorFailure("model-unavailable", detail);
      default:
        throw new VendorFailure(classifyStatus(response.status, message), detail);
    }
  }

  if (body === undefined) throw new VendorFailure("bad-output", "200 without a JSON body");

  const stopReason = asString(body["stop_reason"]);
  if (stopReason === "refusal") {
    const category = asString(asObject(body["stop_details"])?.["category"]);
    throw new VendorFailure("declined", `refusal ${category}`.trim());
  }

  const text = asArray(body["content"])
    .map((block) => asObject(block))
    .filter((block) => block?.["type"] === "text")
    .map((block) => asString(block?.["text"]))
    .join("");

  // Cut off at the output limit: structured output is then not valid JSON, and prose stops
  // in the middle of a sentence.
  if (stopReason === "max_tokens") throw new VendorFailure("cut-off", "max_tokens");
  return text;
}

export const anthropicClient: VendorClient = {
  host: ANTHROPIC_HOST,
  maxRequestBytes: 32 * 1024 * 1024,
  buildRequest,
  readResponse,
};

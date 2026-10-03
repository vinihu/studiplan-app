/**
 * The Google (Gemini API) client: one
 * `POST https://generativelanguage.googleapis.com/v1beta/interactions` (the Interactions API,
 * which Google's docs call generally available since June 2026 and recommend for new projects;
 * `generateContent` is described there as "legacy" but still supported).
 *
 * Shapes taken from ai.google.dev/gemini-api/docs on 2026-10-02: "Interactions API",
 * "Structured outputs", "Image understanding", "Document understanding", "API errors", and the
 * reference at ai.google.dev/api/interactions-api. Not exercised against the real API: no key
 * was available.
 *
 * - Auth: `x-goog-api-key` header (never the `?key=` query form, which would put the key in a
 *   URL). No version header; the version is the `/v1beta/` in the path.
 * - `store: false`: Google otherwise keeps every interaction (55 days, 1 day on the free tier).
 * - Structured output: `response_format = { type: "text", mime_type: "application/json",
 *   schema }`. A subset of JSON Schema: `type`, `properties`, `required`,
 *   `additionalProperties`, `items`, `enum`, `description`, `minimum`/`maximum`,
 *   `minItems`/`maxItems`, `format`; very large or deeply nested schemas may be rejected.
 * - A photo is `{ type: "image", data, mime_type }` and a PDF `{ type: "document", data,
 *   mime_type: "application/pdf" }`, both base64. PDFs are read with vision, so a scan works.
 *   Limits: 20 MB for the whole request with inline data, 1,000 pages per PDF.
 * - No `max_output_tokens`: the model's own maximum applies.
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
  type VendorProblem,
  type VendorRequest,
  type VendorResponse,
} from "./api-key-http";

export const GOOGLE_HOST = "generativelanguage.googleapis.com";
const ENDPOINT = `https://${GOOGLE_HOST}/v1beta/interactions`;

function buildRequest(input: VendorInput): VendorRequest {
  const content: unknown[] = input.attachments.map((file) => ({
    type: file.kind === "pdf" ? "document" : "image",
    data: file.base64,
    mime_type: file.mediaType,
  }));
  content.push({ type: "text", text: input.user });

  const body: Record<string, unknown> = {
    model: input.model,
    input: content,
    system_instruction: input.system,
    store: false,
  };
  if (input.jsonSchema !== undefined) {
    body["response_format"] = { type: "text", mime_type: "application/json", schema: input.jsonSchema };
  }

  return {
    url: ENDPOINT,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": input.apiKey,
    },
    body,
  };
}

const BLOCKED = /safety|prohibited|recitation|spii|blocklist|blocked/i;

/**
 * The error code as text. The Interactions API documents a string (`"authentication"`,
 * `"quota_exceeded"`, …); the older endpoints send a number plus `status`
 * (`"RESOURCE_EXHAUSTED"`). Both are read.
 */
function codeOf(error: Record<string, unknown> | undefined): string {
  const code = error?.["code"];
  const status = asString(error?.["status"]);
  return `${typeof code === "string" ? code : ""} ${status}`.trim().toLowerCase();
}

function problemFor(status: number, code: string, message: string): VendorProblem {
  if (/authentication|unauthenticated|api_key_invalid/.test(code) || /api key (not valid|expired|is missing|was reported)/i.test(message)) {
    return "key-rejected";
  }
  if (/payment_required/.test(code)) return "out-of-credit";
  if (/quota_exceeded/.test(code)) return "out-of-credit";
  if (/rate_limit_exceeded/.test(code)) return "usage-limit";
  if (/model_not_found/.test(code)) return "model-unavailable";
  if (/service_unavailable|unavailable|internal/.test(code)) return "busy";
  if (/deadline_exceeded/.test(code)) return "timed-out";
  if (BLOCKED.test(code)) return "declined";
  // `failed_precondition`: the free tier is not offered in the user's country and no billing
  // is set up. Nothing the key or the model can fix; the sentence for a rejected key says to
  // check the key's account.
  if (/failed_precondition/.test(code)) return "key-rejected";
  return classifyStatus(status, message);
}

/**
 * The body of an error answer. The real service wraps some errors in a one-element array
 * (seen on 2026-10-02 for an invalid key: `[{ "error": { "code": 400, "message": "API key not
 * valid. …", "status": "INVALID_ARGUMENT", "details": [{ "reason": "API_KEY_INVALID" }] } }]`).
 */
function errorBody(text: string): Record<string, unknown> | undefined {
  const body = parseObject(text);
  if (body !== undefined) return body;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? asObject(value[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** The `reason` of the error's details (`API_KEY_INVALID`, …), as text. */
function reasonsOf(error: Record<string, unknown> | undefined): string {
  return asArray(error?.["details"])
    .map((detail) => asString(asObject(detail)?.["reason"]))
    .filter((reason) => reason.length > 0)
    .join(" ")
    .toLowerCase();
}

function readResponse(response: VendorResponse): string {
  const body = response.status === 200 ? parseObject(response.text) : errorBody(response.text);

  if (response.status !== 200) {
    const error = asObject(body?.["error"]);
    const code = `${codeOf(error)} ${reasonsOf(error)}`.trim();
    const message = asString(error?.["message"]);
    throw new VendorFailure(problemFor(response.status, code, message), `${response.status} ${code} ${message}`.trim());
  }

  if (body === undefined) throw new VendorFailure("bad-output", "200 without a JSON body");

  const status = asString(body["status"]);
  const errors = asArray(body["errors"]).map((entry) => asObject(entry));
  const errorText = errors.map((entry) => `${codeOf(entry)} ${asString(entry?.["message"])}`.trim()).join("; ");

  if (status === "failed" || status === "cancelled") {
    throw new VendorFailure(BLOCKED.test(errorText) ? "declined" : problemFor(500, errorText, errorText), `${status} ${errorText}`.trim());
  }

  let text = "";
  // `steps` is the documented name; `outputs` was the name during the beta and is read too.
  for (const step of [...asArray(body["steps"]), ...asArray(body["outputs"])]) {
    const entry = asObject(step);
    if (entry === undefined) continue;
    if (entry["type"] === "text") {
      text += asString(entry["text"]);
      continue;
    }
    if (entry["type"] !== "model_output") continue;
    for (const part of asArray(entry["content"])) {
      const piece = asObject(part);
      if (piece?.["type"] === "text") text += asString(piece["text"]);
    }
  }

  if (status === "incomplete") {
    throw new VendorFailure(BLOCKED.test(errorText) ? "declined" : "cut-off", `incomplete ${errorText}`.trim());
  }
  if (text.trim().length === 0 && BLOCKED.test(errorText)) throw new VendorFailure("declined", errorText);
  return text;
}

export const googleClient: VendorClient = {
  host: GOOGLE_HOST,
  maxRequestBytes: 20 * 1024 * 1024,
  buildRequest,
  readResponse,
};

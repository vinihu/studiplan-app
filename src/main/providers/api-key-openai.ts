/**
 * The OpenAI client: one `POST https://api.openai.com/v1/responses` (the Responses API).
 *
 * Shapes taken from developers.openai.com/api/docs on 2026-10-02: the Responses reference and
 * the guides "Structured outputs", "File inputs" (PDF), "Images and vision" and "Error codes".
 * Not exercised against the real API: no key was available.
 *
 * - Auth: `Authorization: Bearer <key>`. No version header.
 * - `store: false`: the request is not kept in the account's stored responses.
 * - Structured output: `text.format = { type: "json_schema", name, strict: true, schema }`.
 *   Strict mode needs the root to be an object, every property listed in `required`, and
 *   `additionalProperties: false` on every object.
 * - A photo is `input_image` with a `data:` URL; a PDF is `input_file` with `filename` and a
 *   `data:application/pdf;base64,` URL. The model gets a PDF's text and a picture of each page.
 *   Limit: 50 MB of files per request.
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

export const OPENAI_HOST = "api.openai.com";
const ENDPOINT = `https://${OPENAI_HOST}/v1/responses`;

/** A file name the API accepts whatever the student called the file. */
function safeFileName(index: number): string {
  return `material-${index + 1}.pdf`;
}

function buildRequest(input: VendorInput): VendorRequest {
  let pdfs = 0;
  const content: unknown[] = input.attachments.map((file) =>
    file.kind === "pdf"
      ? {
          type: "input_file",
          filename: safeFileName(pdfs++),
          file_data: `data:${file.mediaType};base64,${file.base64}`,
        }
      : { type: "input_image", image_url: `data:${file.mediaType};base64,${file.base64}`, detail: "auto" },
  );
  content.push({ type: "input_text", text: input.user });

  const body: Record<string, unknown> = {
    model: input.model,
    instructions: input.system,
    input: [{ role: "user", content }],
    store: false,
  };
  if (input.jsonSchema !== undefined) {
    body["text"] = {
      format: { type: "json_schema", name: "study_set", strict: true, schema: input.jsonSchema },
    };
  }

  return {
    url: ENDPOINT,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body,
  };
}

const OUT_OF_CREDIT = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

function problemFor(status: number, code: string, type: string, message: string): VendorProblem {
  if (OUT_OF_CREDIT.has(code) || type === "insufficient_quota") return "out-of-credit";
  if (code === "invalid_api_key" || type === "authentication_error") return "key-rejected";
  if (code === "model_not_found") return "model-unavailable";
  if (code === "context_length_exceeded" || code === "string_above_max_length") return "too-large";
  if (code === "rate_limit_exceeded") return "usage-limit";
  if (code === "slow_down" || code === "server_is_overloaded" || type === "server_error") return "busy";
  if (code === "content_policy_violation") return "declined";
  return classifyStatus(status, message);
}

function readResponse(response: VendorResponse): string {
  const body = parseObject(response.text);

  if (response.status !== 200) {
    const error = asObject(body?.["error"]);
    const code = asString(error?.["code"]);
    const type = asString(error?.["type"]);
    const message = asString(error?.["message"]);
    throw new VendorFailure(problemFor(response.status, code, type, message), `${response.status} ${type} ${code} ${message}`.trim());
  }

  if (body === undefined) throw new VendorFailure("bad-output", "200 without a JSON body");

  const status = asString(body["status"]);
  if (status === "failed") {
    const error = asObject(body["error"]);
    const code = asString(error?.["code"]);
    const message = asString(error?.["message"]);
    throw new VendorFailure(problemFor(500, code, "", message), `failed ${code} ${message}`.trim());
  }

  let text = "";
  let refused = false;
  for (const item of asArray(body["output"])) {
    const entry = asObject(item);
    if (entry?.["type"] !== "message") continue;
    for (const part of asArray(entry["content"])) {
      const piece = asObject(part);
      if (piece?.["type"] === "output_text") text += asString(piece["text"]);
      else if (piece?.["type"] === "refusal") refused = true;
    }
  }

  if (status === "incomplete") {
    const reason = asString(asObject(body["incomplete_details"])?.["reason"]);
    throw new VendorFailure(reason === "content_filter" ? "declined" : "cut-off", `incomplete ${reason}`.trim());
  }
  if (refused && text.trim().length === 0) throw new VendorFailure("declined", "refusal");
  return text;
}

export const openaiClient: VendorClient = {
  host: OPENAI_HOST,
  maxRequestBytes: 50 * 1024 * 1024,
  buildRequest,
  readResponse,
};

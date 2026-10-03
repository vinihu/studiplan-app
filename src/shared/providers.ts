/**
 * The AI providers as the renderer sees them. No Node or Electron imports: both sides of the
 * bridge use these types.
 */

export const PROVIDER_IDS = ["claude-code", "codex", "ollama", "api-key"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The name of each AI as the user knows it. The providers use these as their labels. */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  ollama: "Ollama",
  "api-key": "API key",
};

/** The services an API key can be from. One key is kept per vendor. */
export const API_KEY_VENDORS = ["anthropic", "openai", "google"] as const;

export type ApiKeyVendor = (typeof API_KEY_VENDORS)[number];

export function isApiKeyVendor(value: unknown): value is ApiKeyVendor {
  return typeof value === "string" && (API_KEY_VENDORS as readonly string[]).includes(value);
}

/** The vendor's name as the user knows it. */
export const VENDOR_LABELS: Readonly<Record<ApiKeyVendor, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/**
 * Which vendors have a key saved. This is all the window ever learns about a key: a key goes
 * to the main process once, when it is saved, and never comes back.
 */
export interface ApiKeyStatus {
  saved: ApiKeyVendor[];
}

/** What `detect()` found. */
export type ProviderStatus =
  | "ready" // installed and, as far as can be told without a request, usable
  | "not-installed"
  | "not-signed-in"
  | "error"; // found, but checking it failed

export interface ProviderDetection {
  /** True only when `status` is `"ready"`. */
  available: boolean;
  status: ProviderStatus;
  /** A plain sentence for Settings. Never contains a path, an account name or an email. */
  detail: string;
  /** The tool's version, when it reported one. */
  version?: string;
}

/** A model the user can pick in Settings. Any other id the provider accepts may be typed in. */
export interface ProviderModel {
  id: string;
  label: string;
}

/** What Settings needs to show one provider. */
export interface ProviderInfo {
  id: ProviderId;
  /** The name shown to the user, e.g. "Claude Code". */
  label: string;
  suggestedModels: readonly ProviderModel[];
}

/** Why a request failed. `message` is a plain sentence that says what to do. */
export type ProviderErrorCode =
  | "not-installed"
  | "not-signed-in"
  | "usage-limit" // the user's plan or credit is used up for now
  | "cancelled" // the user (the abort signal) stopped it
  | "timed-out"
  | "bad-output" // the tool answered, but not in the expected form
  | "model-unavailable" // the chosen model does not exist or is not allowed for this account
  | "offline" // the tool could not reach its service
  | "busy" // the service is overloaded; trying again later helps
  | "too-large" // the request or the answer was too big
  | "invalid-request" // the app asked for something impossible; a bug, not the user's fault
  | "failed"; // anything else

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
}

/** Every provider call that crosses the bridge resolves to this instead of throwing. */
export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

/** One row of `providers.detectAll()`. */
export interface ProviderDetectionEntry {
  id: ProviderId;
  detection: ProviderDetection;
}

/**
 * What the user chose in Settings. Stored in the settings file; never holds a key or a secret.
 */
export interface AiSettings {
  /** The provider new results are made with. `null` until the user picks one. */
  defaultProvider: ProviderId | null;
  /** The model chosen per provider. A provider without an entry uses its own default model. */
  models: Partial<Record<ProviderId, string>>;
}

/** What the Settings "Test" button gets back. */
export interface ProviderTestReply {
  /** One line from the model, at most 300 characters. Plain text: render it as text. */
  reply: string;
  /** The model that was asked for, or `null` when the provider's own default was used. */
  model: string | null;
  /** How long the request took. */
  durationMs: number;
}

export interface ProviderTestOptions {
  /** Made by the renderer (`newRequestId()`); `tasks.cancel(requestId)` stops the test. */
  requestId: string;
  /** Test this model instead of the saved one, e.g. the one selected but not saved yet. */
  model?: string;
  /**
   * The API-key provider only: test this vendor's key, with the vendor's recommended model
   * (unless `model` is given). For the Test button next to each saved key.
   */
  vendor?: ApiKeyVendor;
}

/** The longest model name the app accepts. */
export const MAX_MODEL_LENGTH = 100;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;

/**
 * Whether `value` can be a model name: letters, digits and `. _ : @ / [ ] -`, starting with a
 * letter or digit. Covers aliases (`sonnet`), full ids and Ollama tags (`llama3.2:3b`). It is
 * passed to command-line tools, so nothing else is let through.
 */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_MODEL_LENGTH && MODEL_PATTERN.test(value);
}

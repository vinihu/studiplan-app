/**
 * How an AI is named and described on screen. Pure functions, no DOM.
 */

import { PROVIDER_LABELS, VENDOR_LABELS, isProviderId } from "@shared/providers";
import type { AiSettings, ApiKeyVendor, ProviderId } from "@shared/providers";

/**
 * The vendor a model name belongs to, or `null` when the name does not say. The same rule the
 * main process uses to pick the key for a model.
 */
export function vendorOfModel(model: string): ApiKeyVendor | null {
  const name = model.toLowerCase();
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gemini") || name.startsWith("gemma") || name.startsWith("models/")) return "google";
  if (/^(gpt|chatgpt|o\d|codex)/.test(name)) return "openai";
  return null;
}

/**
 * Who makes a result, by name: "Claude Code", "Codex", and for an API key the vendor of the
 * model when the model says it ("OpenAI"). An id this version does not know is shown as it is.
 */
export function makerName(provider: string | null, model: string | null, label?: string | null): string | null {
  if (provider === null) return null;
  if (provider === "api-key") {
    const vendor = model ? vendorOfModel(model) : null;
    return vendor ? VENDOR_LABELS[vendor] : "your API key";
  }
  return label ?? (isProviderId(provider) ? PROVIDER_LABELS[provider] : provider);
}

/** "Claude Code (sonnet)", "OpenAI (gpt-6.1-sol)", "Codex", or `null` when nothing is known. */
export function describeMakerWithModel(
  provider: string | null,
  model: string | null,
  label?: string | null,
): string | null {
  const name = makerName(provider, model, label);
  if (name && model) return `${name} (${model})`;
  return name ?? model;
}

/** The AI chosen in Settings, as the Make section names it. `null` when none is chosen. */
export function describeChosenAi(settings: AiSettings | null, labels: Partial<Record<ProviderId, string>> = {}): string | null {
  const id = settings?.defaultProvider ?? null;
  if (id === null) return null;
  return describeMakerWithModel(id, settings?.models[id] ?? null, labels[id] ?? null);
}

/**
 * What each AI needs before it can be used, in one line. Nothing here says that anything is
 * free: what a subscription or a key costs is between the student and the provider.
 */
export const REQUIREMENTS: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Needs Claude Code installed and signed in. It uses your own Claude subscription.",
  codex: "Needs Codex installed and signed in. It uses your own ChatGPT subscription.",
  ollama: "Needs Ollama installed and running, with a model pulled. It runs on this computer and nothing leaves it.",
  "api-key": "Needs your own key from Anthropic, OpenAI or Google. What you use is billed by them to your own account.",
};

/** What each AI can read of a material, because it changes what a student gets. */
export const READS: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Reads text, photos, and scanned PDFs of up to 20 pages.",
  codex: "Reads text and photos, but not scanned PDFs.",
  ollama: "Reads text. Photos only with a model that reads photos; scanned PDFs not at all.",
  "api-key": "Reads text, photos, and scanned PDFs of up to 20 pages.",
};

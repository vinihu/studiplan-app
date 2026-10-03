/**
 * The providers the app knows, by id. The IPC handlers and the generation code go through this.
 */
import { createApiKeyProvider, type ApiKeyProviderOptions } from "./api-key";
import type { ApiKeyStore } from "./api-key-store";
import { createClaudeCodeProvider, type ClaudeCodeOptions } from "./claude-code";
import { createCodexProvider, type CodexOptions } from "./codex";
import { createOllamaProvider, type OllamaOptions } from "./ollama";
import { failure } from "./errors";
import type { Provider } from "./provider";
import type { ProviderDetection, ProviderId, ProviderInfo } from "@shared/providers";

export interface ProviderRegistry {
  /** In the order they should be shown. */
  list(): Provider[];
  /** What Settings needs to draw each provider. */
  info(): ProviderInfo[];
  get(id: ProviderId): Provider | undefined;
  /** Like `get`, but throws a `ProviderFailure` with a sentence when the provider is not there. */
  require(id: ProviderId): Provider;
  /** Runs every provider's `detect()` side by side. Never throws. */
  detectAll(): Promise<Array<{ id: ProviderId; detection: ProviderDetection }>>;
}

export function createProviderRegistry(providers: readonly Provider[]): ProviderRegistry {
  const byId = new Map<ProviderId, Provider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`Provider registered twice: ${provider.id}`);
    byId.set(provider.id, provider);
  }

  return {
    list: () => [...byId.values()],
    info: () =>
      [...byId.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        suggestedModels: provider.suggestedModels,
      })),
    get: (id) => byId.get(id),
    require(id) {
      const provider = byId.get(id);
      if (provider === undefined) {
        throw failure("failed", "", "This AI is not available in this version of Studiplan. Choose another one in Settings.");
      }
      return provider;
    },
    async detectAll() {
      return Promise.all(
        [...byId.values()].map(async (provider) => {
          try {
            return { id: provider.id, detection: await provider.detect() };
          } catch {
            const detection: ProviderDetection = {
              available: false,
              status: "error",
              detail: `${provider.label} could not be checked. Try again.`,
            };
            return { id: provider.id, detection };
          }
        }),
      );
    },
  };
}

export interface DefaultProviderOptions {
  claudeCode?: ClaudeCodeOptions;
  codex?: CodexOptions;
  ollama?: OllamaOptions;
  /**
   * Where API keys are kept. It needs Electron's `safeStorage`, so the caller makes it (after
   * the app is ready). Left out, there is no API-key provider.
   */
  apiKeyStore?: ApiKeyStore;
  apiKey?: Omit<ApiKeyProviderOptions, "store">;
}

/** The registry with every provider, in the order they are shown. */
export function createDefaultProviderRegistry(options: DefaultProviderOptions = {}): ProviderRegistry {
  return createProviderRegistry([
    createClaudeCodeProvider(options.claudeCode),
    createCodexProvider(options.codex),
    createOllamaProvider(options.ollama),
    ...(options.apiKeyStore === undefined ? [] : [createApiKeyProvider({ ...options.apiKey, store: options.apiKeyStore })]),
  ]);
}

const TEST_INSTRUCTIONS =
  "This is a connection test from a study app. Reply with one short, friendly sentence that says you are ready to help with studying. No questions, no lists, no Markdown.";

/**
 * The Settings "Test" button: a real one-line reply from the provider. Costs one tiny request.
 * Rejects with a `ProviderFailure`.
 */
export async function testProvider(
  provider: Provider,
  options: { signal: AbortSignal; model?: string },
): Promise<string> {
  const reply = await provider.generate({
    instructions: TEST_INSTRUCTIONS,
    parts: [],
    signal: options.signal,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const firstLine = reply.split(/\r?\n/).find((line) => line.trim().length > 0) ?? reply;
  return firstLine.trim().slice(0, 300);
}

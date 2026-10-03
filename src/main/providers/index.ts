/**
 * The AI provider layer. Everything the rest of the main process needs is exported from here.
 */
export * from "@shared/providers";
export type { GenerateRequest, Part, Provider, TextBudgetInput } from "./provider";
export { consoleLog, failure, ProviderFailure, sentenceFor, toProviderResult, type ProviderLog } from "./errors";
export { assemblePrompt, type AssembledPrompt, type AssembleInput } from "./prompt";
export {
  createDefaultProviderRegistry,
  createProviderRegistry,
  testProvider,
  type DefaultProviderOptions,
  type ProviderRegistry,
} from "./registry";
export { CLAUDE_CODE_MODELS, createClaudeCodeProvider, type ClaudeCodeOptions } from "./claude-code";
export { CODEX_MODELS, createCodexProvider, type CodexOptions } from "./codex";
export { createOllamaProvider, type OllamaOptions } from "./ollama";
export { API_KEY_MODELS, createApiKeyProvider, type ApiKeyProviderOptions } from "./api-key";
export { createApiKeyStore, type ApiKeyStore, type SafeStorageLike } from "./api-key-store";
export { createFakeProvider, fakeAiMode, FAKE_AI_ENV, type FakeAiMode } from "./fake";

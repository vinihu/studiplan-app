import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_IDS, PROVIDER_LABELS } from "@shared/providers";
import type { ProviderResult } from "@shared/providers";
import { createSettingsStore } from "../settings";
import { createTaskRegistry } from "../tasks";
import { API_KEY_MODELS, REQUEST_TEXT_RESERVE_BYTES } from "./api-key";
import { createApiKeyStore } from "./api-key-store";
import type { ApiKeyStore, SafeStorageLike } from "./api-key-store";
import type { GenerateRequest, Provider } from "./provider";
import { createDefaultProviderRegistry, createProviderRegistry } from "./registry";
import { createProviderService } from "./service";
import type { ProviderService } from "./service";
import { FAKE_GOOGLE_KEY as GOOGLE_KEY, FAKE_OPENAI_KEY as OPENAI_KEY } from "./test-keys";

/** Reversible and nothing like the plaintext. */
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, "utf8").map((byte) => byte ^ 0xa5)),
  decryptString: (data) => Buffer.from(data.map((byte) => byte ^ 0xa5)).toString("utf8"),
};

let directory: string;
let store: ApiKeyStore;
let logged: string[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "studiplan-registry-"));
  store = createApiKeyStore({ directory, safeStorage });
  logged = [];
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function value<T>(result: ProviderResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function serviceWith(providers: readonly Provider[], apiKeys: ApiKeyStore | undefined = store): ProviderService {
  return createProviderService({
    registry: createProviderRegistry(providers),
    settings: createSettingsStore(directory),
    tasks: createTaskRegistry(),
    ...(apiKeys === undefined ? {} : { apiKeys }),
    log: (message, detail) => logged.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
}

describe("the default registry", () => {
  it("has the four providers in the order they are shown, under their shared names", () => {
    const registry = createDefaultProviderRegistry({ apiKeyStore: store });
    expect(registry.list().map((provider) => provider.id)).toEqual(["claude-code", "codex", "ollama", "api-key"]);
    expect(registry.list().map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
    for (const provider of registry.list()) expect(provider.label).toBe(PROVIDER_LABELS[provider.id]);
  });

  it("says what each provider can take, which is what the generation code goes by", () => {
    const registry = createDefaultProviderRegistry({ apiKeyStore: store });
    const facts = registry.list().map((provider) => [
      provider.id,
      provider.readsScannedPdfs === true,
      provider.readsPdfPageRanges === true,
      provider.maxTextChars !== undefined,
      provider.maxAttachmentBytes !== undefined,
      provider.listModels !== undefined,
    ]);
    expect(facts).toEqual([
      //            scans  ranges text   bytes  models
      ["claude-code", true, false, false, false, false],
      ["codex", false, false, false, false, false],
      ["ollama", false, false, true, false, true],
      ["api-key", true, false, false, true, true],
    ]);
  });

  it("has no API-key provider without a place to keep keys", () => {
    expect(createDefaultProviderRegistry().list().map((provider) => provider.id)).toEqual(["claude-code", "codex", "ollama"]);
  });
});

describe("the API-key provider's limits", () => {
  it("leaves room in a request for the vendor's size limit and the encoding", async () => {
    const provider = createDefaultProviderRegistry({ apiKeyStore: store }).require("api-key");
    const megabyte = 1024 * 1024;
    const files = (limit: number): number => Math.floor(((limit - REQUEST_TEXT_RESERVE_BYTES) * 3) / 4);
    expect(await provider.maxAttachmentBytes?.("gemini-3.8-flash")).toBe(files(20 * megabyte));
    expect(await provider.maxAttachmentBytes?.("claude-opus-5-5")).toBe(files(32 * megabyte));
    expect(await provider.maxAttachmentBytes?.("gpt-6.1-sol")).toBe(files(50 * megabyte));
    // Google's 20 MB: under the app's own 20 MB of photos, so the photos are cut to it.
    expect(files(20 * megabyte)).toBeLessThan(15 * megabyte);
    // No model and no key: nothing to go by.
    expect(await provider.maxAttachmentBytes?.()).toBeUndefined();
    await store.set("google", GOOGLE_KEY);
    expect(await provider.maxAttachmentBytes?.()).toBe(files(20 * megabyte));
  });
});

describe("the model picker", () => {
  const plain: Provider = {
    id: "codex",
    label: "Codex",
    suggestedModels: [{ id: "gpt-a", label: "A" }],
    detect: async () => ({ available: true, status: "ready", detail: "Ready." }),
    generate: async () => "x",
  };

  it("offers a provider's suggestions when it cannot list models itself", async () => {
    const service = serviceWith([plain]);
    expect(await service.listModels("codex")).toEqual([{ id: "gpt-a", label: "A" }]);
  });

  it("offers what the provider lists right now, and nothing when that fails", async () => {
    let fail = false;
    const service = serviceWith([
      {
        ...plain,
        id: "ollama",
        listModels: async () => {
          if (fail) throw new Error("down");
          return [{ id: "gemma4:latest", label: "gemma4:latest (reads photos)" }];
        },
      },
    ]);
    expect(await service.listModels("ollama")).toEqual([{ id: "gemma4:latest", label: "gemma4:latest (reads photos)" }]);
    fail = true;
    expect(await service.listModels("ollama")).toEqual([]);
  });

  it("is empty for what is not a provider of this version", async () => {
    const service = serviceWith([plain]);
    expect(await service.listModels("ollama")).toEqual([]);
    expect(await service.listModels("nonsense")).toEqual([]);
    expect(await service.listModels(undefined)).toEqual([]);
  });

  it("offers the models of the vendors that have a key", async () => {
    const service = serviceWith(createDefaultProviderRegistry({ apiKeyStore: store }).list());
    const all = [...API_KEY_MODELS.anthropic, ...API_KEY_MODELS.openai, ...API_KEY_MODELS.google];
    expect(await service.listModels("api-key")).toEqual(all);
    value(await service.saveApiKey("google", GOOGLE_KEY));
    expect(await service.listModels("api-key")).toEqual([...API_KEY_MODELS.google]);
    value(await service.saveApiKey("openai", OPENAI_KEY));
    expect(await service.listModels("api-key")).toEqual([...API_KEY_MODELS.openai, ...API_KEY_MODELS.google]);
  });
});

describe("API keys over the bridge", () => {
  it("saves, reports and removes a key without ever handing it back or logging it", async () => {
    const service = serviceWith([]);
    expect(await service.apiKeyStatus()).toEqual({ saved: [] });

    const saved = await service.saveApiKey("openai", `  ${OPENAI_KEY}\n`);
    expect(saved).toEqual({ ok: true, value: { saved: ["openai"] } });
    expect(await service.apiKeyStatus()).toEqual({ saved: ["openai"] });
    expect(await store.get("openai")).toBe(OPENAI_KEY);

    const files = await readdir(directory);
    expect(files).toEqual(["api-key-openai.bin"]);
    expect((await readFile(path.join(directory, "api-key-openai.bin"))).includes(Buffer.from(OPENAI_KEY))).toBe(false);

    expect(await service.clearApiKey("openai")).toEqual({ ok: true, value: { saved: [] } });
    expect(await readdir(directory)).toEqual([]);
    // Clearing what is not there is fine.
    expect(await service.clearApiKey("openai")).toEqual({ ok: true, value: { saved: [] } });

    expect(JSON.stringify([saved, logged])).not.toContain(OPENAI_KEY);
  });

  it("refuses what is not a vendor or not a key, with a sentence and without the key in it", async () => {
    const service = serviceWith([]);
    for (const [vendor, key] of [
      ["nonsense", OPENAI_KEY],
      ["../openai", OPENAI_KEY],
      [null, OPENAI_KEY],
      ["openai", "short"],
      ["openai", 12345],
      ["openai", { key: OPENAI_KEY }],
      ["openai", `${OPENAI_KEY} with spaces`],
      ["google", OPENAI_KEY],
    ] as const) {
      const result = await service.saveApiKey(vendor, key);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.length).toBeGreaterThan(10);
        expect(result.error.message).not.toContain(OPENAI_KEY);
      }
    }
    expect(await service.clearApiKey("nonsense")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(await readdir(directory)).toEqual([]);
    expect(logged.join("\n")).not.toContain(OPENAI_KEY);
  });

  it("says so when this build has nowhere to keep a key", async () => {
    const service = createProviderService({
      registry: createProviderRegistry([]),
      settings: createSettingsStore(directory),
      tasks: createTaskRegistry(),
    });
    expect(await service.apiKeyStatus()).toEqual({ saved: [] });
    expect(await service.saveApiKey("openai", OPENAI_KEY)).toMatchObject({ ok: false, error: { code: "failed" } });
  });
});

describe("the Test button for one vendor's key", () => {
  it("tests that vendor with its recommended model, whatever model is saved", async () => {
    const requests: GenerateRequest[] = [];
    const service = serviceWith([
      {
        id: "api-key",
        label: "API key",
        suggestedModels: [],
        detect: async () => ({ available: true, status: "ready", detail: "Ready." }),
        generate: async (request) => {
          requests.push(request);
          return "Ready.";
        },
      },
    ]);
    value(await service.setModel("api-key", "claude-opus-5-5"));

    expect(value(await service.test("api-key", { requestId: "request-0001", vendor: "google" })).model).toBe(API_KEY_MODELS.google[0]?.id);
    expect(value(await service.test("api-key", { requestId: "request-0002", vendor: "google", model: "gemini-x" })).model).toBe("gemini-x");
    expect(value(await service.test("api-key", { requestId: "request-0003" })).model).toBe("claude-opus-5-5");
    expect(requests.map((request) => request.model)).toEqual([API_KEY_MODELS.google[0]?.id, "gemini-x", "claude-opus-5-5"]);

    expect(await service.test("api-key", { requestId: "request-0004", vendor: "nonsense" })).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(requests).toHaveLength(3);
  });
});

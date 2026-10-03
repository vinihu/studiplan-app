import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiKeyFile,
  checkApiKey,
  createApiKeyStore,
  guessVendor,
  isApiKeyVendor,
  redactSecrets,
  type ApiKeyVendor,
  type SafeStorageLike,
} from "./api-key-store";
import { ProviderFailure } from "./errors";
import {
  FAKE_ANTHROPIC_KEY as ANTHROPIC_KEY,
  FAKE_GOOGLE_KEY as GOOGLE_KEY,
  FAKE_OPENAI_KEY as OPENAI_KEY,
  openAiShaped,
} from "./test-keys";

/** Reversible and nothing like the plaintext: every byte flipped, behind a marker. */
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  const flip = (data: Buffer): Buffer => Buffer.from(data.map((byte) => byte ^ 0xa5));
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.concat([Buffer.from("v10"), flip(Buffer.from(text, "utf8"))]),
    decryptString: (data) => {
      if (data.subarray(0, 3).toString() !== "v10") throw new Error("not ours");
      return flip(data.subarray(3)).toString("utf8");
    },
    ...overrides,
  };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderFailure);
  return (error as ProviderFailure).message;
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "studiplan-keys-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the key store", () => {
  it("round-trips a key through encryption and never writes it as it is", async () => {
    const store = createApiKeyStore({ directory, safeStorage: fakeSafeStorage() });
    expect(await store.has("anthropic")).toBe(false);
    expect(await store.get("anthropic")).toBeUndefined();

    await store.set("anthropic", `  ${ANTHROPIC_KEY}\n`);
    expect(await store.has("anthropic")).toBe(true);
    expect(await store.get("anthropic")).toBe(ANTHROPIC_KEY);
    expect(await store.saved()).toEqual(["anthropic"]);

    // Nothing in the folder holds the key or a recognisable part of it.
    const names = await readdir(directory);
    expect(names).toEqual(["api-key-anthropic.bin"]);
    for (const name of names) {
      const onDisk = await readFile(path.join(directory, name));
      expect(onDisk.includes(Buffer.from(ANTHROPIC_KEY))).toBe(false);
      expect(onDisk.includes(Buffer.from("sk-ant"))).toBe(false);
      expect(onDisk.toString("latin1")).not.toContain("TESTKEY");
      expect(name).not.toContain("sk-");
    }
  });

  it("keeps one key per vendor and clears them separately", async () => {
    const store = createApiKeyStore({ directory, safeStorage: fakeSafeStorage() });
    await store.set("google", GOOGLE_KEY);
    await store.set("openai", OPENAI_KEY);
    expect(await store.saved()).toEqual(["openai", "google"]);

    await store.clear("openai");
    await store.clear("openai"); // clearing nothing is fine
    expect(await store.has("openai")).toBe(false);
    expect(await store.get("google")).toBe(GOOGLE_KEY);

    await store.set("google", `${GOOGLE_KEY}x`);
    expect(await store.get("google")).toBe(`${GOOGLE_KEY}x`);
  });

  it("refuses to store when encryption is not available, and says so", async () => {
    for (const safeStorage of [
      fakeSafeStorage({ isEncryptionAvailable: () => false }),
      fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
      fakeSafeStorage({
        encryptString: () => {
          throw new Error("no keychain");
        },
      }),
      // A backend that hands the text back unchanged is not encryption.
      fakeSafeStorage({ encryptString: (text) => Buffer.from(`plain:${text}`) }),
    ]) {
      const store = createApiKeyStore({ directory, safeStorage });
      const message = await messageOf(store.set("openai", OPENAI_KEY));
      expect(message).toMatch(/cannot store the key safely/);
      expect(message).not.toContain(OPENAI_KEY);
      expect(await readdir(directory)).toEqual([]);
      expect(await store.has("openai")).toBe(false);
    }
  });

  it("treats a file it cannot decrypt as no key", async () => {
    const store = createApiKeyStore({ directory, safeStorage: fakeSafeStorage() });
    await writeFile(apiKeyFile(directory, "openai"), Buffer.from("garbage from another computer"));
    expect(await store.has("openai")).toBe(true);
    expect(await store.get("openai")).toBeUndefined();

    await writeFile(apiKeyFile(directory, "google"), Buffer.alloc(0));
    expect(await store.has("google")).toBe(false);
  });

  it("rejects a vendor that is not one of the three, so it never becomes a file name", async () => {
    const store = createApiKeyStore({ directory, safeStorage: fakeSafeStorage() });
    const evil = "..\\..\\evil" as ApiKeyVendor;
    await expect(store.set(evil, OPENAI_KEY)).rejects.toBeInstanceOf(ProviderFailure);
    await expect(store.clear(evil)).rejects.toBeInstanceOf(ProviderFailure);
    expect(await store.has(evil)).toBe(false);
    expect(await store.get(evil)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    expect(isApiKeyVendor("anthropic")).toBe(true);
    expect(isApiKeyVendor("mistral")).toBe(false);
    expect(isApiKeyVendor(undefined)).toBe(false);
  });
});

describe("checkApiKey", () => {
  it("accepts a real-looking key for each vendor, trimmed", () => {
    expect(checkApiKey("anthropic", ` ${ANTHROPIC_KEY} `)).toBe(ANTHROPIC_KEY);
    expect(checkApiKey("openai", OPENAI_KEY)).toBe(OPENAI_KEY);
    expect(checkApiKey("google", GOOGLE_KEY)).toBe(GOOGLE_KEY);
    // A Google key in a newer format without the classic prefix.
    expect(checkApiKey("google", "gk_live_0123456789abcdefghij")).toBe("gk_live_0123456789abcdefghij");
  });

  it.each([
    ["too short", "sk-short"],
    ["empty", "   "],
    ["a space inside", openAiShaped(`${"A".repeat(12)} ${"B".repeat(16)}`)],
    ["a line break inside", openAiShaped(`${"A".repeat(12)}\n${"B".repeat(16)}`)],
    ["a header injection", `${openAiShaped("A".repeat(24))}\r\nx-evil: 1`],
    ["not ASCII", openAiShaped("Ä".repeat(28))],
    ["far too long", `sk-${"a".repeat(600)}`],
    ["not a string", { key: openAiShaped("A".repeat(24)) }],
    ["nothing", undefined],
  ])("refuses %s without echoing it", (_name, input) => {
    let message = "";
    try {
      checkApiKey("openai", input);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      message = (error as ProviderFailure).message;
    }
    expect(message).toMatch(/does not look like an API key/);
    if (typeof input === "string" && input.trim().length > 0) expect(message).not.toContain(input.trim());
  });

  it("says so when the key belongs to another vendor", () => {
    expect(() => checkApiKey("openai", ANTHROPIC_KEY)).toThrow(/key from Anthropic, not from OpenAI/);
    expect(() => checkApiKey("anthropic", OPENAI_KEY)).toThrow(/key from OpenAI/);
    expect(() => checkApiKey("anthropic", GOOGLE_KEY)).toThrow(/key from Google/);
  });

  it("recognises a vendor only where the shape is reliable", () => {
    expect(guessVendor(ANTHROPIC_KEY)).toBe("anthropic");
    expect(guessVendor(OPENAI_KEY)).toBe("openai");
    expect(guessVendor(GOOGLE_KEY)).toBe("google");
    expect(guessVendor("gk_live_0123456789abcdefghij")).toBeUndefined();
  });
});

describe("redactSecrets", () => {
  it("removes the given key and anything shaped like one", () => {
    const text = `Incorrect API key provided: ${OPENAI_KEY}. Also ${ANTHROPIC_KEY} and ${GOOGLE_KEY} and custom-secret-value.`;
    const redacted = redactSecrets(text, ["custom-secret-value", undefined]);
    expect(redacted).not.toContain(OPENAI_KEY);
    expect(redacted).not.toContain(ANTHROPIC_KEY);
    expect(redacted).not.toContain(GOOGLE_KEY);
    expect(redacted).not.toContain("custom-secret-value");
    expect(redacted).not.toContain("TESTKEY");
    expect(redacted).toContain("Incorrect API key provided: [key].");
  });

  it("removes a key the vendor echoed back masked, with its last characters", () => {
    // What the real OpenAI API answered to an invalid key on 2026-10-02.
    const text = "401 invalid_api_key Incorrect API key provided: sk-proj-*****************************************0000. You can find your API key at …";
    expect(redactSecrets(text)).toBe("401 invalid_api_key Incorrect API key provided: [key]. You can find your API key at …");
    expect(redactSecrets("AIza***********abcd is not valid")).toBe("[key] is not valid");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("The model gpt-6.1-sol does not exist (sk- is a prefix).")).toBe(
      "The model gpt-6.1-sol does not exist (sk- is a prefix).",
    );
  });
});

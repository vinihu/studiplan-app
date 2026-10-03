/**
 * Where API keys are kept: encrypted with the operating system's own protection (Electron
 * `safeStorage`: DPAPI on Windows, Keychain on macOS, the desktop keyring on Linux) and written
 * as ciphertext to one small file per vendor in the app's profile folder. A key is never written
 * to disk as it is, never logged, and never handed back across the bridge: the only thing the
 * window can learn is whether a key is saved.
 *
 * No Electron import: the `safeStorage` object is passed in, so this runs in tests.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProviderFailure } from "./errors";

import { API_KEY_VENDORS, isApiKeyVendor, VENDOR_LABELS } from "@shared/providers";
import type { ApiKeyVendor } from "@shared/providers";

// The vendors and their names are shared with the window (`src/shared/providers.ts`).
export { API_KEY_VENDORS, isApiKeyVendor, VENDOR_LABELS };
export type { ApiKeyVendor };

/** The part of Electron's `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only. `"basic_text"` means there is no keyring and the "encryption" is a fixed password. */
  getSelectedStorageBackend?(): string;
}

export const MIN_KEY_LENGTH = 20;
export const MAX_KEY_LENGTH = 512;

const NO_ENCRYPTION =
  "This computer cannot store the key safely (no system keychain is available), so it was not saved. Use Claude Code, Codex or Ollama instead, or set up a keychain and try again.";
const NOT_A_KEY =
  "That does not look like an API key. Copy the whole key from the provider's website and paste it without spaces or line breaks.";
const NOT_SAVED = "The key could not be saved. Check that the disk is not full and try again.";

function refuse(message: string): ProviderFailure {
  return new ProviderFailure("invalid-request", message);
}

/**
 * The vendor a key belongs to, when its shape says so reliably. Anthropic keys start with
 * `sk-ant-` and classic Google AI Studio keys with `AIza`; OpenAI keys start with `sk-` (and
 * nothing else that starts with `sk-` is theirs once `sk-ant-` is ruled out). Google's newer
 * keys have no documented prefix, so anything else is `undefined` and the user's choice stands.
 */
export function guessVendor(key: string): ApiKeyVendor | undefined {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "google";
  return undefined;
}

/**
 * The key ready to store, or a `ProviderFailure` with a sentence. Checks shape and length only:
 * whether the vendor accepts it is found out by the Test button.
 */
export function checkApiKey(vendor: ApiKeyVendor, input: unknown): string {
  if (typeof input !== "string") throw refuse(NOT_A_KEY);
  const key = input.trim();
  // Printable ASCII without spaces: every vendor's keys are, and it keeps the key a valid
  // HTTP header value.
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw refuse(NOT_A_KEY);
  }
  const guessed = guessVendor(key);
  if (guessed !== undefined && guessed !== vendor) {
    throw refuse(
      `This looks like a key from ${VENDOR_LABELS[guessed]}, not from ${VENDOR_LABELS[vendor]}. Choose ${VENDOR_LABELS[guessed]} and paste it again.`,
    );
  }
  return key;
}

// `*` too: a vendor's own error message echoes the key masked but with its last characters
// (`sk-proj-********0000`), and those are not for the log either.
const KNOWN_KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_*-]{8,}|AIza[A-Za-z0-9_*-]{8,})/g;

/**
 * `text` with every secret in `secrets`, and anything shaped like a vendor key, replaced.
 * Every piece of vendor error text goes through this before it is logged or classified.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 4) result = result.split(secret).join("[key]");
  }
  return result.replace(KNOWN_KEY_SHAPES, "[key]");
}

export interface ApiKeyStoreOptions {
  /** The app's profile folder (`app.getPath("userData")`). */
  directory: string;
  safeStorage: SafeStorageLike;
}

export interface ApiKeyStore {
  /** Validates and stores the key. Rejects with a `ProviderFailure` (a sentence) when it cannot. */
  set(vendor: ApiKeyVendor, key: unknown): Promise<void>;
  /** Whether a key is saved for the vendor. Does not decrypt. */
  has(vendor: ApiKeyVendor): Promise<boolean>;
  /** Removes the vendor's key. Fine when there is none. */
  clear(vendor: ApiKeyVendor): Promise<void>;
  /** The vendors with a saved key, in a fixed order. */
  saved(): Promise<ApiKeyVendor[]>;
  /**
   * The key itself. For the provider only: never return this from an IPC handler.
   * `undefined` when there is none or it can no longer be decrypted.
   */
  get(vendor: ApiKeyVendor): Promise<string | undefined>;
}

/** The file one vendor's encrypted key is kept in. The name holds nothing secret. */
export function apiKeyFile(directory: string, vendor: ApiKeyVendor): string {
  return path.join(directory, `api-key-${vendor}.bin`);
}

export function createApiKeyStore(options: ApiKeyStoreOptions): ApiKeyStore {
  const { directory, safeStorage } = options;

  function canEncrypt(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return safeStorage.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return false;
    }
  }

  function vendorOf(value: ApiKeyVendor): ApiKeyVendor {
    // Arguments arrive over IPC as `unknown`; a vendor name becomes part of a file name.
    if (!isApiKeyVendor(value)) throw refuse("Studiplan could not prepare this request. Please report this as a bug.");
    return value;
  }

  async function set(vendorInput: ApiKeyVendor, input: unknown): Promise<void> {
    const vendor = vendorOf(vendorInput);
    const key = checkApiKey(vendor, input);
    if (!canEncrypt()) throw refuse(NO_ENCRYPTION);

    let encrypted: Buffer;
    try {
      encrypted = safeStorage.encryptString(key);
    } catch {
      throw refuse(NO_ENCRYPTION);
    }
    // Never write something that still contains the key, whatever the backend did.
    if (encrypted.length === 0 || encrypted.includes(Buffer.from(key, "utf8"))) throw refuse(NO_ENCRYPTION);

    const file = apiKeyFile(directory, vendor);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new ProviderFailure("failed", NOT_SAVED);
    }
  }

  async function read(vendor: ApiKeyVendor): Promise<Buffer | undefined> {
    try {
      const data = await readFile(apiKeyFile(directory, vendorOf(vendor)));
      // A key file is a few hundred bytes. Anything else is not one.
      return data.length > 0 && data.length <= 16 * 1024 ? data : undefined;
    } catch {
      return undefined;
    }
  }

  async function get(vendor: ApiKeyVendor): Promise<string | undefined> {
    const data = await read(vendor);
    if (data === undefined || !canEncrypt()) return undefined;
    try {
      const key = safeStorage.decryptString(data);
      return /^[\x21-\x7e]+$/.test(key) && key.length >= MIN_KEY_LENGTH && key.length <= MAX_KEY_LENGTH
        ? key
        : undefined;
    } catch {
      // Encrypted by another user account or another computer: as good as not there.
      return undefined;
    }
  }

  async function has(vendor: ApiKeyVendor): Promise<boolean> {
    return (await read(vendor)) !== undefined;
  }

  async function clear(vendor: ApiKeyVendor): Promise<void> {
    try {
      await rm(apiKeyFile(directory, vendorOf(vendor)), { force: true });
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("failed", "The key could not be removed. Close other programs using the app's folder and try again.");
    }
  }

  async function saved(): Promise<ApiKeyVendor[]> {
    const present = await Promise.all(API_KEY_VENDORS.map((vendor) => has(vendor)));
    return API_KEY_VENDORS.filter((_, index) => present[index] === true);
  }

  return { set, has, clear, saved, get };
}

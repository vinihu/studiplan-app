/**
 * Made-up API keys for the tests. Used by test files only; nothing the app runs imports this.
 *
 * Each one passes the app's own shape check (`checkApiKey`, `guessVendor`), because the tests
 * exercise exactly that. They are assembled at run time from a vendor prefix and a repeated
 * marker so that no literal shaped like a real key exists in the source, where a secret scanner
 * would report it. None of them was ever issued by anyone.
 */

/** The word every fake key is made of. Tests look for it to prove a key did not leak. */
export const FAKE_KEY_MARKER = "TESTKEY";

const body = FAKE_KEY_MARKER.repeat(5);

export const FAKE_ANTHROPIC_KEY = ["sk", "ant", body].join("-");
export const FAKE_OPENAI_KEY = ["sk", "proj", body].join("-");
export const FAKE_GOOGLE_KEY = ["AI", "za", body].join("");

/** `sk-proj-` followed by `rest`: for the malformed keys a test feeds to the shape check. */
export const openAiShaped = (rest: string): string => ["sk", "proj", rest].join("-");

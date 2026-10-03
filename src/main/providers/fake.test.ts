import { describe, expect, it } from "vitest";
import { buildGenerationRequest, buildRetryMessage, parseGenerationOutput, STUDY_SET_KINDS } from "@shared/study";
import type { StudySetKind } from "@shared/study";
import { ProviderFailure } from "./errors";
import { createFakeProvider, FAKE_AI_ENV, FAKE_CHEAT_SHEET, FAKE_EXPLANATION, FAKE_MARKDOWN, FAKE_LABEL, FAKE_TEST_REPLY, fakeAiMode } from "./fake";
import type { GenerateRequest } from "./provider";
import { createProviderRegistry, testProvider } from "./registry";

function requestFor(kind: StudySetKind, signal = new AbortController().signal, retry = false): GenerateRequest {
  const built = buildGenerationRequest(kind, { request: "A timeline" });
  if (!built.ok) throw new Error("no request");
  const { instructions, jsonSchema } = built.value;
  return {
    instructions: retry ? `${instructions}\n\n${buildRetryMessage({ kind, errors: ["x"] })}` : instructions,
    parts: [{ type: "text", text: "Material." }],
    signal,
    ...(jsonSchema === null ? {} : { jsonSchema }),
  };
}

describe("fakeAiMode", () => {
  it("is off unless the variable is set", () => {
    expect(fakeAiMode({}, true)).toBeNull();
    expect(fakeAiMode({ [FAKE_AI_ENV]: "" }, true)).toBeNull();
    expect(fakeAiMode({ [FAKE_AI_ENV]: "  " }, true)).toBeNull();
    expect(fakeAiMode({ [FAKE_AI_ENV]: "0" }, true)).toBeNull();
    expect(fakeAiMode({ [FAKE_AI_ENV]: "false" }, true)).toBeNull();
  });

  it("reads the four values", () => {
    expect(fakeAiMode({ [FAKE_AI_ENV]: "1" }, true)).toBe("fast");
    expect(fakeAiMode({ [FAKE_AI_ENV]: "slow" }, true)).toBe("slow");
    expect(fakeAiMode({ [FAKE_AI_ENV]: " Retry " }, true)).toBe("retry");
    expect(fakeAiMode({ [FAKE_AI_ENV]: "limit" }, true)).toBe("limit");
    expect(fakeAiMode({ [FAKE_AI_ENV]: "yes" }, true)).toBe("fast");
  });

  it("does nothing in a release build, whatever the variable says", () => {
    for (const value of ["1", "slow", "retry", "limit", "yes"]) {
      expect(fakeAiMode({ [FAKE_AI_ENV]: value }, false)).toBeNull();
    }
  });
});

describe("the Test AI", () => {
  it("says what it is", async () => {
    const provider = createFakeProvider("fast", { delayMs: 0 });
    expect(provider.label).toBe(FAKE_LABEL);
    expect(createProviderRegistry([provider]).info()).toEqual([
      { id: "claude-code", label: "Test AI", suggestedModels: [{ id: "test-model", label: "Test model" }] },
    ]);
    const detection = await provider.detect();
    expect(detection).toMatchObject({ available: true, status: "ready" });
    expect(detection.detail).toMatch(/Test AI .*STUDIPLAN_FAKE_AI/);
  });

  it.each(STUDY_SET_KINDS)("answers a %s request with a result the app accepts", async (kind) => {
    const provider = createFakeProvider("fast", { delayMs: 0 });
    const reply = await provider.generate(requestFor(kind));
    const parsed = parseGenerationOutput(kind, reply, { length: null, request: null });
    expect(parsed.ok).toBe(true);
    if (kind === "explain") expect(reply).toBe(FAKE_EXPLANATION);
    if (kind === "cheatsheet") expect(reply).toBe(FAKE_CHEAT_SHEET);
    if (kind === "summary" || kind === "custom") expect(reply).toBe(FAKE_MARKDOWN);
    if (parsed.ok && (kind === "quiz" || kind === "exam" || kind === "test")) {
      const types = (parsed.value as { questions: { type: string }[] }).questions.map((question) => question.type);
      expect(types).toContain("multiple_choice");
      expect(types).toContain("written");
    }
  });

  it("gives a practice test asked for as multiple choice only no written question", async () => {
    const provider = createFakeProvider("fast", { delayMs: 0 });
    const built = buildGenerationRequest("test", { written: false, testLength: "quick" });
    if (!built.ok || built.value.jsonSchema === null) throw new Error("no request");
    const reply = await provider.generate({
      instructions: built.value.instructions,
      jsonSchema: built.value.jsonSchema,
      parts: [{ type: "text", text: "Material." }],
      signal: new AbortController().signal,
    });
    const questions = (JSON.parse(reply) as { questions: { type: string }[] }).questions;
    expect(questions.length).toBeGreaterThan(1);
    expect(questions.every((question) => question.type === "multiple_choice")).toBe(true);
  });

  it("answers the Settings test with one line", async () => {
    const provider = createFakeProvider("fast", { delayMs: 0 });
    expect(await testProvider(provider, { signal: new AbortController().signal })).toBe(FAKE_TEST_REPLY);
  });

  it("retry: the first answer of a generation is invalid, the second valid", async () => {
    const provider = createFakeProvider("retry", { delayMs: 0 });
    for (const kind of STUDY_SET_KINDS) {
      const first = await provider.generate(requestFor(kind));
      expect(parseGenerationOutput(kind, first, { length: null, request: null }).ok).toBe(false);
      const second = await provider.generate(requestFor(kind, undefined, true));
      expect(parseGenerationOutput(kind, second, { length: null, request: null }).ok).toBe(true);
    }
    // The Test button is not a generation: it just works.
    expect(await testProvider(provider, { signal: new AbortController().signal })).toBe(FAKE_TEST_REPLY);
  });

  it("limit: fails with the usage-limit sentence", async () => {
    const provider = createFakeProvider("limit", { delayMs: 0 });
    const error = await provider.generate(requestFor("quiz")).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderFailure);
    expect(error).toMatchObject({ code: "usage-limit" });
    expect((error as Error).message).toMatch(/Test AI usage limit is reached/);
  });

  it("slow: takes its time, and stops at once when cancelled", async () => {
    const slow = createFakeProvider("slow", { delayMs: 60 });
    const started = Date.now();
    await slow.generate(requestFor("flashcards"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);

    const controller = new AbortController();
    const pending = createFakeProvider("slow").generate(requestFor("flashcards", controller.signal));
    const cancelledAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);

    const already = new AbortController();
    already.abort();
    await expect(createFakeProvider("slow").generate(requestFor("quiz", already.signal))).rejects.toMatchObject({ code: "cancelled" });
  });
});

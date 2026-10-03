import { describe, expect, it } from "vitest";
import { READS, REQUIREMENTS, describeChosenAi, describeMakerWithModel, makerName, vendorOfModel } from "./labels";

describe("vendorOfModel", () => {
  it("reads the vendor from the model name", () => {
    expect(vendorOfModel("claude-sonnet-5-5")).toBe("anthropic");
    expect(vendorOfModel("GPT-6.1-sol")).toBe("openai");
    expect(vendorOfModel("o4-mini")).toBe("openai");
    expect(vendorOfModel("gemini-3.8-flash")).toBe("google");
    expect(vendorOfModel("llama3.2:3b")).toBeNull();
  });
});

describe("naming who made a result", () => {
  it("names the tool, or the vendor behind an API key", () => {
    expect(makerName("claude-code", "sonnet")).toBe("Claude Code");
    expect(makerName("claude-code", null, "Test AI")).toBe("Test AI");
    expect(makerName("api-key", "gpt-6.1-sol", "API key")).toBe("OpenAI");
    expect(makerName("api-key", null)).toBe("your API key");
    expect(makerName("future-ai", null)).toBe("future-ai");
    expect(makerName(null, "sonnet")).toBeNull();
  });

  it("adds the model when there is one", () => {
    expect(describeMakerWithModel("claude-code", "sonnet")).toBe("Claude Code (sonnet)");
    expect(describeMakerWithModel("api-key", "claude-opus-5-5")).toBe("Anthropic (claude-opus-5-5)");
    expect(describeMakerWithModel("codex", null)).toBe("Codex");
    expect(describeMakerWithModel(null, null)).toBeNull();
  });

  it("describes the AI chosen in Settings", () => {
    expect(describeChosenAi(null)).toBeNull();
    expect(describeChosenAi({ defaultProvider: null, models: {} })).toBeNull();
    expect(describeChosenAi({ defaultProvider: "ollama", models: { ollama: "llama3.2:3b" } })).toBe(
      "Ollama (llama3.2:3b)",
    );
    expect(describeChosenAi({ defaultProvider: "claude-code", models: {} }, { "claude-code": "Test AI" })).toBe("Test AI");
  });
});

describe("what is said about each AI", () => {
  it("never says that anything is free", () => {
    for (const line of [...Object.values(REQUIREMENTS), ...Object.values(READS)]) {
      expect(line).not.toMatch(/\bfree\b/i);
    }
  });
});

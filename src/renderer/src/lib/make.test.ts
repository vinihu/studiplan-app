import { describe, expect, it } from "vitest";
import {
  defaultSize,
  deletionStopsMaking,
  describeContents,
  describeMaker,
  describeResult,
  describeResultDetail,
  MAKE_GROUPS,
  MAKE_KINDS,
  makeOptions,
  makingTitle,
  sizeChoices,
} from "./make";

describe("sizes", () => {
  it("offers three sizes where there is one to choose, and defaults to the middle one", () => {
    expect(sizeChoices("flashcards").map((choice) => choice.label)).toEqual(["10 cards", "20 cards", "40 cards"]);
    expect(sizeChoices("summary").map((choice) => choice.id)).toEqual(["short", "medium", "long"]);
    expect(sizeChoices("test")).toEqual([
      { id: "quick", label: "Quick · about 10 questions" },
      { id: "standard", label: "Standard · about 20" },
      { id: "full", label: "Full exam · about 30" },
    ]);
    expect(defaultSize("flashcards")).toBe("20");
    expect(defaultSize("summary")).toBe("medium");
    expect(defaultSize("test")).toBe("standard");
  });

  it("offers none for an explanation, a cheat sheet and a request: the app sets their length", () => {
    for (const kind of ["explain", "cheatsheet", "custom"] as const) {
      expect(sizeChoices(kind)).toEqual([]);
      expect(defaultSize(kind)).toBeNull();
    }
  });

  it("stands the six kinds in read, learn, test and the free request, each kind once", () => {
    expect(MAKE_GROUPS.map((group) => [group.label, group.kinds])).toEqual([
      ["Read", ["summary", "explain", "cheatsheet"]],
      ["Learn", ["flashcards"]],
      ["Test", ["test"]],
      ["Or ask", ["custom"]],
    ]);
    expect(MAKE_GROUPS.flatMap((group) => group.kinds)).toEqual([...MAKE_KINDS]);
  });
});

describe("makeOptions", () => {
  it("sends the count, the length or the request", () => {
    expect(makeOptions("flashcards", "10", "")).toEqual({ count: 10 });
    expect(makeOptions("summary", "long", "")).toEqual({ length: "long" });
    expect(makeOptions("summary", null, "")).toEqual({ length: "medium" });
    expect(makeOptions("custom", null, "  A timeline  ")).toEqual({ request: "A timeline" });
  });

  it("sends a practice test's length and whether it has written questions", () => {
    expect(makeOptions("test", "full", "", true)).toEqual({ testLength: "full", written: true });
    expect(makeOptions("test", "quick", "", false)).toEqual({ testLength: "quick", written: false });
    expect(makeOptions("test", null, "")).toEqual({ testLength: "standard", written: true });
    expect(makeOptions("test", "20", "")).toEqual({ testLength: "standard", written: true });
  });

  it("sends nothing to choose for an explanation and a cheat sheet", () => {
    expect(makeOptions("explain", null, "")).toEqual({});
    expect(makeOptions("cheatsheet", "long", "ignored")).toEqual({});
  });

  it("makes nothing from an empty or far too long request", () => {
    expect(makeOptions("custom", null, "   ")).toBeNull();
    expect(makeOptions("custom", null, "x".repeat(2001))).toBeNull();
    expect(makeOptions("custom", null, "x".repeat(2000))).not.toBeNull();
  });

  it("falls back to the default count when the size is not a number", () => {
    expect(makeOptions("flashcards", null, "")).toEqual({});
  });
});

describe("wording", () => {
  it("describes a row", () => {
    expect(describeResult({ kind: "flashcards", itemCount: 20 })).toBe("Flashcards · 20 cards");
    expect(describeResult({ kind: "quiz", itemCount: 1 })).toBe("Quiz · 1 question");
    expect(describeResult({ kind: "summary", itemCount: null })).toBe("Summary");
    expect(describeResult({ kind: "summary", itemCount: null, length: "short" })).toBe("Summary · Short");
    expect(describeResult({ kind: "summary", itemCount: null, length: null })).toBe("Summary");
    expect(describeResult({ kind: "custom", itemCount: null })).toBe("Your request");
    expect(describeResult({ kind: "explain", itemCount: null })).toBe("Explanation");
    expect(describeResult({ kind: "cheatsheet", itemCount: null })).toBe("Cheat sheet");
    expect(describeResult({ kind: "test", itemCount: 27 })).toBe("Practice test · 27 questions");
    expect(describeResult({ kind: "exam", itemCount: 20 })).toBe("Mock exam · 20 questions");
  });

  it("adds a second line for what a practice test is, and for a result made from part of the material", () => {
    expect(describeResultDetail({ kind: "test", itemCount: 27, testLength: "full", written: true })).toBe("Full exam · with written questions");
    expect(describeResultDetail({ kind: "test", itemCount: 10, testLength: "quick", written: false })).toBe("Quick · multiple choice only");
    expect(describeResultDetail({ kind: "test", itemCount: 10, testLength: null, written: true })).toBe("With written questions");
    expect(describeResultDetail({ kind: "test", itemCount: 20, testLength: "standard", written: true, coverage: "cut" })).toBe(
      "Standard · with written questions · made from part of the material",
    );
    expect(describeResultDetail({ kind: "summary", itemCount: null, coverage: "cut" })).toBe("Made from part of the material");
    expect(describeResultDetail({ kind: "summary", itemCount: null, coverage: "whole" })).toBeNull();
    // A quiz of an earlier version says nothing more than it did.
    expect(describeResultDetail({ kind: "quiz", itemCount: 5, testLength: null, written: false })).toBeNull();
  });

  it("names who made it", () => {
    expect(describeMaker({ provider: "claude-code", providerLabel: "Claude Code", model: "sonnet" })).toBe(
      "Claude Code · sonnet",
    );
    expect(describeMaker({ provider: "future-ai", providerLabel: null, model: null })).toBe("future-ai");
    expect(describeMaker({ provider: "api-key", providerLabel: "API key", model: "gemini-3.8-flash" })).toBe(
      "Google · gemini-3.8-flash",
    );
    expect(describeMaker({ provider: null, providerLabel: null, model: null })).toBe("");
  });

  it("describes what a material holds", () => {
    expect(describeContents({ fileCount: 2, setCount: 0 })).toBe("2 files");
    expect(describeContents({ fileCount: 1, setCount: 3 })).toBe("1 file · 3 results");
    expect(describeContents({ fileCount: 0, setCount: 0 })).toBe("No files");
  });

  it("says that a delete stops what is being made", () => {
    expect(deletionStopsMaking("summary")).toBe(
      "A summary is being made from it right now. Deleting stops that, and nothing is saved from it.",
    );
    expect(deletionStopsMaking("flashcards", "Waves")).toBe(
      "Flashcards are being made in “Waves” right now. Deleting stops that, and nothing is saved from it.",
    );
  });

  it("titles the progress", () => {
    expect(makingTitle("summary")).toBe("Making a summary");
    expect(makingTitle("flashcards")).toBe("Making flashcards");
    expect(makingTitle("explain")).toBe("Making an explanation");
    expect(makingTitle("cheatsheet")).toBe("Making a cheat sheet");
    expect(makingTitle("test")).toBe("Making a practice test");
  });
});

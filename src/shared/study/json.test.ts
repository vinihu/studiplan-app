import { describe, expect, it } from "vitest";
import { growthOf } from "../test-scaling";
import { extractJson } from "./json";

function valueOf(reply: string): unknown {
  const result = extractJson(reply);
  if (!result.ok) throw new Error(`expected JSON, got: ${result.error}`);
  return result.value;
}

function errorOf(reply: string): string {
  const result = extractJson(reply);
  if (result.ok) throw new Error("expected no JSON");
  return result.error;
}

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(valueOf('{"cards":[{"front":"a","back":"b"}]}')).toEqual({ cards: [{ front: "a", back: "b" }] });
    expect(valueOf('  \n[1, 2]\n')).toEqual([1, 2]);
  });

  it("ignores a byte-order mark", () => {
    expect(valueOf('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON in a json fence", () => {
    expect(valueOf('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(valueOf('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(valueOf('```JSON\r\n{"a": 1}\r\n```')).toEqual({ a: 1 });
  });

  it("parses fenced JSON with prose around it", () => {
    const reply = 'Here are your cards:\n\n```json\n{"a": 1}\n```\n\nLet me know if you want more!';
    expect(valueOf(reply)).toEqual({ a: 1 });
  });

  it("parses bare JSON with prose around it", () => {
    expect(valueOf('Sure! {"a": {"b": [1, 2]}} Hope that helps.')).toEqual({ a: { b: [1, 2] } });
  });

  it("is not confused by braces and quotes inside strings", () => {
    const reply = 'Result: {"front": "What does } mean in \\"JSON\\"?", "back": "It closes { an object ]"} done';
    expect(valueOf(reply)).toEqual({ front: 'What does } mean in "JSON"?', back: "It closes { an object ]" });
  });

  it("skips prose that only looks like JSON", () => {
    expect(valueOf('The set {a, b} is small. The answer: {"a": 1}')).toEqual({ a: 1 });
  });

  it("prefers an object to an array that comes before it in the prose", () => {
    expect(valueOf('As in [1], the cards are: {"cards": []}')).toEqual({ cards: [] });
    expect(valueOf('The cards: [{"front": "a", "back": "b"}] as asked.')).toEqual([{ front: "a", back: "b" }]);
  });

  it("takes the first fence that parses", () => {
    expect(valueOf('```js\nlet x = {\n```\n\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it("returns script-like strings as plain strings", () => {
    expect(valueOf('{"front":"<script>alert(1)</script>"}')).toEqual({ front: "<script>alert(1)</script>" });
  });

  it.each([[""], ["   "], ["I could not read the material."], ["42"], ['"just a string"'], ["null"], ["{'a': 1}"], ["{a: 1}"]])(
    "finds no JSON in %j",
    (reply) => {
      expect(errorOf(reply)).toMatch(/JSON|empty/);
    },
  );

  it("says so when the JSON was cut off", () => {
    expect(errorOf('{"cards": [{"front": "a", "back": "b"}, {"front": "c"')).toMatch(/cut off/);
    expect(errorOf('```json\n{"cards": [{"front": "a"')).toMatch(/cut off/);
  });

  it("does not dig one entry out of a value that fails to parse as a whole", () => {
    expect(errorOf('{"cards": [{"front": "a", "back": "b"},]}')).toMatch(/not valid JSON/);
    expect(errorOf('Here: {"cards": [{"front": "a", "back": "b"}, {"front": "c"')).toMatch(/cut off/);
  });

  it("refuses an enormous reply before parsing it", () => {
    expect(errorOf(`{"a":"${"x".repeat(2_000_001)}"}`)).toMatch(/characters long/);
  });

  it("stays fast on text full of unbalanced brackets", () => {
    expect(extractJson("{".repeat(200_000)).ok).toBe(false);
    expect(extractJson("{ ".repeat(50_000) + "}").ok).toBe(false);
    // Four times the text takes about four times as long, not sixteen.
    expect(growthOf((size) => extractJson("{".repeat(size)), 200_000)).toMatchObject({ linear: true });
    expect(growthOf((size) => extractJson("{ ".repeat(size) + "}"), 50_000)).toMatchObject({ linear: true });
  });
});

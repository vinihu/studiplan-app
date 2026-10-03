import { describe, expect, it } from "vitest";
import { FLASHCARDS_JSON_SCHEMA, QUESTIONS_JSON_SCHEMA, jsonSchemaFor, type JsonSchema } from "./schema";
import { validateFlashcards, validateQuestions } from "./validate";

/** The only JSON Schema keywords the schemas may use (see the note in `schema.ts`). */
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "description",
]);

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every schema object in a schema: the root, each property, each `items`. */
function nodesOf(schema: unknown, found: Node[] = []): Node[] {
  if (!isNode(schema)) throw new Error("a schema must be an object");
  found.push(schema);
  if (isNode(schema.properties)) {
    for (const child of Object.values(schema.properties)) nodesOf(child, found);
  }
  if (schema.items !== undefined) nodesOf(schema.items, found);
  return found;
}

/**
 * A structural checker for the small subset of JSON Schema these schemas use. Returns the
 * problems found; an empty list means `value` conforms.
 */
function check(schema: unknown, value: unknown, path = "$"): string[] {
  if (!isNode(schema)) return [`${path}: schema is not an object`];
  const problems: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  }
  switch (schema.type) {
    case "object": {
      if (!isNode(value)) return [...problems, `${path}: not an object`];
      const properties = isNode(schema.properties) ? schema.properties : {};
      for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
        if (!(key in value)) problems.push(`${path}.${key}: required`);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key in properties) problems.push(...check(properties[key], child, `${path}.${key}`));
        else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
      }
      return problems;
    }
    case "array": {
      if (!Array.isArray(value)) return [...problems, `${path}: not an array`];
      value.forEach((entry, i) => problems.push(...check(schema.items, entry, `${path}[${i}]`)));
      return problems;
    }
    case "string":
      return typeof value === "string" ? problems : [...problems, `${path}: not a string`];
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? problems : [...problems, `${path}: not an integer`];
    default:
      return [...problems, `${path}: unsupported type ${String(schema.type)}`];
  }
}

const goodDeck = {
  problem: "",
  cards: [
    { front: "What is a codon?", back: "Three bases that code for one amino acid." },
    { front: "<i>Mitosis</i>", back: "Division of the nucleus into two identical nuclei." },
  ],
};

const goodQuestions = {
  problem: "",
  questions: [
    {
      type: "multiple_choice",
      prompt: "Which phase lines chromosomes up at the equator?",
      options: ["Prophase", "Metaphase", "Anaphase", "Telophase"],
      answerIndex: 1,
      modelAnswer: "",
      explanation: "In metaphase the spindle holds the chromosomes at the middle of the cell.",
      points: 1,
    },
    {
      type: "written",
      prompt: "Compare mitosis and meiosis.",
      options: [],
      answerIndex: -1,
      modelAnswer: "Mitosis gives two identical diploid cells; meiosis gives four different haploid cells.",
      explanation: "",
      points: 4,
    },
  ],
};

describe("the JSON Schemas", () => {
  const schemas: [string, JsonSchema][] = [
    ["flashcards", FLASHCARDS_JSON_SCHEMA],
    ["questions", QUESTIONS_JSON_SCHEMA],
  ];

  it.each(schemas)("%s uses only the conservative keywords", (_name, schema) => {
    for (const node of nodesOf(schema)) {
      for (const keyword of Object.keys(node)) expect(ALLOWED_KEYWORDS.has(keyword), keyword).toBe(true);
      expect(typeof node.type).toBe("string");
    }
  });

  it.each(schemas)("%s has an object root, requires every property and allows no others", (_name, schema) => {
    expect(schema.type).toBe("object");
    for (const node of nodesOf(schema)) {
      if (node.type !== "object") continue;
      expect(isNode(node.properties)).toBe(true);
      expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as Node).sort());
      expect(node.additionalProperties).toBe(false);
    }
  });

  it.each(schemas)("%s survives JSON serialisation unchanged", (_name, schema) => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("the flashcards schema accepts what the validator accepts", () => {
    expect(validateFlashcards(goodDeck).ok).toBe(true);
    expect(check(FLASHCARDS_JSON_SCHEMA, goodDeck)).toEqual([]);
  });

  it("the questions schema accepts what the validator accepts", () => {
    expect(validateQuestions(goodQuestions).ok).toBe(true);
    expect(check(QUESTIONS_JSON_SCHEMA, goodQuestions)).toEqual([]);
  });

  it("the checker itself notices a value that does not conform", () => {
    expect(check(FLASHCARDS_JSON_SCHEMA, { problem: "", cards: [{ front: "a" }] })).toEqual(["$.cards[0].back: required"]);
    expect(check(FLASHCARDS_JSON_SCHEMA, { problem: "", cards: [{ front: "a", back: 1, extra: true }] })).toEqual([
      "$.cards[0].back: not a string",
      "$.cards[0].extra: not allowed",
    ]);
    const wrongType = { problem: "", questions: [{ ...goodQuestions.questions[0], type: "true_false", answerIndex: 0.5 }] };
    expect(check(QUESTIONS_JSON_SCHEMA, wrongType)).toHaveLength(2);
  });

  it("the validator is stricter than the schema where the schema cannot say it", () => {
    const outOfRange = { problem: "", questions: [{ ...goodQuestions.questions[0], answerIndex: 9 }] };
    expect(check(QUESTIONS_JSON_SCHEMA, outOfRange)).toEqual([]);
    expect(validateQuestions(outOfRange).ok).toBe(false);
    const empty = { problem: "", cards: [] };
    expect(check(FLASHCARDS_JSON_SCHEMA, empty)).toEqual([]);
    expect(validateFlashcards(empty).ok).toBe(false);
  });

  it("gives a schema to the structured kinds only", () => {
    expect(jsonSchemaFor("flashcards")).toBe(FLASHCARDS_JSON_SCHEMA);
    expect(jsonSchemaFor("quiz")).toBe(QUESTIONS_JSON_SCHEMA);
    expect(jsonSchemaFor("exam")).toBe(QUESTIONS_JSON_SCHEMA);
    expect(jsonSchemaFor("summary")).toBeNull();
    expect(jsonSchemaFor("custom")).toBeNull();
  });
});

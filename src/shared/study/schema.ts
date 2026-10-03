/**
 * The JSON Schemas handed to a model (`jsonSchema` in the provider request) for the kinds whose
 * result is structured: flashcards, quiz and mock exam. Summary and "something else" are plain
 * Markdown replies and have no schema.
 *
 * ## Deliberately conservative
 *
 * Providers accept different subsets of JSON Schema for structured output, so these use only what
 * the strictest of them take: `type`, `properties`, `required`, `items`, `enum`, `description`
 * and `additionalProperties: false`, with **every property required** and the root an object.
 * No `oneOf`/`anyOf`, no `$ref`, no recursion, no optional properties, no `minItems`/`maxItems`,
 * no `minLength`/`maxLength`, no `minimum`/`maximum`, no `pattern`, no `format`.
 *
 * The provider layer may still have to adapt a schema to one provider's dialect (drop a keyword
 * it rejects, wrap it in that API's envelope). That is the provider's business; whatever it
 * sends, the reply is checked by `validate.ts`, not by the provider.
 *
 * ## The flat question
 *
 * A question is multiple choice or written, which is a `oneOf` in a precise schema. Instead every
 * question has all the fields, and the ones that do not apply are filled with an empty value
 * (`options: []`, `answerIndex: -1`, `modelAnswer: ""`). The validator reads the fields that
 * belong to the question's `type`, ignores the others, and stores the precise union.
 *
 * ## Enforced by the validator, not by these schemas
 *
 *  - at least one card / question, and the cut at `MAX_CARDS` / `MAX_QUESTIONS`;
 *  - every string non-empty where it is needed, and within its length limit;
 *  - 2–6 options on a multiple-choice question, all different;
 *  - `answerIndex` is a whole number that points at an existing option;
 *  - `points` is a whole number from 1 to `MAX_POINTS`;
 *  - a written question has a model answer.
 */

import {
  MAX_CARDS,
  MAX_OPTIONS,
  MAX_POINTS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type StudySetKind,
} from "./types";

/** A JSON Schema as a plain object. */
export type JsonSchema = { readonly [keyword: string]: unknown };

/**
 * The model's way out when it has nothing to work from (see `cannotRule` in `instructions.ts`):
 * an empty list and one sentence here. Empty in every normal reply. It is read by
 * `readRefusal()` and is never part of a saved result.
 */
const PROBLEM_FIELD = {
  type: "string",
  description:
    "Normally an empty string. Only when the material could not be read or holds nothing to " +
    "make this from: one short sentence saying what is wrong, with the list left empty.",
};

export const FLASHCARDS_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      description: `The deck, in the order of the material. 1 to ${MAX_CARDS} cards.`,
      items: {
        type: "object",
        properties: {
          front: {
            type: "string",
            description: "A question or a term. Plain text.",
          },
          back: {
            type: "string",
            description: "The answer: short and complete. Plain text.",
          },
        },
        required: ["front", "back"],
        additionalProperties: false,
      },
    },
    problem: PROBLEM_FIELD,
  },
  required: ["cards", "problem"],
  additionalProperties: false,
};

export const QUESTIONS_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: `The questions, in order. 1 to ${MAX_QUESTIONS}.`,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["multiple_choice", "written"],
            description: "Which kind of question this is.",
          },
          prompt: {
            type: "string",
            description: "The question. Plain text.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              `multiple_choice: ${MIN_OPTIONS} to ${MAX_OPTIONS} different options, exactly one ` +
              "correct. written: an empty array.",
          },
          answerIndex: {
            type: "integer",
            description:
              "multiple_choice: the 0-based position of the correct option (0 is the first " +
              "option). written: -1.",
          },
          modelAnswer: {
            type: "string",
            description:
              "written: the full answer a teacher would accept. multiple_choice: an empty string.",
          },
          explanation: {
            type: "string",
            description:
              "multiple_choice: why the correct option is right and where the tempting wrong " +
              "ones go wrong. written: what earns the points, or an empty string.",
          },
          points: {
            type: "integer",
            description: `What the question is worth: a whole number from 1 to ${MAX_POINTS}.`,
          },
        },
        required: [
          "type",
          "prompt",
          "options",
          "answerIndex",
          "modelAnswer",
          "explanation",
          "points",
        ],
        additionalProperties: false,
      },
    },
    problem: PROBLEM_FIELD,
  },
  required: ["questions", "problem"],
  additionalProperties: false,
};

/** The schema to send for `kind`, or `null` for a kind whose reply is Markdown. */
export function jsonSchemaFor(kind: StudySetKind): JsonSchema | null {
  switch (kind) {
    case "flashcards":
      return FLASHCARDS_JSON_SCHEMA;
    case "test":
    case "quiz":
    case "exam":
      return QUESTIONS_JSON_SCHEMA;
    case "summary":
    case "explain":
    case "cheatsheet":
    case "custom":
      return null;
  }
}

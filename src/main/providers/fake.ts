/**
 * A TEST SEAM, not a provider anyone studies with.
 *
 * `npm run smoke` has to prove button → progress → saved → viewer in the real app without
 * spending anyone's AI subscription and without an AI tool being installed. When the environment
 * variable `STUDIPLAN_FAKE_AI` is set **in a build with the development hooks on**
 * (`src/main/build.ts`), the main process replaces the whole provider registry by the one
 * provider made here. In a release build the variable does nothing (`fakeAiMode` returns `null`).
 *
 * The values:
 *
 * | `STUDIPLAN_FAKE_AI` | What `generate` does                                                    |
 * |---------------------|-------------------------------------------------------------------------|
 * | `1` (or anything else that is not listed below) | answers after a fraction of a second        |
 * | `slow`              | answers after several seconds; stops at once when cancelled             |
 * | `retry`             | the first answer of every generation is invalid, the second is valid    |
 * | `limit`             | fails with the usage-limit sentence                                     |
 *
 * It calls no program and no network. The answer is canned and depends only on what the request
 * asks for: flashcards or questions (told apart by the JSON schema; a practice test asked for
 * as multiple choice only gets no written question), one line for the Settings Test button,
 * otherwise a Markdown document — an explanation, a cheat sheet, or the plain document that
 * stands for a summary and for the student's own request (told apart by the instructions). The
 * material is not read.
 *
 * It registers under the id `claude-code`, because provider ids are a closed set that the
 * settings file and saved results are validated against; its label, "Test AI", says what it is.
 */
import type { ProviderId } from "@shared/providers";
import { MULTIPLE_CHOICE_ONLY } from "@shared/study";
import { failure } from "./errors";
import type { GenerateRequest, Provider } from "./provider";

export const FAKE_AI_ENV = "STUDIPLAN_FAKE_AI";

export type FakeAiMode = "fast" | "slow" | "retry" | "limit";

/**
 * The mode the environment asks for, or `null` when the fake must not be used: the variable is
 * not set or empty, or this build has no development hooks (`hooks` is `DEV_HOOKS`).
 */
export function fakeAiMode(env: NodeJS.ProcessEnv, hooks: boolean): FakeAiMode | null {
  if (!hooks) return null;
  const value = env[FAKE_AI_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "0" || value === "false") return null;
  return value === "slow" || value === "retry" || value === "limit" ? value : "fast";
}

export const FAKE_LABEL = "Test AI";
export const FAKE_PROVIDER_ID: ProviderId = "claude-code";
export const FAKE_FAST_MS = 300;
export const FAKE_SLOW_MS = 6_000;

export const FAKE_CARDS = {
  cards: [
    { front: "What does the Test AI stand in for?", back: "A real AI, while the app is being tested." },
    { front: "Which phase of the cell cycle copies the DNA?", back: "The S phase." },
    { front: "How many daughter cells does mitosis give?", back: "Two, with identical genetic information." },
  ],
};

export const FAKE_QUESTIONS = {
  questions: [
    {
      type: "multiple_choice",
      prompt: "Which phase of the cell cycle copies the DNA?",
      options: ["G1 phase", "S phase", "G2 phase", "M phase"],
      answerIndex: 1,
      modelAnswer: "",
      explanation: "The DNA is replicated in the S (synthesis) phase. G1 and G2 are growth phases; M is the division.",
      points: 1,
    },
    {
      type: "multiple_choice",
      prompt: "What is the result of mitosis and cytokinesis?",
      options: ["Four haploid cells", "Two identical diploid cells", "One larger cell", "Two haploid cells"],
      answerIndex: 1,
      modelAnswer: "",
      explanation: "Mitosis keeps the chromosome number: two genetically identical diploid cells. Four haploid cells are the result of meiosis.",
      points: 1,
    },
    {
      type: "written",
      prompt: "Explain why a cell divides instead of growing without limit.",
      options: [],
      answerIndex: -1,
      modelAnswer:
        "As a cell grows, its volume increases faster than its surface. Everything the cell takes in and gives off has to cross the surface, so beyond a certain size the surface can no longer supply the volume.",
      explanation: "One point for volume growing faster than surface, one for the exchange across the surface.",
      points: 2,
    },
  ],
};

export const FAKE_MARKDOWN = [
  "This is a canned answer from the Test AI. It stands in for a real AI while the app is tested.",
  "",
  "## The cell cycle",
  "",
  "- **Interphase**: the cell grows (G1), copies its DNA (S) and prepares to divide (G2).",
  "- **Mitosis**: prophase, metaphase, anaphase, telophase.",
  "",
  "## The result",
  "",
  "Two genetically identical daughter cells.",
].join("\n");

export const FAKE_EXPLANATION = [
  "This is a canned explanation from the Test AI. It stands in for a real AI while the app is tested.",
  "",
  "## What a cell does before it divides",
  "",
  "Think of it like packing before a move: the cell first copies everything it will need. That is the **interphase**.",
  "",
  "## The division itself",
  "",
  "In **mitosis** the copies are pulled apart, so each new cell gets a full set.",
  "",
  "## Check your understanding",
  "",
  "1. Why does the cell copy its DNA before it divides?",
  "",
  "## Answers",
  "",
  "1. So that both daughter cells get the complete genetic information.",
].join("\n");

export const FAKE_CHEAT_SHEET = [
  "## Key terms",
  "",
  "| Term | Meaning |",
  "|---|---|",
  "| **Interphase** | growth and DNA copying before division |",
  "| **Mitosis** | division of the nucleus |",
  "",
  "## Formulas",
  "",
  "| Formula | Symbols | Use |",
  "|---|---|---|",
  "| `N = 2ⁿ` | N cells after n divisions | growth of a culture |",
  "",
  "## Rules to know",
  "",
  "- This is a canned cheat sheet from the Test AI.",
  "- Mitosis keeps the chromosome number.",
].join("\n");

export const FAKE_TEST_REPLY = "The Test AI is ready. It stands in for a real AI while the app is tested.";

/** What a real provider never returns for these requests: it fails the app's own check. */
const INVALID_JSON = JSON.stringify({ cards: [], questions: [] });
const INVALID_MARKDOWN = "   ";

function properties(schema: object | undefined): Record<string, unknown> {
  const found = (schema as { properties?: unknown } | undefined)?.properties;
  return typeof found === "object" && found !== null ? (found as Record<string, unknown>) : {};
}

/** The canned answer for one request. */
export function fakeAnswer(request: Pick<GenerateRequest, "instructions" | "jsonSchema" | "parts">): string {
  const wanted = properties(request.jsonSchema);
  if ("cards" in wanted) return JSON.stringify(FAKE_CARDS);
  if ("questions" in wanted) {
    const questions = request.instructions.includes(MULTIPLE_CHOICE_ONLY)
      ? FAKE_QUESTIONS.questions.filter((question) => question.type === "multiple_choice")
      : FAKE_QUESTIONS.questions;
    return JSON.stringify({ questions });
  }
  if (request.jsonSchema !== undefined) return "{}";
  // The Settings Test button: no material, and a one-line answer.
  if (request.parts.length === 0) return FAKE_TEST_REPLY;
  if (request.instructions.includes("Your task: explain the student's material")) return FAKE_EXPLANATION;
  if (request.instructions.includes("Your task: make a cheat sheet")) return FAKE_CHEAT_SHEET;
  return FAKE_MARKDOWN;
}

/** Waits `ms`, or rejects with the cancel sentence the moment `signal` fires. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer);
      reject(failure("cancelled", FAKE_LABEL));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

export interface FakeProviderOptions {
  /** How long an answer takes. Default: a fraction of a second, several seconds for `slow`. */
  delayMs?: number;
}

export function createFakeProvider(mode: FakeAiMode, options: FakeProviderOptions = {}): Provider {
  const delayMs = options.delayMs ?? (mode === "slow" ? FAKE_SLOW_MS : FAKE_FAST_MS);

  async function generate(request: GenerateRequest): Promise<string> {
    await wait(delayMs, request.signal);
    if (mode === "limit") throw failure("usage-limit", FAKE_LABEL);
    // The app's one retry says so in its instructions; the first request of a generation does not.
    if (mode === "retry" && request.parts.length > 0 && !request.instructions.includes("Second attempt")) {
      return request.jsonSchema === undefined ? INVALID_MARKDOWN : INVALID_JSON;
    }
    return fakeAnswer(request);
  }

  return {
    id: FAKE_PROVIDER_ID,
    label: FAKE_LABEL,
    suggestedModels: [{ id: "test-model", label: "Test model" }],
    detect: async () => ({
      available: true,
      status: "ready",
      detail: `The Test AI is standing in for a real AI (${FAKE_AI_ENV} is set). It answers with canned results.`,
      version: "0.0.0",
    }),
    generate,
  };
}

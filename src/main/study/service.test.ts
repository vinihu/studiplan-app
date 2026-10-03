import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterialRef } from "@shared/library";
import type { GenerateOutcome, StudyResult } from "@shared/results";
import { parseStudySetFile, STUDY_SET_FORMATS, MAKEABLE_KINDS } from "@shared/study";
import type { StudySetKind } from "@shared/study";
import type { TaskProgress } from "@shared/tasks";
import { makePdf, makePptx, PICTURE_ONLY_STREAM, textStream } from "../extract/fixtures";
import { createLibrary } from "../library/library";
import type { LibraryService } from "../library/library";
import { failure } from "../providers/errors";
import type { GenerateRequest, Provider } from "../providers/provider";
import { createProviderRegistry } from "../providers/registry";
import { createSettingsStore } from "../settings";
import type { SettingsStore } from "../settings";
import { createTaskRegistry } from "../tasks";
import type { TaskRegistry } from "../tasks";
import { prepareMaterial } from "./material";
import { createStudyService, elapsedWords } from "./service";
import type { StudyService, StudyServiceDeps } from "./service";

let sandbox: string;
let root: string;
let library: LibraryService;
let settings: SettingsStore;
let tasks: TaskRegistry;
let service: StudyService;
let requests: GenerateRequest[];
let progress: TaskProgress[];
let logged: Array<{ message: string; detail?: Record<string, unknown> | undefined }>;
let trashed: string[];
let clock: Date;
let answer: (request: GenerateRequest, call: number) => Promise<string>;

const ID = "request-0001";
/** A JPEG with a real frame header (2 × 2, colour), as a camera or the app's own import writes one. */
const REAL_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9]),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);

/** Words that must never reach a log line. */
const SECRET_MATERIAL = "MITOCHONDRIA-SECRET-WORD";
const SECRET_ANSWER = "ANSWER-SECRET-WORD";

const CARDS = JSON.stringify({
  cards: [
    { front: "What does the S phase do?", back: `It copies the DNA. ${SECRET_ANSWER}` },
    { front: "How many phases has mitosis?", back: "Four." },
  ],
});
const QUESTIONS = JSON.stringify({
  questions: [
    {
      type: "multiple_choice",
      prompt: "Which phase copies the DNA?",
      options: ["G1", "S", "G2", "M"],
      answerIndex: 1,
      modelAnswer: "",
      explanation: "Synthesis happens in S.",
      points: 1,
    },
    { type: "written", prompt: "Explain mitosis.", options: [], answerIndex: -1, modelAnswer: "A full answer.", explanation: "", points: 3 },
  ],
});
const MARKDOWN = "This is about cell division.\n\n## Mitosis\n\n- Four phases.";

const VALID: Record<StudySetKind, string> = {
  summary: MARKDOWN,
  explain: MARKDOWN,
  cheatsheet: MARKDOWN,
  test: QUESTIONS,
  flashcards: CARDS,
  quiz: QUESTIONS,
  exam: QUESTIONS,
  custom: MARKDOWN,
};

/** A provider that waits until it is aborted, the way a real child process is killed. */
function untilAborted(request: GenerateRequest): Promise<string> {
  return new Promise((_, reject) => {
    const stop = (): void => reject(failure("cancelled", "Claude Code"));
    if (request.signal.aborted) stop();
    else request.signal.addEventListener("abort", stop, { once: true });
  });
}

function provider(extra: Partial<Provider> = {}): Provider {
  return {
    id: "claude-code",
    label: "Claude Code",
    suggestedModels: [{ id: "sonnet", label: "Sonnet" }],
    readsScannedPdfs: true,
    readsPdfPageRanges: true,
    detect: async () => ({ available: true, status: "ready", detail: "Ready." }),
    generate: (request) => {
      requests.push(request);
      return answer(request, requests.length);
    },
    ...extra,
  };
}

function build(overrides: Partial<StudyServiceDeps> = {}): StudyService {
  return createStudyService({
    library,
    registry: createProviderRegistry([provider()]),
    settings,
    tasks,
    progress: (report) => progress.push(report),
    log: (message, detail) => logged.push({ message, detail }),
    now: () => clock,
    tickMs: 10_000,
    ...overrides,
  });
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "studiplan-study-")));
  root = path.join(sandbox, "library");
  trashed = [];
  library = createLibrary({
    root: () => ({ root, isDefault: false, fixedByEnvironment: false }),
    trash: async (target) => {
      trashed.push(target);
      await rm(target, { recursive: true });
    },
    log: () => {},
    now: () => new Date(2026, 9, 2, 14, 30),
  });
  settings = createSettingsStore(path.join(sandbox, "profile"));
  await settings.update({ defaultProvider: "claude-code", models: { "claude-code": "sonnet" } });
  tasks = createTaskRegistry();
  requests = [];
  progress = [];
  logged = [];
  clock = new Date(2026, 9, 2, 14, 30);
  answer = async () => CARDS;
  service = build();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function value<T>(result: StudyResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fails<T>(result: StudyResult<T>) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  // No sentence shown to a student carries a path, an error code or a stack.
  expect(result.error.message).not.toContain(sandbox);
  expect(result.error.message).not.toMatch(/E[A-Z]{4,}|\bat .+:\d+/);
  expect(result.error.message.length).toBeGreaterThan(10);
  return result.error;
}

/** A material with one two-page PDF that has text. */
async function material(title = "Cell division", withFiles = true): Promise<MaterialRef> {
  if (!existsSync(path.join(root, "Biology"))) await library.createSubject("Biology");
  const made = await library.createMaterial("Biology", title);
  if (!made.ok) throw new Error(made.error.message);
  const ref = { subject: "Biology", material: made.value.id };
  if (withFiles) {
    await addPdf(ref, "chapter.pdf", [
      textStream(["Mitosis has four phases: prophase, metaphase, anaphase, telophase.", SECRET_MATERIAL]),
      textStream(["Meiosis halves the number of chromosomes in two divisions."]),
    ]);
  }
  return ref;
}

async function addPdf(ref: MaterialRef, name: string, pages: string[]): Promise<void> {
  const source = path.join(sandbox, name);
  await writeFile(source, makePdf(pages));
  const added = await library.addFiles(ref, [source]);
  if (!added.ok || added.value.rejected.length > 0) throw new Error("the fixture PDF was not added");
}

function setsDir(ref: MaterialRef): string {
  return path.join(root, ref.subject, ref.material, "sets");
}

async function setFiles(ref: MaterialRef): Promise<string[]> {
  return (await readdir(setsDir(ref))).sort();
}

function make(ref: MaterialRef, kind: StudySetKind, extra: Record<string, unknown> = {}): Promise<StudyResult<GenerateOutcome>> {
  return service.generate(ref, { requestId: ID, kind, ...extra });
}

describe("generate", () => {
  for (const kind of MAKEABLE_KINDS) {
    it(`makes, checks and saves a ${kind}`, async () => {
      const ref = await material();
      answer = async () => VALID[kind];
      const options = kind === "custom" ? { request: "Explain mitosis like I am ten." } : {};
      const outcome = value(await make(ref, kind, { options }));

      const extension = STUDY_SET_FORMATS[kind] === "markdown" ? "md" : "json";
      expect(outcome.result.name).toBe(`2026-10-02-${kind}.${extension}`);
      expect(outcome.result).toMatchObject({
        kind,
        provider: "claude-code",
        providerLabel: "Claude Code",
        model: "sonnet",
        coverage: "whole",
        problem: null,
        itemCount: extension === "json" ? 2 : null,
      });
      expect(outcome.result.title).toBe(
        kind === "custom"
          ? "Explain mitosis like I am ten."
          : `${{ summary: "Summary", explain: "Explanation", cheatsheet: "Cheat sheet", flashcards: "Flashcards", test: "Practice test", quiz: "Quiz", exam: "Mock exam" }[kind]}: Cell division`,
      );
      expect(outcome).toMatchObject({ notices: [], warnings: [], attempts: 1 });

      // On disk: exactly that file, and it opens.
      expect(await setFiles(ref)).toEqual([outcome.result.name]);
      const text = await readFile(path.join(setsDir(ref), outcome.result.name), "utf8");
      expect(parseStudySetFile(outcome.result.name, text).ok).toBe(true);
      const opened = value(await service.read(ref, outcome.result.name));
      expect(opened.set.kind).toBe(kind);
      expect(opened.set.created).toBe(clock.toISOString());

      // One request: text inline, no folder to read from, a schema only for the JSON kinds.
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.parts).toHaveLength(1);
      expect(request?.parts[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(request?.parts)).toContain("Mitosis has four phases");
      expect(request?.instructions).not.toContain("Mitosis has four phases");
      expect(request?.workingDirectory).toBeUndefined();
      expect(request?.model).toBe("sonnet");
      expect(request?.jsonSchema === undefined).toBe(extension === "md");

      expect(progress.map((report) => report.message)).toEqual([
        "Reading the files…",
        "Asking Claude Code…",
        "Checking the answer…",
        "Saving…",
      ]);
      expect(progress.every((report) => report.requestId === ID && report.fraction === null)).toBe(true);
      expect(service.current()).toBeNull();
      expect(tasks.size).toBe(0);
    });
  }

  it("tells the model how long a summary of this material should be", async () => {
    const ref = await material("Long", false);
    const page = textStream(Array.from({ length: 40 }, (_, line) => `Line ${line} says that cells divide and grow again.`));
    await addPdf(ref, "long.pdf", [page, page, page]);
    answer = async () => MARKDOWN;
    value(await make(ref, "summary", { options: { length: "short" } }));
    // About 1,100 words went out: a sixth of that, not "150 to 400 whatever the material".
    expect(requests[0]?.instructions).toMatch(/This material holds roughly 1,[01]\d0 words\. Write about 1[6-9]0 words/);
    // The other kinds are sized by their count, not by words.
    answer = async () => CARDS;
    value(await make(ref, "flashcards"));
    expect(requests[1]?.instructions).not.toMatch(/This material holds roughly/);
  });

  it("counts the result in the material's setCount", async () => {
    const ref = await material();
    value(await make(ref, "flashcards"));
    await writeFile(path.join(setsDir(ref), "my own notes.txt"), "not a result");
    const listed = await library.listMaterials("Biology");
    expect(listed.ok && listed.value[0]?.setCount).toBe(1);
  });

  it("asks once more with the errors when the first answer is invalid, and saves the second", async () => {
    const ref = await material();
    answer = async (_request, call) => (call === 1 ? '{"cards":[]}' : CARDS);
    const outcome = value(await make(ref, "flashcards"));
    expect(outcome.attempts).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.instructions).toContain(requests[0]?.instructions);
    expect(requests[1]?.instructions).toContain("Second attempt");
    expect(requests[1]?.instructions).toMatch(/cards must contain at least one entry/);
    // The first reply is not quoted back into the instructions (they travel in argv).
    expect(requests[1]?.instructions).not.toContain("YOUR FIRST REPLY");
    expect(requests[1]?.parts).toEqual(requests[0]?.parts);
    expect(progress.map((report) => report.message)).toEqual([
      "Reading the files…",
      "Asking Claude Code…",
      "Checking the answer…",
      "The first answer could not be used. Asking Claude Code once more…",
      "Checking the answer…",
      "Saving…",
    ]);
    expect(await setFiles(ref)).toEqual(["2026-10-02-flashcards.json"]);
  });

  it("reports and saves nothing when the answer is invalid twice", async () => {
    const ref = await material();
    answer = async () => '{"cards":[{"front":"","back":""}]}';
    const error = fails(await make(ref, "flashcards"));
    expect(error.code).toBe("invalid-result");
    expect(error.message).toMatch(/Try again/);
    expect(error.message).toMatch(/fewer cards/);
    expect(error.message).toMatch(/another model in Settings/);
    expect(requests).toHaveLength(2);
    expect(await setFiles(ref)).toEqual([]);
  });

  it("treats the provider's bad-output like a failed check: one retry, then the same sentence", async () => {
    const ref = await material();
    answer = async (_request, call) => {
      if (call === 1) throw failure("bad-output", "Claude Code");
      return QUESTIONS;
    };
    expect(value(await make(ref, "test")).attempts).toBe(2);
    expect(requests[1]?.instructions).toContain("Second attempt");

    requests = [];
    answer = async () => {
      throw failure("bad-output", "Claude Code");
    };
    clock = new Date(2026, 9, 2, 14, 31);
    expect(fails(await make(ref, "summary")).code).toBe("invalid-result");
    expect(requests).toHaveLength(2);
    expect(await setFiles(ref)).toEqual(["2026-10-02-test.json"]);
  });

  it("passes the provider's own failure sentences through, without a retry", async () => {
    const ref = await material();
    for (const code of ["usage-limit", "not-signed-in", "not-installed", "timed-out", "offline", "busy", "too-large", "model-unavailable"] as const) {
      requests = [];
      const thrown = failure(code, "Claude Code");
      answer = async () => {
        throw thrown;
      };
      const error = fails(await make(ref, "flashcards"));
      expect(error).toEqual({ code, message: thrown.message });
      expect(requests).toHaveLength(1);
    }
    expect(await setFiles(ref)).toEqual([]);
  });

  it("fails before any AI call when the material has no files", async () => {
    const ref = await material("Empty", false);
    const error = fails(await make(ref, "summary"));
    expect(error.code).toBe("nothing-readable");
    expect(error.message).toMatch(/has no files yet/);
    expect(requests).toHaveLength(0);
    expect(await setFiles(ref)).toEqual([]);
  });

  it("fails before any AI call when nothing in the material can be read, and says why", async () => {
    const ref = await material("Scans", false);
    await addPdf(ref, "scan.pdf", [PICTURE_ONLY_STREAM]);
    // An AI that cannot look at a PDF's pages itself.
    service = build({ registry: createProviderRegistry([provider({ readsScannedPdfs: false })]) });
    const error = fails(await make(ref, "summary"));
    expect(error.code).toBe("nothing-readable");
    expect(error.message).toMatch(/Nothing in this material could be read/);
    expect(error.details?.join(" ")).toMatch(/"scan\.pdf" was not sent.*no readable text/);
    expect(requests).toHaveLength(0);
  });

  it("hands a scan to an AI that can read one, as a file inside the material's files folder", async () => {
    const ref = await material("Scans", false);
    await addPdf(ref, "scan.pdf", [PICTURE_ONLY_STREAM]);
    answer = async () => MARKDOWN;
    const outcome = value(await make(ref, "summary"));
    expect(outcome.notices).toEqual([]);
    expect(requests[0]?.parts).toEqual([{ type: "file", path: path.join(root, "Biology", "Scans", "files", "scan.pdf") }]);
    expect(requests[0]?.workingDirectory).toBe(path.join(root, "Biology", "Scans", "files"));
    expect(requests[0]?.instructions).toMatch(/Scanned PDFs/);
  });

  it("sends photos as images and text inline, from the files folder", async () => {
    const ref = await material();
    const deck = path.join(sandbox, "slides.pptx");
    await writeFile(deck, await makePptx({ order: [1], slides: { 1: { title: "Checkpoints", body: ["The cell cycle is checked at three points: G1, G2 and the metaphase checkpoint."] } } }));
    await library.addFiles(ref, [deck]);
    await library.addPhotoSet(ref, [JPEG, JPEG]);
    value(await make(ref, "flashcards"));
    const parts = requests[0]?.parts ?? [];
    expect(parts.map((part) => part.type)).toEqual(["text", "text", "image", "image"]);
    const files = path.join(root, ref.subject, ref.material, "files");
    expect(parts[2]).toEqual({ type: "image", path: path.join(files, "notes-2026-10-02", "page-1.jpg") });
    expect(requests[0]?.workingDirectory).toBe(files);
  });

  it("tells the student and the saved file when the material was cut", async () => {
    const ref = await material();
    service = build({
      prepare: (located, chosen, options) =>
        prepareMaterial(located, chosen, {
          ...options,
          buildContent: async (files, contentOptions) => {
            const { buildPromptContent } = await import("../extract");
            return buildPromptContent(files, { ...contentOptions, maxTextChars: 330 });
          },
        }),
    });
    const outcome = value(await make(ref, "flashcards"));
    expect(outcome.notices).toEqual(['Only the first 1 of 2 pages of "chapter.pdf" were sent.']);
    expect(outcome.result.coverage).toBe("cut");
    expect(value(await service.read(ref, outcome.result.name)).set.coverage).toBe("cut");
    expect(requests[0]?.instructions).toMatch(/too long to send whole/);
    expect(JSON.stringify(requests[0]?.parts)).not.toContain("Meiosis halves");
  });

  it("cuts the material to what the chosen AI and model can take, instead of being refused", async () => {
    const ref = await material();
    const asked: unknown[] = [];
    service = build({
      registry: createProviderRegistry([
        provider({
          id: "ollama",
          label: "Ollama",
          readsScannedPdfs: false,
          maxTextChars: async (model, input) => {
            asked.push([model, input?.images, (input?.instructionChars ?? 0) > 5_000]);
            return 330;
          },
        }),
      ]),
    });
    await settings.update({ defaultProvider: "ollama", models: { ollama: "gemma4" } });
    const outcome = value(await make(ref, "flashcards"));
    expect(asked).toEqual([["gemma4", 0, true]]);
    // 330 is under the smallest budget worth cutting to, so that one applies: still far less
    // than the whole material would need with a real model's 35,000.
    expect(outcome.result).toMatchObject({ provider: "ollama", providerLabel: "Ollama", model: "gemma4" });
    expect(requests).toHaveLength(1);
  });

  it("says where to go when no AI is chosen, and asks nobody", async () => {
    const ref = await material();
    await settings.update({ defaultProvider: undefined });
    const error = fails(await make(ref, "summary"));
    expect(error.code).toBe("no-provider");
    expect(error.message).toMatch(/Settings/);
    expect(requests).toHaveLength(0);
    expect(progress).toEqual([]);
  });

  it("uses the provider and model of the request over the saved ones", async () => {
    const ref = await material();
    await settings.update({ defaultProvider: undefined });
    const outcome = value(await make(ref, "flashcards", { provider: "claude-code", model: "opus" }));
    expect(requests[0]?.model).toBe("opus");
    expect(outcome.result.model).toBe("opus");
    expect(fails(await make(ref, "flashcards", { provider: "claude-code", model: "not a model!" })).code).toBe("model-unavailable");
    expect(fails(await make(ref, "flashcards", { provider: "ollama" })).message).toMatch(/not available in this version/);
    expect(fails(await make(ref, "flashcards", { provider: "nonsense" })).code).toBe("invalid-request");
    expect(requests).toHaveLength(1);
  });

  it('asks for the text of "Something else…" before asking the AI', async () => {
    const ref = await material();
    const error = fails(await make(ref, "custom", { options: { request: "   " } }));
    expect(error).toEqual({ code: "empty-request", message: "Write what you want made from this material first." });
    expect(requests).toHaveLength(0);
  });

  it("refuses arguments that are not what the contract says", async () => {
    const ref = await material();
    const bad = async (target: unknown, request: unknown): Promise<void> => {
      expect(fails(await service.generate(target, request)).code).toBe("invalid-request");
    };
    await bad(ref, null);
    await bad(ref, { requestId: "short", kind: "test" });
    await bad(ref, { requestId: ID, kind: "poem" });
    await bad(null, { requestId: ID, kind: "test" });
    await bad({ subject: 1, material: 2 }, { requestId: ID, kind: "test" });
    await bad(ref, { requestId: ID, kind: "test", options: { count: "ten" } });
    await bad(ref, { requestId: ID, kind: "summary", options: { length: "huge" } });
    await bad(ref, { requestId: ID, kind: "test", options: [] });
    expect(requests).toHaveLength(0);
    expect(tasks.size).toBe(0);
    expect(service.current()).toBeNull();
  });

  it("no longer makes a quiz or a mock exam: earlier versions did, this one only reads them", async () => {
    const ref = await material();
    answer = async () => QUESTIONS;
    for (const kind of ["quiz", "exam"] as const) {
      const error = fails(await make(ref, kind));
      expect(error.code).toBe("invalid-request");
    }
    expect(requests).toHaveLength(0);
    expect(await readdir(setsDir(ref)).catch(() => [])).toEqual([]);
    expect(tasks.size).toBe(0);
    expect(service.current()).toBeNull();
    // Everything that can be asked for is still made.
    expect(MAKEABLE_KINDS).toEqual(["summary", "explain", "cheatsheet", "flashcards", "test", "custom"]);
    expect(value(await make(ref, "test")).result.kind).toBe("test");
  });

  it("does not leave the library through the material's names", async () => {
    await material();
    for (const ref of [
      { subject: "..", material: "Biology" },
      { subject: "Biology", material: "..\\..\\outside" },
      { subject: "Biology", material: "Cell division/../.." },
      { subject: "C:\\Windows", material: "System32" },
    ]) {
      expect(fails(await service.generate(ref, { requestId: ID, kind: "summary" })).code).toBe("outside-library");
    }
    expect(fails(await make({ subject: "Biology", material: "Gone" }, "summary")).code).toBe("not-found");
    expect(requests).toHaveLength(0);
  });

  it("names a second result of the same kind and day -2, and never reuses a deleted number", async () => {
    const ref = await material();
    const names: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      clock = new Date(2026, 9, 2, 14, 30 + index);
      names.push(value(await make(ref, "flashcards")).result.name);
    }
    expect(names).toEqual(["2026-10-02-flashcards.json", "2026-10-02-flashcards-2.json", "2026-10-02-flashcards-3.json"]);

    value(await service.remove(ref, "2026-10-02-flashcards-2.json"));
    expect(value(await make(ref, "flashcards")).result.name).toBe("2026-10-02-flashcards-4.json");

    // A name the student took by hand, in other capitals, is not overwritten either.
    await writeFile(path.join(setsDir(ref), "2026-10-02-TEST.json"), "mine");
    answer = async () => QUESTIONS;
    expect(value(await make(ref, "test")).result.name).toBe("2026-10-02-test-2.json");
    expect(await readFile(path.join(setsDir(ref), "2026-10-02-TEST.json"), "utf8")).toBe("mine");
  });

  it("makes one result at a time in the whole app", async () => {
    const first = await material();
    const second = await material("Other");
    answer = untilAborted;
    const running = make(first, "flashcards");
    await expect.poll(() => requests.length).toBe(1);

    expect(service.current()).toMatchObject({ requestId: ID, ref: first, kind: "flashcards", message: "Asking Claude Code…" });
    const refused = fails(await service.generate(second, { requestId: "request-0002", kind: "test" }));
    expect(refused.code).toBe("already-generating");
    expect(refused.message).toMatch(/already making something/);
    expect(requests).toHaveLength(1);

    expect(tasks.cancel(ID)).toBe(true);
    expect(fails(await running).code).toBe("cancelled");
    expect(service.current()).toBeNull();

    answer = async () => QUESTIONS;
    expect(value(await service.generate(second, { requestId: "request-0002", kind: "test" })).result.kind).toBe("test");
  });

  it("keeps the student informed while the AI works", async () => {
    const ref = await material();
    service = build({ tickMs: 15 });
    answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return CARDS;
    };
    value(await make(ref, "flashcards"));
    const waiting = progress.map((report) => report.message).filter((message) => / so far\./.test(message));
    expect(waiting.length).toBeGreaterThan(1);
    expect(waiting[0]).toMatch(/^Asking Claude Code… \d+ seconds? so far\.$/);
    expect(progress.at(-1)?.message).toBe("Saving…");
  });

  it("puts the time into words", () => {
    expect(elapsedWords(10_000)).toBe("10 seconds");
    expect(elapsedWords(1_000)).toBe("1 second");
    expect(elapsedWords(60_000)).toBe("1 minute");
    expect(elapsedWords(130_000)).toBe("2 minutes 10 seconds");
  });

  it("logs counts, durations and codes, never the material, the instructions or the answer", async () => {
    const ref = await material();
    value(await make(ref, "flashcards"));
    answer = async () => `{"cards": "${SECRET_ANSWER}"}`;
    clock = new Date(2026, 9, 2, 14, 31);
    fails(await make(ref, "flashcards"));
    answer = async () => {
      throw failure("usage-limit", "Claude Code");
    };
    fails(await make(ref, "flashcards"));

    expect(logged.map((line) => line.message)).toEqual([
      "study: made a result",
      "study: nothing was made",
      "study: nothing was made",
    ]);
    expect(logged[0]?.detail).toMatchObject({ kind: "flashcards", provider: "claude-code", attempts: 1, items: 2, files: 1, images: 0 });
    expect(logged[1]?.detail).toMatchObject({ code: "invalid-result", attempts: 2 });
    expect(logged[2]?.detail).toMatchObject({ code: "usage-limit" });
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain(SECRET_MATERIAL);
    expect(everything).not.toContain(SECRET_ANSWER);
    expect(everything).not.toContain("Mitosis");
    expect(everything).not.toContain("flashcards from the student");
    expect(everything).not.toContain(sandbox);
    for (const line of logged) {
      for (const entry of Object.values(line.detail ?? {})) expect(typeof entry === "number" || String(entry).length < 40).toBe(true);
    }
  });
});

describe("cancel", () => {
  async function expectNothingSaved(ref: MaterialRef, pending: Promise<StudyResult<GenerateOutcome>>): Promise<void> {
    const error = fails(await pending);
    expect(error).toEqual({ code: "cancelled", message: "Cancelled. Nothing was saved." });
    // Nothing at all: no result, no temporary file.
    expect(await readdir(setsDir(ref))).toEqual([]);
    expect(service.current()).toBeNull();
    expect(tasks.size).toBe(0);
  }

  it("while reading the files: no AI is asked", async () => {
    const ref = await material();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    service = build({
      prepare: async (located, chosen, options) => {
        await gate;
        return prepareMaterial(located, chosen, options);
      },
    });
    const pending = make(ref, "flashcards");
    await expect.poll(() => progress.at(-1)?.message).toBe("Reading the files…");
    expect(tasks.cancel(ID)).toBe(true);
    release();
    await expectNothingSaved(ref, pending);
    expect(requests).toHaveLength(0);
  });

  it("while the AI is working: its request is aborted", async () => {
    const ref = await material();
    answer = untilAborted;
    const pending = make(ref, "flashcards");
    await expect.poll(() => requests.length).toBe(1);
    tasks.cancel(ID);
    await expectNothingSaved(ref, pending);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("while the AI is working on the second attempt", async () => {
    const ref = await material();
    answer = (request, call) => (call === 1 ? Promise.resolve("{}") : untilAborted(request));
    const pending = make(ref, "flashcards");
    await expect.poll(() => requests.length).toBe(2);
    tasks.cancel(ID);
    await expectNothingSaved(ref, pending);
  });

  it("just as a valid answer arrives, before it is checked", async () => {
    const ref = await material();
    answer = async () => {
      tasks.cancel(ID);
      return CARDS;
    };
    await expectNothingSaved(ref, make(ref, "flashcards"));
    expect(progress.map((report) => report.message)).not.toContain("Checking the answer…");
  });

  it("when a cancelled provider reports something else, the cancel still wins", async () => {
    const ref = await material();
    answer = async () => {
      tasks.cancel(ID);
      throw failure("failed", "Claude Code");
    };
    await expectNothingSaved(ref, make(ref, "flashcards"));
  });

  it("after the check, before saving", async () => {
    const ref = await material();
    service = build({
      progress: (report) => {
        progress.push(report);
        if (report.message === "Saving…") tasks.cancel(ID);
      },
    });
    await expectNothingSaved(ref, make(ref, "flashcards"));
  });

  it("while waiting for the library to write: nothing is written", async () => {
    const ref = await material();
    service = build({
      library: {
        ...library,
        saveSetFile: (target, choose) => {
          tasks.cancel(ID);
          return library.saveSetFile(target, choose);
        },
      },
    });
    await expectNothingSaved(ref, make(ref, "flashcards"));
  });

  it("leaves nothing half-written when the disk refuses the file", async () => {
    const ref = await material();
    service = build({
      library: {
        ...library,
        saveSetFile: async () => ({ ok: false, error: { code: "io", message: "The disk is full. Free up some space and try again." } }),
      },
    });
    const error = fails(await make(ref, "flashcards"));
    expect(error).toEqual({ code: "io", message: "The disk is full. Free up some space and try again." });
    expect(await readdir(setsDir(ref))).toEqual([]);
  });
});

describe("list and read", () => {
  it("lists newest first, with what the Results list shows", async () => {
    const ref = await material();
    clock = new Date(2026, 9, 2, 9, 0);
    answer = async () => MARKDOWN;
    value(await make(ref, "summary"));
    clock = new Date(2026, 9, 2, 9, 5);
    answer = async () => QUESTIONS;
    value(await make(ref, "test"));
    clock = new Date(2026, 9, 3, 8, 0);
    answer = async () => CARDS;
    value(await make(ref, "flashcards"));

    const rows = value(await service.list(ref));
    expect(rows.map((row) => row.name)).toEqual(["2026-10-03-flashcards.json", "2026-10-02-test.json", "2026-10-02-summary.md"]);
    expect(rows.map((row) => row.itemCount)).toEqual([2, 2, null]);
    expect(rows[0]).toEqual({
      name: "2026-10-03-flashcards.json",
      kind: "flashcards",
      title: "Flashcards: Cell division",
      created: clock.toISOString(),
      itemCount: 2,
      provider: "claude-code",
      providerLabel: "Claude Code",
      model: "sonnet",
      coverage: "whole",
      length: null,
      testLength: null,
      written: null,
      problem: null,
    });
    // A summary says how long it was asked to be; nothing else does.
    expect(rows.map((row) => row.length)).toEqual([null, null, "medium"]);
    // A second listing gives the same rows (from memory) and still sees a changed file.
    expect(value(await service.list(ref))).toEqual(rows);
    await writeFile(path.join(setsDir(ref), "2026-10-02-test.json"), "{ broken");
    const again = value(await service.list(ref));
    expect(again.find((row) => row.name === "2026-10-02-test.json")?.problem).toMatch(/cannot be opened/);
    // It no longer says when it was made, so it sorts by the day in its name.
    expect(again.map((row) => row.name)).toEqual(["2026-10-03-flashcards.json", "2026-10-02-summary.md", "2026-10-02-test.json"]);
  });

  it("is an empty list for a material without results, even without a sets folder", async () => {
    const ref = await material();
    await rm(setsDir(ref), { recursive: true });
    expect(value(await service.list(ref))).toEqual([]);
    expect(value(await make(ref, "flashcards")).result.name).toBe("2026-10-02-flashcards.json");
  });

  it("tolerates hand-edited and foreign files", async () => {
    const ref = await material();
    const sets = setsDir(ref);
    // Foreign: not results, never listed.
    await writeFile(path.join(sets, "notes.txt"), "mine");
    await writeFile(path.join(sets, "2026-13-45-quiz.json"), QUESTIONS);
    await writeFile(path.join(sets, "2026-09-27-quiz.md"), "wrong ending for a quiz");
    await writeFile(path.join(sets, ".incoming-abc.part"), "half");
    await mkdir(path.join(sets, "2026-09-28-quiz.json"));
    // A summary whose front matter the student deleted: still opens.
    await writeFile(path.join(sets, "2026-09-30-summary.md"), "# My own summary\r\n\r\nEdited by hand.\r\n");
    // A quiz that is no longer valid JSON, and one that is JSON but not a quiz.
    await writeFile(path.join(sets, "2026-09-29-quiz.json"), "{ broken");
    await writeFile(path.join(sets, "2026-09-29-flashcards.json"), JSON.stringify({ content: { cards: [{ front: "", back: 3 }] } }));
    // A deck written by hand with only the content: opens, with defaults for the rest.
    await writeFile(path.join(sets, "2026-09-26-flashcards.json"), `\ufeff${JSON.stringify({ content: JSON.parse(CARDS) })}`);
    // One from a newer version of the app.
    await writeFile(path.join(sets, "2026-09-25-exam.json"), JSON.stringify({ schemaVersion: 99, content: {} }));

    const rows = value(await service.list(ref));
    expect(rows.map((row) => row.name)).toEqual([
      "2026-09-30-summary.md",
      "2026-09-29-flashcards.json",
      "2026-09-29-quiz.json",
      "2026-09-26-flashcards.json",
      "2026-09-25-exam.json",
    ]);
    expect(rows[0]).toMatchObject({ title: "My own summary", problem: null, provider: null, coverage: "unknown", itemCount: null });
    expect(rows[2]).toMatchObject({ kind: "quiz", title: "Quiz", itemCount: null });
    expect(rows[2]?.problem).toMatch(/cannot be opened/);
    expect(rows[1]?.problem).toMatch(/cannot be opened/);
    expect(rows[3]).toMatchObject({ title: "Flashcards", itemCount: 2, problem: null });
    expect(rows[4]?.problem).toMatch(/newer version/);

    expect(value(await service.read(ref, "2026-09-30-summary.md")).set.content).toEqual({ length: null, body: "# My own summary\n\nEdited by hand." });
    const broken = fails(await service.read(ref, "2026-09-29-quiz.json"));
    expect(broken.code).toBe("unreadable-result");
    expect(broken.message).toMatch(/changed outside Studiplan/);
    expect(broken.details).toEqual(["The file is not valid JSON, so it cannot be opened."]);
    const wrong = fails(await service.read(ref, "2026-09-29-flashcards.json"));
    expect(wrong.code).toBe("unreadable-result");
    expect(wrong.details?.length).toBeGreaterThan(0);
    expect(fails(await service.read(ref, "2026-09-25-exam.json")).message).toMatch(/Update the app/);

    // What is not a result cannot be read, renamed or deleted through this door.
    for (const name of ["notes.txt", "2026-13-45-quiz.json", "2026-09-28-quiz.json", ".incoming-abc.part", "2026-10-02-flashcards.json"]) {
      expect(fails(await service.read(ref, name)).code).toBe("not-found");
      expect(fails(await service.remove(ref, name)).code).toBe("not-found");
      expect(fails(await service.rename(ref, name, "New")).code).toBe("not-found");
    }
    expect(trashed).toEqual([]);
    expect(await readFile(path.join(sets, "notes.txt"), "utf8")).toBe("mine");
  });

  it("refuses names that are not one result of this material", async () => {
    const ref = await material();
    value(await make(ref, "flashcards"));
    await writeFile(path.join(sandbox, "2026-10-02-quiz.json"), QUESTIONS);
    await writeFile(path.join(root, "Biology", "2026-10-02-quiz.json"), QUESTIONS);

    for (const name of [
      "../material.json",
      "..\\material.json",
      "../../2026-10-02-quiz.json",
      "..\\..\\2026-10-02-quiz.json",
      "sets/2026-10-02-flashcards.json",
      path.join(setsDir(ref), "2026-10-02-flashcards.json"),
      "C:2026-10-02-flashcards.json",
      "2026-10-02-flashcards.json:stream",
      "2026-10-02-flashcards.json.",
      "..",
      "",
    ]) {
      for (const result of [await service.read(ref, name), await service.rename(ref, name, "X"), await service.remove(ref, name)]) {
        expect(["outside-library", "not-found"]).toContain(fails(result as StudyResult<unknown>).code);
      }
    }
    for (const name of [null, undefined, 7, ["2026-10-02-flashcards.json"], { name: "x" }]) {
      expect(fails(await service.read(ref, name)).code).toBe("invalid-request");
      expect(fails(await service.remove(ref, name)).code).toBe("invalid-request");
    }
    expect(fails(await service.list({ subject: "..", material: "x" })).code).toBe("outside-library");
    expect(fails(await service.read({ subject: "Biology", material: ".." }, "2026-10-02-quiz.json")).code).toBe("outside-library");
    expect(trashed).toEqual([]);
    expect(await setFiles(ref)).toEqual(["2026-10-02-flashcards.json"]);
  });

  it("does not follow links", async () => {
    const ref = await material();
    const outside = path.join(sandbox, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "2026-10-01-quiz.json"), JSON.stringify({ content: JSON.parse(QUESTIONS) }));

    // A result that is a link to a file somewhere else (needs a privilege on Windows).
    let linked = true;
    try {
      await symlink(path.join(outside, "2026-10-01-quiz.json"), path.join(setsDir(ref), "2026-10-01-quiz.json"), "file");
    } catch {
      linked = false;
    }
    if (linked) {
      expect(value(await service.list(ref))).toEqual([]);
      expect(fails(await service.read(ref, "2026-10-01-quiz.json")).code).toMatch(/outside-library|not-found/);
      expect(fails(await service.remove(ref, "2026-10-01-quiz.json")).code).toMatch(/outside-library|not-found/);
      await rm(path.join(setsDir(ref), "2026-10-01-quiz.json"));
    }

    // sets/ itself replaced by a link to a folder outside the library.
    await rm(setsDir(ref), { recursive: true });
    await symlink(outside, setsDir(ref), "junction");
    expect(fails(await service.list(ref)).code).toBe("outside-library");
    expect(fails(await service.read(ref, "2026-10-01-quiz.json")).code).toBe("outside-library");
    expect(fails(await service.rename(ref, "2026-10-01-quiz.json", "X")).code).toBe("outside-library");
    expect(fails(await service.remove(ref, "2026-10-01-quiz.json")).code).toBe("outside-library");
    expect(fails(await make(ref, "flashcards")).code).toBe("outside-library");
    expect(await readdir(outside)).toEqual(["2026-10-01-quiz.json"]);
    expect(trashed).toEqual([]);
  });
});

describe("rename and remove", () => {
  it("changes the title of a JSON result and nothing else", async () => {
    const ref = await material();
    const made = value(await make(ref, "flashcards"));
    const file = path.join(setsDir(ref), made.result.name);
    const before = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

    const row = value(await service.rename(ref, made.result.name, "  Mitosis:\n the  basics  "));
    expect(row).toEqual({ ...made.result, title: "Mitosis: the basics" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...before, title: "Mitosis: the basics" });
    expect(await setFiles(ref)).toEqual([made.result.name]);
    expect(value(await service.list(ref))[0]?.title).toBe("Mitosis: the basics");
  });

  it("changes the title of a Markdown result and keeps the student's text as it is", async () => {
    const ref = await material();
    answer = async () => MARKDOWN;
    const made = value(await make(ref, "summary"));
    const file = path.join(setsDir(ref), made.result.name);
    const before = await readFile(file, "utf8");

    value(await service.rename(ref, made.result.name, 'A "quoted": title'));
    const after = await readFile(file, "utf8");
    expect(after).toBe(before.replace('title: "Summary: Cell division"', 'title: "A \\"quoted\\": title"'));
    expect(value(await service.read(ref, made.result.name)).set.title).toBe('A "quoted": title');

    // A summary without front matter gets the little it needs; the body is untouched.
    await writeFile(path.join(setsDir(ref), "2026-09-30-summary.md"), "# Mine\r\n\r\nEdited by hand.\r\n");
    const row = value(await service.rename(ref, "2026-09-30-summary.md", "Renamed"));
    expect(row.title).toBe("Renamed");
    expect(await readFile(path.join(setsDir(ref), "2026-09-30-summary.md"), "utf8")).toBe(
      '---\r\ntitle: "Renamed"\r\nkind: summary\r\n---\r\n\r\n# Mine\r\n\r\nEdited by hand.\r\n',
    );
  });

  it("refuses an empty or endless title, and a file that does not open", async () => {
    const ref = await material();
    const made = value(await make(ref, "flashcards"));
    expect(fails(await service.rename(ref, made.result.name, "   ")).code).toBe("invalid-name");
    expect(fails(await service.rename(ref, made.result.name, "x".repeat(201))).code).toBe("invalid-name");
    expect(fails(await service.rename(ref, made.result.name, 5)).code).toBe("invalid-request");

    await writeFile(path.join(setsDir(ref), "2026-09-29-quiz.json"), "{ broken");
    expect(fails(await service.rename(ref, "2026-09-29-quiz.json", "New")).code).toBe("unreadable-result");
    expect(await readFile(path.join(setsDir(ref), "2026-09-29-quiz.json"), "utf8")).toBe("{ broken");
    expect((await setFiles(ref)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("moves a result to the recycle bin, even one that does not open", async () => {
    const ref = await material();
    const made = value(await make(ref, "flashcards"));
    await writeFile(path.join(setsDir(ref), "2026-09-29-quiz.json"), "{ broken");
    expect(value(await service.remove(ref, made.result.name))).toBeNull();
    expect(value(await service.remove(ref, "2026-09-29-quiz.json"))).toBeNull();
    expect(trashed).toEqual([path.join(setsDir(ref), made.result.name), path.join(setsDir(ref), "2026-09-29-quiz.json")]);
    expect(value(await service.list(ref))).toEqual([]);
    expect(fails(await service.remove(ref, made.result.name)).code).toBe("not-found");
  });
});

describe("an AI that says it cannot use the material", () => {
  const REAL_APOLOGY =
    "I could not read the material, so I have not written a summary. The PDF `scan.pdf` is a scan, and the tool that turns its pages into images (poppler's `pdftoppm`) is not installed here.\n\nTo fix this, install poppler-utils and run the summary again.";

  it.each([
    ["summary", "CANNOT_USE_MATERIAL: The PDF could not be opened.", "The PDF could not be opened."],
    ["custom", "CANNOT_USE_MATERIAL: The pages are blank.", "The pages are blank."],
    ["summary", REAL_APOLOGY, "I could not read the material, so I have not written a summary."],
    ["flashcards", '{"cards":[],"problem":"The file is empty."}', "The file is empty."],
    ["test", '{"questions":[],"problem":"Nothing readable arrived."}', "Nothing readable arrived."],
  ] as const)("%s: saves nothing, asks once, and quotes the AI as the AI", async (kind, reply, reason) => {
    const ref = await material();
    answer = async () => reply;
    const error = fails(await make(ref, kind, { options: kind === "custom" ? { request: "A timeline" } : {} }));
    expect(error.code).toBe("unusable-material");
    // The app's own sentence is fixed; the model's words come separately, marked as its words.
    expect(error.message).toBe(
      "Claude Code could not make this from the material, so nothing was saved. Check that the files open and can be read; for a scan, add photos of the pages instead. Then try again.",
    );
    expect(error.details).toEqual([`Claude Code said: “${reason}”`]);
    expect(requests).toHaveLength(1);
    expect(await setFiles(ref)).toEqual([]);
    expect(logged.at(-1)?.detail).toMatchObject({ code: "unusable-material", refused: true });
    expect(JSON.stringify(logged)).not.toContain(reason);
  });

  it("has no detail when the AI gave no reason, and never repeats a long one in full", async () => {
    const ref = await material();
    answer = async () => "CANNOT_USE_MATERIAL:";
    expect(fails(await make(ref, "summary")).details).toBeUndefined();
    answer = async () => `CANNOT_USE_MATERIAL: ${"blah ".repeat(200)}`;
    expect(fails(await make(ref, "summary")).details?.[0]?.length).toBeLessThan(330);
  });

  it("is not asked again after an invalid first answer either", async () => {
    const ref = await material();
    answer = async (_request, call) => (call === 1 ? '{"cards":[]}' : '{"cards":[],"problem":"No material."}');
    expect(fails(await make(ref, "flashcards")).code).toBe("unusable-material");
    expect(requests).toHaveLength(2);
    expect(await setFiles(ref)).toEqual([]);
  });

  it("tells every kind how to say so", async () => {
    const ref = await material();
    answer = async () => MARKDOWN;
    value(await make(ref, "summary"));
    expect(requests[0]?.instructions).toContain("CANNOT_USE_MATERIAL:");
    answer = async () => CARDS;
    value(await make(ref, "flashcards"));
    expect(requests[1]?.instructions).toMatch(/into "problem"/);
    expect(JSON.stringify(requests[1]?.jsonSchema)).toContain('"problem"');
  });
});

describe("a summary that comes out too long", () => {
  /** A material of about 1,100 words; a short summary of it is asked to be about 180, at most 230. */
  async function longMaterial(): Promise<MaterialRef> {
    const ref = await material("Long", false);
    const page = textStream(Array.from({ length: 40 }, (_, line) => `Line ${line} says that cells divide and grow again.`));
    await addPdf(ref, "long.pdf", [page, page, page]);
    return ref;
  }
  const summaryOf = (words: number, tag: string): string => `Opening ${tag}.\n\n## Topic\n\n${Array.from({ length: words - 3 }, () => "word").join(" ")}`;
  const short = { options: { length: "short" } };

  it("is sent back once to be shortened, with the summary among the material, and the shorter one is saved", async () => {
    const ref = await longMaterial();
    answer = async (_request, call) => (call === 1 ? summaryOf(400, "first") : summaryOf(200, "second"));
    const outcome = value(await make(ref, "summary", short));
    expect(outcome.attempts).toBe(2);
    expect(outcome.warnings).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.instructions).toMatch(/Your first summary has 400 words\. The maximum is \d+, and about \d+ were asked for\./);
    // The first summary goes with the material, not into the instructions.
    expect(requests[1]?.instructions).not.toContain("Opening first");
    expect(requests[1]?.parts).toHaveLength(2);
    expect(requests[1]?.parts[0]).toEqual(requests[0]?.parts[0]);
    expect(JSON.stringify(requests[1]?.parts[1])).toMatch(/YOUR FIRST VERSION.*Opening first.*END OF YOUR FIRST VERSION/);
    expect(value(await service.read(ref, outcome.result.name)).set.content).toMatchObject({ length: "short", body: summaryOf(200, "second") });
    expect(progress.map((report) => report.message)).toContain("The summary came out too long. Asking Claude Code to shorten it…");
    expect(logged.at(-1)?.detail).toMatchObject({ firstWords: 400, words: 200, attempts: 2 });
  });

  it("keeps the first when the second is no shorter, and says the summary is long", async () => {
    const ref = await longMaterial();
    answer = async (_request, call) => (call === 1 ? summaryOf(400, "first") : summaryOf(450, "second"));
    const outcome = value(await make(ref, "summary", short));
    expect(value(await service.read(ref, outcome.result.name)).set.content).toMatchObject({ body: summaryOf(400, "first") });
    expect(outcome.warnings).toEqual([expect.stringMatching(/^This summary is longer than asked for: about 400 words, where about \d+ were asked for\.$/)]);
  });

  it("saves the shorter of the two even when it is still over, with the note", async () => {
    const ref = await longMaterial();
    answer = async (_request, call) => (call === 1 ? summaryOf(500, "first") : summaryOf(300, "second"));
    const outcome = value(await make(ref, "summary", short));
    expect(value(await service.read(ref, outcome.result.name)).set.content).toMatchObject({ body: summaryOf(300, "second") });
    expect(outcome.warnings).toHaveLength(1);
  });

  const seconds: [string, () => Promise<string>][] = [
    ["an empty answer", async () => "   "],
    ["a usage limit", () => Promise.reject(failure("usage-limit", "Claude Code"))],
    ["a refusal", async () => "CANNOT_USE_MATERIAL: I cannot shorten this."],
    ["a summary cut down to nothing", async () => "Too short now."],
  ];
  it.each(seconds)("loses nothing when the second attempt ends in %s: the first summary is saved", async (_name, second) => {
    const ref = await longMaterial();
    answer = (_request, call) => (call === 1 ? Promise.resolve(summaryOf(400, "first")) : second());
    const outcome = value(await make(ref, "summary", short));
    expect(requests).toHaveLength(2);
    expect(value(await service.read(ref, outcome.result.name)).set.content).toMatchObject({ body: summaryOf(400, "first") });
    expect(await setFiles(ref)).toEqual([outcome.result.name]);
  });

  it("can still be cancelled while it is being shortened, and then saves nothing", async () => {
    const ref = await longMaterial();
    answer = (request, call) => (call === 1 ? Promise.resolve(summaryOf(400, "first")) : untilAborted(request));
    const pending = make(ref, "summary", short);
    await expect.poll(() => requests.length).toBe(2);
    tasks.cancel(ID);
    expect(fails(await pending).code).toBe("cancelled");
    expect(await setFiles(ref)).toEqual([]);
  });

  it("is left alone when it is within a tenth of the limit, or the material's size gives no number", async () => {
    const ref = await longMaterial();
    answer = async () => summaryOf(245, "first");
    expect(value(await make(ref, "summary", short)).attempts).toBe(1);
    const small = await material();
    answer = async () => summaryOf(900, "first");
    expect(value(await make(small, "summary", short)).attempts).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it("does not ask a third time after a retry for an invalid answer", async () => {
    const ref = await longMaterial();
    answer = async (_request, call) => (call === 1 ? "  " : summaryOf(400, "second"));
    const outcome = value(await make(ref, "summary", short));
    expect(requests).toHaveLength(2);
    expect(outcome.warnings).toHaveLength(1);
  });
});

describe("the saved quiz", () => {
  it("has its correct options spread over the positions, each still the correct one", async () => {
    const ref = await material();
    const questions = Array.from({ length: 12 }, (_, index) => ({
      type: "multiple_choice",
      prompt: `Question ${index}?`,
      options: [`right ${index}`, `wrong ${index} a`, `wrong ${index} b`, `wrong ${index} c`],
      answerIndex: 0,
      modelAnswer: "",
      explanation: "Because.",
      points: 1,
    }));
    answer = async () => JSON.stringify({ questions, problem: "" });
    const outcome = value(await make(ref, "test"));
    const saved = value(await service.read(ref, outcome.result.name)).set;
    if (saved.kind !== "test") throw new Error("not a practice test");
    const positions = [0, 0, 0, 0];
    for (const [index, question] of saved.content.questions.entries()) {
      if (question.type !== "multiple_choice") throw new Error("not multiple choice");
      expect(question.options[question.answerIndex]).toBe(`right ${index}`);
      positions[question.answerIndex] = (positions[question.answerIndex] ?? 0) + 1;
    }
    expect(positions).toEqual([3, 3, 3, 3]);
    // The file itself, as a student would print it.
    const onDisk = JSON.parse(await readFile(path.join(setsDir(ref), outcome.result.name), "utf8")) as { content: { questions: { answerIndex: number }[] } };
    expect(new Set(onDisk.content.questions.map((question) => question.answerIndex)).size).toBe(4);
  });
});

describe("a material that goes away while something is made from it", () => {
  it("stops the generation for a delete of the material, its subject or a file, and waits for it", async () => {
    for (const target of ["material", "subject", "other"] as const) {
      const ref = await material(`Doomed ${target}`);
      answer = untilAborted;
      requests = [];
      const pending = make(ref, "flashcards");
      await expect.poll(() => requests.length).toBe(1);

      expect(service.isMakingFrom(ref)).toBe(true);
      expect(service.isMakingFrom({ subject: "biology" })).toBe(true);
      expect(service.isMakingFrom({ subject: "Biology", material: "Another" })).toBe(false);
      expect(service.isMakingFrom({ subject: "Physics" })).toBe(false);
      expect(service.isMakingFrom(null)).toBe(false);

      if (target === "other") {
        // Something else is deleted: this generation is none of its business.
        expect(await service.cancelFor({ subject: "Biology", material: "Another" })).toBe(false);
        expect(requests[0]?.signal.aborted).toBe(false);
        tasks.cancel(ID);
      } else {
        expect(await service.cancelFor(target === "material" ? ref : { subject: "Biology" })).toBe(true);
        // By now it has really ended: nothing is running and nothing will be written.
        expect(service.current()).toBeNull();
        expect(tasks.size).toBe(0);
      }
      expect(fails(await pending).code).toBe("cancelled");
      expect(await setFiles(ref)).toEqual([]);
      expect(await service.cancelFor(ref)).toBe(false);
    }
  });

  it("fails with the plain sentence when the folder is gone at the end, and writes nothing", async () => {
    const ref = await material("Vanishing");
    answer = async () => {
      await rm(path.join(root, ref.subject, ref.material), { recursive: true });
      return CARDS;
    };
    const error = fails(await make(ref, "flashcards"));
    expect(error.code).toBe("not-found");
    expect(error.message).toMatch(/That material is no longer there/);
    expect(existsSync(path.join(root, ref.subject, ref.material))).toBe(false);
  });

  it("does not write into a folder that was made again under the same name", async () => {
    const ref = await material("Reborn");
    answer = async () => {
      // Deleted in the file manager and created anew while the AI was working.
      await rm(path.join(root, ref.subject, ref.material), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const again = await library.createMaterial("Biology", "Reborn");
      if (!again.ok) throw new Error(again.error.message);
      return CARDS;
    };
    const error = fails(await make(ref, "flashcards"));
    expect(error.code).toBe("not-found");
    expect(await setFiles(ref)).toEqual([]);
  });
});

describe("read, learn, test: the kinds a student makes now", () => {
  const mc = (index: number) => ({
    type: "multiple_choice",
    prompt: `Question ${index}?`,
    options: [`right ${index}`, `wrong ${index} a`, `wrong ${index} b`, `wrong ${index} c`],
    answerIndex: 0,
    modelAnswer: "",
    explanation: "Because.",
    points: 1,
  });
  const written = { type: "written", prompt: "Explain mitosis.", options: [], answerIndex: -1, modelAnswer: "A full answer.", explanation: "One point each.", points: 3 };

  it("makes a practice test of the asked length, with or without written questions, and remembers both", async () => {
    const ref = await material();
    answer = async () => JSON.stringify({ questions: [mc(1), mc(2), written], problem: "" });

    const standard = value(await make(ref, "test"));
    expect(standard.result).toMatchObject({ name: "2026-10-02-test.json", kind: "test", title: "Practice test: Cell division", itemCount: 3, testLength: "standard", written: true, length: null });
    expect(requests[0]?.instructions).toMatch(/Write 20 questions/);
    expect(requests[0]?.instructions).toMatch(/About one question in four is a written one \(about 5 here\)/);

    clock = new Date(2026, 9, 2, 14, 31);
    const full = value(await make(ref, "test", { options: { testLength: "full", written: true } }));
    expect(full.result).toMatchObject({ testLength: "full", written: true });
    expect(requests[1]?.instructions).toMatch(/Write 30 questions/);
    expect(requests[1]?.instructions).toMatch(/full practice exam/);
    expect(requests[1]?.instructions).toMatch(/2 to 10 points/);

    clock = new Date(2026, 9, 2, 14, 32);
    answer = async () => JSON.stringify({ questions: [mc(1), mc(2)], problem: "" });
    const quick = value(await make(ref, "test", { options: { testLength: "quick", written: false } }));
    expect(quick.result).toMatchObject({ name: "2026-10-02-test-3.json", testLength: "quick", written: false, itemCount: 2 });
    expect(requests[2]?.instructions).toMatch(/Write 10 questions/);
    expect(requests[2]?.instructions).toMatch(/Every question is multiple choice: there are no written questions at all\./);

    // What was asked for is in the file, and comes back when it is read and listed.
    const opened = value(await service.read(ref, quick.result.name)).set;
    expect(opened.kind === "test" && { length: opened.content.length, written: opened.content.written }).toEqual({ length: "quick", written: false });
    const onDisk = JSON.parse(await readFile(path.join(setsDir(ref), quick.result.name), "utf8")) as { content: Record<string, unknown> };
    expect(onDisk.content).toMatchObject({ length: "quick", written: false });
    expect(value(await service.list(ref)).map((row) => [row.name, row.testLength, row.written])).toEqual([
      ["2026-10-02-test-3.json", "quick", false],
      ["2026-10-02-test-2.json", "full", true],
      ["2026-10-02-test.json", "standard", true],
    ]);
  });

  it("takes written questions out of a test that was asked for as multiple choice only", async () => {
    const ref = await material();
    answer = async () => JSON.stringify({ questions: [mc(1), written, mc(2), written], problem: "" });
    const outcome = value(await make(ref, "test", { options: { written: false } }));
    expect(outcome.result).toMatchObject({ itemCount: 2, written: false });
    expect(outcome.warnings).toEqual(["2 written questions were left out: this test was asked for as multiple choice only."]);

    clock = new Date(2026, 9, 2, 14, 31);
    answer = async () => JSON.stringify({ questions: [written], problem: "" });
    const error = fails(await make(ref, "test", { options: { written: false } }));
    expect(error.code).toBe("invalid-result");
    expect(await setFiles(ref)).toEqual(["2026-10-02-test.json"]);
  });

  it("refuses a test length or a written flag that is not one", async () => {
    const ref = await material();
    expect(fails(await make(ref, "test", { options: { testLength: "huge" } })).code).toBe("invalid-request");
    expect(fails(await make(ref, "test", { options: { written: "yes" } })).code).toBe("invalid-request");
    expect(requests).toHaveLength(0);
  });

  it("still lists, opens, renames and deletes a quiz and a mock exam of an earlier version", async () => {
    const ref = await material();
    const old = (kind: string) =>
      JSON.stringify({ schemaVersion: 1, kind, title: `Old ${kind}`, created: "2026-09-30T10:00:00.000Z", provider: "claude-code", model: "sonnet", coverage: "whole", content: { questions: [mc(1), written] } });
    await writeFile(path.join(setsDir(ref), "2026-09-30-quiz.json"), old("quiz"));
    await writeFile(path.join(setsDir(ref), "2026-09-30-exam.json"), old("exam"));

    const rows = value(await service.list(ref));
    expect(rows.map((row) => [row.kind, row.title, row.itemCount, row.testLength, row.written])).toEqual([
      ["exam", "Old exam", 2, null, true],
      ["quiz", "Old quiz", 2, null, true],
    ]);
    expect(value(await service.read(ref, "2026-09-30-quiz.json")).set.kind).toBe("quiz");
    expect(value(await service.rename(ref, "2026-09-30-exam.json", "My mock exam")).title).toBe("My mock exam");
    expect(value(await service.remove(ref, "2026-09-30-quiz.json"))).toBeNull();
    expect(value(await service.list(ref)).map((row) => row.name)).toEqual(["2026-09-30-exam.json"]);
  });

  it("gives an explanation and a cheat sheet a length from the material and counts it", async () => {
    const ref = await material("Long", false);
    const page = textStream(Array.from({ length: 40 }, (_, line) => `Line ${line} says that cells divide and grow again.`));
    await addPdf(ref, "long.pdf", [page, page, page]);
    const doc = (words: number, tag: string): string => `## ${tag}\n\n${Array.from({ length: words - 1 }, () => "word").join(" ")}`;

    // About 1,100 words of material: an explanation of about 440, at most 570.
    answer = async (_request, call) => (call === 1 ? doc(900, "first") : doc(450, "second"));
    const explained = value(await make(ref, "explain"));
    expect(explained.result).toMatchObject({ name: "2026-10-02-explain.md", kind: "explain", title: "Explanation: Long", itemCount: null });
    expect(explained.attempts).toBe(2);
    expect(requests[0]?.instructions).toMatch(/in at most 5[5-9]0 words/);
    expect(requests[0]?.instructions).toMatch(/questions to check understanding/);
    expect(requests[1]?.instructions).toMatch(/Your first explanation has 900 words/);
    expect(progress.map((report) => report.message)).toContain("The explanation came out too long. Asking Claude Code to shorten it…");
    expect(value(await service.read(ref, explained.result.name)).set.content).toEqual({ body: doc(450, "second") });

    // A cheat sheet is one page whatever the material: about 170 words here, never over 500.
    requests = [];
    answer = async (_request, call) => (call === 1 ? doc(700, "first") : doc(180, "second"));
    const sheet = value(await make(ref, "cheatsheet"));
    expect(sheet.result).toMatchObject({ name: "2026-10-02-cheatsheet.md", kind: "cheatsheet", title: "Cheat sheet: Long" });
    expect(sheet.attempts).toBe(2);
    expect(requests[0]?.instructions).toMatch(/Leave a section out rather than invent one/);
    expect(requests[1]?.instructions).toMatch(/Your first cheat sheet has 700 words\. The maximum is 2\d0/);
    expect(value(await service.read(ref, sheet.result.name)).set.content).toEqual({ body: doc(180, "second") });

    // The saved file says what it is, and nothing about a length it does not have.
    const text = await readFile(path.join(setsDir(ref), sheet.result.name), "utf8");
    expect(text).toMatch(/^---\ntitle: "Cheat sheet: Long"\nkind: cheatsheet\n/);
    expect(text).not.toMatch(/\nlength:|\nrequest:/);
  });

  it("keeps a summary's asked length when the shortened one is saved", async () => {
    const ref = await material("Long", false);
    const page = textStream(Array.from({ length: 40 }, (_, line) => `Line ${line} says that cells divide and grow again.`));
    await addPdf(ref, "long.pdf", [page, page, page]);
    answer = async (_request, call) => `Opening.\n\n## Topic\n\n${Array.from({ length: call === 1 ? 400 : 200 }, () => "word").join(" ")}`;
    const outcome = value(await make(ref, "summary", { options: { length: "short" } }));
    expect(outcome.result.length).toBe("short");
  });
});

describe("a PDF that was made from the material's own photos", () => {
  it("is not sent while the photos are there, and says nothing about it", async () => {
    const ref = await material();
    await library.addPhotoSet(ref, [REAL_JPEG, REAL_JPEG]);
    const made = await library.photoSetToPdf(ref, "notes-2026-10-02");
    if (!made.ok) throw new Error(made.error.message);

    const outcome = value(await make(ref, "flashcards"));
    expect(outcome.notices).toEqual([]);
    expect(outcome.result.coverage).toBe("whole");
    const parts = requests[0]?.parts ?? [];
    // The text of the chapter and the two photos: no PDF of the photos on top.
    expect(parts.map((part) => part.type)).toEqual(["text", "image", "image"]);
    expect(logged.at(-1)?.detail).toMatchObject({ images: 2, scannedPdfs: 0, notices: 0 });
  });

  it("is sent as the scan it is once the photos are gone", async () => {
    const ref = await material("Photos only", false);
    await library.addPhotoSet(ref, [REAL_JPEG, REAL_JPEG]);
    const made = await library.photoSetToPdf(ref, "notes-2026-10-02");
    if (!made.ok) throw new Error(made.error.message);
    await library.removeFile(ref, "notes-2026-10-02");

    value(await make(ref, "flashcards"));
    expect(requests[0]?.parts).toEqual([{ type: "file", path: path.join(root, "Biology", "Photos only", "files", "notes-2026-10-02.pdf") }]);
  });
});

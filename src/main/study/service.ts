/**
 * Making results and keeping them: the `study` namespace of the bridge.
 *
 * ## Making one
 *
 *   reading the files → asking the AI → checking the answer → (one more try) → saving
 *
 * - The material is found through the library's path check and turned into bounded parts
 *   (`material.ts`). A material with nothing to send fails here, before any AI is asked.
 * - The answer is parsed and validated (`@shared/study`). An answer that fails — or a provider
 *   that reports `bad-output` — gets exactly one more request, with the errors appended to the
 *   instructions. A second failure is reported and nothing is saved.
 * - The file is written under a temporary name and renamed, by the library, so `sets/` never
 *   holds a half-written or an invalid result.
 * - Every stage looks at the cancel signal. The provider is handed the signal too, so a cancel
 *   while the AI is working kills its process.
 * - One at a time in the whole app. A student sees one progress line and one Cancel button, and
 *   their AI's usage limit is not spent twice as fast by an impatient second click.
 *
 * ## Logging
 *
 * Counts, durations and codes only. Never the instructions, the material or an answer.
 *
 * Every argument is checked here: types are erased over IPC, so what arrives is `unknown`.
 * No Electron import, so it runs in tests; `src/main/ipc/study.ts` supplies the real parts.
 */
import type { LibraryResult, MaterialRef } from "@shared/library";
import { isModelId, isProviderId } from "@shared/providers";
import type { ProviderId } from "@shared/providers";
import type {
  GenerateOutcome,
  MakeOptions,
  OpenedStudySet,
  StudyActivity,
  StudyError,
  StudyErrorCode,
  StudyResult,
  StudySetSummary,
} from "@shared/results";
import {
  buildGenerationRequest,
  buildRetryMessage,
  buildShortenMessage,
  countMarkdownWords,
  hasWrittenQuestions,
  TEST_LENGTHS,
  wordBudgetFor,
  FIRST_SUMMARY_END,
  FIRST_SUMMARY_START,
  readRefusal,
  cleanText,
  countStudySetItems,
  createStudySet,
  defaultStudySetTitle,
  isMakeableKind,
  listStudySetFiles,
  MAX_RAW_CHARS,
  MAX_REQUEST,
  MAX_TITLE,
  parseGenerationOutput,
  parseStudySetFile,
  resolveGenerationOptions,
  serialiseStudySet,
  STUDY_SET_KIND_LABELS,
  studySetFileName,
  SUMMARY_LENGTHS,
} from "@shared/study";
import type { StudySet, StudySetContent, StudySetFileInfo, StudySetKind, Validation } from "@shared/study";
import { isRequestId } from "@shared/tasks";
import type { TaskProgress } from "@shared/tasks";
import { LibraryFailure } from "../library/errors";
import type { LibraryLookup, SetFileInfo } from "../library/library";
import { consoleLog, ProviderFailure, sentenceFor } from "../providers";
import type { Part, Provider, ProviderLog, ProviderRegistry } from "../providers";
import type { SettingsStore } from "../settings";
import type { TaskRegistry } from "../tasks";
import { nothingReadableSentence, prepareMaterial } from "./material";
import { NotRetitleable, retitleStudySetText } from "./retitle";
import { spreadAnswers } from "./shuffle";

/** A result file larger than this is not opened. 2,000,000 characters are at most 8 MB of UTF-8. */
export const MAX_SET_FILE_BYTES = MAX_RAW_CHARS * 4;

/** How often the progress line is refreshed with the time so far while the AI is working. */
export const PROGRESS_TICK_MS = 10_000;

/** Room for the retry message, the material rules every provider adds, and the markers. */
const RETRY_AND_RULES_CHARS = 5_000;

/** A summary this much over its limit gets the one corrective request. */
const TOO_LONG_FACTOR = 1.1;
/** A "shortened" summary under this share of the target lost its substance: the first one is kept. */
const TOO_SHORT_SHARE = 0.4;

const CANCELLED = "Cancelled. Nothing was saved.";
const BAD_REQUEST: StudyError = { code: "invalid-request", message: sentenceFor("invalid-request", "") };
const ALREADY_GENERATING: StudyError = {
  code: "already-generating",
  message: "Studiplan is already making something. Wait until it is finished, or cancel it, then try again.",
};
const NO_PROVIDER =
  'No AI is connected yet. Open Settings, choose your AI under "Connect your AI", then try again.';
const BAD_MODEL = "That is not a usable model name. Use letters, numbers and . _ : / - only, without spaces.";
const UNOPENABLE =
  "This result cannot be opened. Its file was changed outside Studiplan and is no longer in the form the app saves. Fix the file, or delete the result and make it again.";

/** A failure the student can be told about. Thrown inside this module, never out of it. */
class StudyFailure extends Error {
  readonly code: StudyErrorCode;
  readonly details: string[] | undefined;

  constructor(code: StudyErrorCode, message: string, details?: string[]) {
    super(message);
    this.name = "StudyFailure";
    this.code = code;
    this.details = details !== undefined && details.length > 0 ? details : undefined;
  }
}

function unwrap<T>(result: LibraryResult<T>): T {
  if (!result.ok) throw new StudyFailure(result.error.code, result.error.message);
  return result.value;
}

export type StudyLibrary = Pick<
  LibraryLookup,
  "locateMaterial" | "listSetFiles" | "readSetFile" | "saveSetFile" | "rewriteSetFile" | "deleteSetFile"
>;

export interface StudyServiceDeps {
  library: StudyLibrary;
  registry: ProviderRegistry;
  settings: SettingsStore;
  tasks: TaskRegistry;
  /** Sends a progress event to the window. */
  progress?: (progress: TaskProgress) => void;
  log?: ProviderLog;
  now?: () => Date;
  /** Replaced in tests. */
  prepare?: typeof prepareMaterial;
  tickMs?: number;
}

export interface StudyService {
  generate(ref: unknown, request: unknown): Promise<StudyResult<GenerateOutcome>>;
  current(): StudyActivity | null;
  list(ref: unknown): Promise<StudyResult<StudySetSummary[]>>;
  read(ref: unknown, name: unknown): Promise<StudyResult<OpenedStudySet>>;
  rename(ref: unknown, name: unknown, title: unknown): Promise<StudyResult<StudySetSummary>>;
  remove(ref: unknown, name: unknown): Promise<StudyResult<null>>;
  /**
   * Whether something is being made from this material right now — or, with only a subject,
   * from any material of that subject. Not on the bridge: for the main process's own calls.
   */
  isMakingFrom(target: unknown): boolean;
  /**
   * Stops what is being made from this material (or subject), and resolves once it has really
   * stopped: nothing of it will touch the folder afterwards. False when nothing was. For the
   * calls that delete a material, a subject or a file.
   */
  cancelFor(target: unknown): Promise<boolean>;
}

/** "40 seconds", "1 minute", "2 minutes 10 seconds". */
export function elapsedWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const words: string[] = [];
  if (minutes > 0) words.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds > 0 || minutes === 0) words.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return words.join(" ");
}

/** What the budgeted Markdown kinds are called in a progress line and a note. */
const RESULT_NOUNS: Readonly<Partial<Record<StudySetKind, string>>> = {
  summary: "summary",
  explain: "explanation",
  cheatsheet: "cheat sheet",
};

/** What to ask for instead, in the sentence after two unusable answers. */
const SMALLER: Readonly<Record<StudySetKind, string>> = {
  summary: "ask for a shorter summary",
  explain: "try with less material",
  cheatsheet: "try with less material",
  flashcards: "ask for fewer cards",
  test: "ask for a shorter test",
  quiz: "ask for fewer questions",
  exam: "ask for fewer questions",
  custom: "ask for something smaller",
};

/** The options a Make button sent, as far as they are of the right type. Anything else is a bug in the page. */
function readOptions(raw: unknown): MakeOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);
  const { count, length, testLength, written, request, language } = raw as Record<string, unknown>;
  const bad = (): never => {
    throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);
  };
  const options: MakeOptions = {};
  if (count !== undefined && count !== null) {
    if (typeof count !== "number" || !Number.isFinite(count)) bad();
    options.count = count as number;
  }
  if (length !== undefined && length !== null) {
    if (!(SUMMARY_LENGTHS as readonly unknown[]).includes(length)) bad();
    options.length = length as (typeof SUMMARY_LENGTHS)[number];
  }
  if (testLength !== undefined && testLength !== null) {
    if (!(TEST_LENGTHS as readonly unknown[]).includes(testLength)) bad();
    options.testLength = testLength as (typeof TEST_LENGTHS)[number];
  }
  if (written !== undefined && written !== null) {
    if (typeof written !== "boolean") bad();
    options.written = written as boolean;
  }
  if (request !== undefined && request !== null) {
    // Its real limit, with its own sentence, is checked by `resolveGenerationOptions`.
    if (typeof request !== "string" || request.length > MAX_REQUEST * 4) bad();
    options.request = request as string;
  }
  if (language !== undefined && language !== null) {
    if (typeof language !== "string" || language.length > 200) bad();
    options.language = language as string;
  }
  return options;
}

function isRefShaped(ref: unknown): ref is MaterialRef {
  if (typeof ref !== "object" || ref === null) return false;
  const { subject, material } = ref as Record<string, unknown>;
  return typeof subject === "string" && typeof material === "string";
}

/** Local midnight of the date in a result's file name, for a file that cannot say when it was made. */
function createdFromName(info: StudySetFileInfo): string {
  const [year = 1970, month = 1, day = 1] = info.date.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

export function createStudyService(deps: StudyServiceDeps): StudyService {
  const { library, registry, settings, tasks } = deps;
  const log = deps.log ?? consoleLog;
  const progress = deps.progress ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const prepare = deps.prepare ?? prepareMaterial;
  const tickMs = deps.tickMs ?? PROGRESS_TICK_MS;

  /** Nothing thrown crosses the bridge; the sentence survives it. */
  async function toStudyResult<T>(operation: () => Promise<T>): Promise<StudyResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      if (error instanceof StudyFailure) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        };
      }
      if (error instanceof ProviderFailure || error instanceof LibraryFailure) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      log("study: unexpected error", { name: error instanceof Error ? error.name : typeof error });
      return { ok: false, error: { code: "failed", message: "Something went wrong. Nothing was saved. Try again." } };
    }
  }

  // ── Results on disk ────────────────────────────────────────────────────────────────────

  function providerLabel(id: string | null): string | null {
    if (id === null) return null;
    return isProviderId(id) ? (registry.get(id)?.label ?? id) : id;
  }

  function summaryOfSet(name: string, set: StudySet): StudySetSummary {
    return {
      name,
      kind: set.kind,
      title: set.title,
      created: set.created,
      itemCount: countStudySetItems(set.content),
      provider: set.provider,
      providerLabel: providerLabel(set.provider),
      model: set.model,
      coverage: set.coverage,
      length: set.kind === "summary" ? set.content.length : null,
      testLength: set.kind === "test" ? set.content.length : null,
      written: "questions" in set.content ? hasWrittenQuestions(set.content) : null,
      problem: null,
    };
  }

  /** The sentence for a file that does not open, and what is wrong in it. */
  function unopenable(errors: readonly string[]): { message: string; details: string[] } {
    const first = errors[0] ?? "";
    // A file from a newer version is not damaged: say what to do instead.
    if (errors.length === 1 && /newer version|too large/.test(first)) return { message: first, details: [] };
    return { message: UNOPENABLE, details: errors.slice(0, 5) };
  }

  function summaryOf(info: StudySetFileInfo, parsed: Validation<StudySet>): StudySetSummary {
    if (parsed.ok) return summaryOfSet(info.fileName, parsed.value);
    return {
      name: info.fileName,
      kind: info.kind,
      title: STUDY_SET_KIND_LABELS[info.kind],
      created: createdFromName(info),
      itemCount: null,
      provider: null,
      providerLabel: null,
      model: null,
      coverage: "unknown",
      length: null,
      testLength: null,
      written: null,
      problem: unopenable(parsed.errors).message,
    };
  }

  // A row of the Results list is remembered until its file changes, so listing a material
  // again reads only what is new. Insertion order is age.
  const rows = new Map<string, StudySetSummary>();
  const MAX_ROWS = 2_000;

  function rowKey(ref: MaterialRef, file: SetFileInfo): string {
    return [ref.subject, ref.material, file.name, file.size, file.mtimeMs].join("\0");
  }

  function remember(key: string, row: StudySetSummary): void {
    rows.set(key, row);
    for (const oldest of rows.keys()) {
      if (rows.size <= MAX_ROWS) break;
      rows.delete(oldest);
    }
  }

  async function list(ref: unknown): Promise<StudySetSummary[]> {
    const files = unwrap(await library.listSetFiles(ref));
    const byName = new Map(files.map((file) => [file.name, file]));
    const found: StudySetSummary[] = [];
    // `listStudySetFiles` puts them newest first by the date and number in the name.
    for (const info of listStudySetFiles(byName.keys())) {
      const file = byName.get(info.fileName);
      if (file === undefined) continue;
      const key = rowKey(ref as MaterialRef, file);
      const known = rows.get(key);
      if (known !== undefined) {
        // The provider's name may be known now where it was not before.
        found.push({ ...known, providerLabel: providerLabel(known.provider) });
        continue;
      }
      let row: StudySetSummary;
      if (file.size > MAX_SET_FILE_BYTES) {
        row = summaryOf(info, { ok: false, errors: ["The file is too large to open."] });
      } else {
        const text = await library.readSetFile(ref, file.name, MAX_SET_FILE_BYTES);
        // Gone or unreadable since it was listed: leave it out rather than fail the whole list.
        if (!text.ok) continue;
        row = summaryOf(info, parseStudySetFile(file.name, text.value.text));
      }
      remember(key, row);
      found.push(row);
    }
    // Within a day the name only orders results of one kind; the time inside the file orders
    // them all. The sort is stable, so files without a time keep their order by name.
    return found.sort((a, b) => (a.created === b.created ? 0 : a.created < b.created ? 1 : -1));
  }

  async function read(ref: unknown, name: unknown): Promise<OpenedStudySet> {
    const file = unwrap(await library.readSetFile(ref, name, MAX_SET_FILE_BYTES));
    const parsed = parseStudySetFile(file.name, file.text);
    if (!parsed.ok) {
      const { message, details } = unopenable(parsed.errors);
      throw new StudyFailure("unreadable-result", message, details);
    }
    return { name: file.name, set: parsed.value, warnings: parsed.warnings };
  }

  async function rename(ref: unknown, name: unknown, titleInput: unknown): Promise<StudySetSummary> {
    if (typeof titleInput !== "string") throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);
    const title = cleanText(titleInput).replace(/\s+/g, " ").trim();
    if (title === "") throw new StudyFailure("invalid-name", "Type a title for the result.");
    if (title.length > MAX_TITLE) {
      throw new StudyFailure("invalid-name", `That title is too long. Use ${MAX_TITLE} characters or fewer.`);
    }

    let renamed: StudySet | null = null;
    let problem: StudyFailure | null = null;
    const written = await library.rewriteSetFile(
      ref,
      name,
      (text) => {
        // Only a file that opens is changed, and only if it still opens afterwards with the
        // new title. Anything else is left exactly as it is.
        const before = parseStudySetFile(name as string, text);
        if (!before.ok) {
          const { message, details } = unopenable(before.errors);
          problem = new StudyFailure("unreadable-result", message, details);
          throw new LibraryFailure("invalid-request", message);
        }
        let next: string;
        try {
          next = retitleStudySetText(name as string, text, title);
        } catch (error) {
          if (!(error instanceof NotRetitleable)) throw error;
          problem = new StudyFailure("unreadable-result", UNOPENABLE);
          throw new LibraryFailure("invalid-request", UNOPENABLE);
        }
        const after = parseStudySetFile(name as string, next);
        if (!after.ok || after.value.title !== title) {
          problem = new StudyFailure("failed", "The title could not be changed. The result was left as it was.");
          throw new LibraryFailure("invalid-request", problem.message);
        }
        renamed = after.value;
        return next;
      },
      MAX_SET_FILE_BYTES,
    );
    if (problem !== null) throw problem as StudyFailure;
    unwrap(written);
    if (renamed === null) throw new StudyFailure("failed", "The title could not be changed. Try again.");
    return summaryOfSet(name as string, renamed);
  }

  async function remove(ref: unknown, name: unknown): Promise<null> {
    return unwrap(await library.deleteSetFile(ref, name));
  }

  // ── Making a result ────────────────────────────────────────────────────────────────────

  let active: StudyActivity | null = null;
  /** The call that `active` belongs to. */
  let running: Promise<unknown> | null = null;

  /** The AI and the model for one request: what the page asked for, else what Settings says. */
  async function chooseProvider(asked: unknown, askedModel: unknown): Promise<{ provider: Provider; model: string | undefined }> {
    const stored = await settings.read();
    let id: ProviderId | undefined;
    if (asked === undefined || asked === null) id = stored.defaultProvider;
    else if (isProviderId(asked)) id = asked;
    else throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);

    // No choice yet, or a choice this version does not have (a settings file from a newer one).
    const provider = id === undefined ? undefined : registry.get(id);
    if (provider === undefined) {
      if (asked === undefined || asked === null) throw new StudyFailure("no-provider", NO_PROVIDER);
      registry.require(id as ProviderId); // throws its own sentence
      throw new StudyFailure("no-provider", NO_PROVIDER);
    }

    let model: string | undefined;
    if (askedModel === undefined || askedModel === null) model = stored.models?.[provider.id];
    else if (typeof askedModel !== "string") throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);
    else {
      model = askedModel.trim();
      if (!isModelId(model)) throw new StudyFailure("model-unavailable", BAD_MODEL);
    }
    return { provider, model };
  }

  async function make(
    ref: unknown,
    kind: StudySetKind,
    raw: Record<string, unknown>,
    signal: AbortSignal,
    activity: StudyActivity,
  ): Promise<GenerateOutcome> {
    const started = Date.now();
    const report = (message: string): void => {
      activity.message = message;
      progress({ requestId: activity.requestId, message, fraction: null });
    };
    const stopIfCancelled = (): void => {
      if (signal.aborted) throw new StudyFailure("cancelled", CANCELLED);
    };
    const stats: Record<string, unknown> = { kind };

    try {
      // What was asked for. The only thing a student can get wrong here is an empty text box.
      const options = readOptions(raw["options"]);
      const resolved = resolveGenerationOptions(kind, options);
      if (!resolved.ok) {
        throw new StudyFailure("empty-request", resolved.errors[0] ?? "Write what you want made from this material first.");
      }

      const { provider, model } = await chooseProvider(raw["provider"], raw["model"]);
      stats["provider"] = provider.id;
      stopIfCancelled();

      // Reading the files.
      report("Reading the files…");
      const material = unwrap(await library.locateMaterial(ref));
      // What the request carries besides the material, measured on its longest form (a cut
      // material, plus the one retry), so a provider with a small context can leave room for it.
      const longest = buildGenerationRequest(kind, { ...options, coverage: "cut", materialWords: 100_000 });
      const instructionChars = longest.ok
        ? longest.value.instructions.length +
          (longest.value.jsonSchema === null ? 0 : JSON.stringify(longest.value.jsonSchema).length) +
          RETRY_AND_RULES_CHARS
        : 0;
      const prepared = await prepare(material, provider, {
        signal,
        instructionChars,
        ...(model === undefined ? {} : { model }),
      });
      stopIfCancelled();
      Object.assign(stats, prepared.counts);
      if (prepared.parts.length === 0) {
        throw new StudyFailure(
          "nothing-readable",
          nothingReadableSentence(material.files.length),
          prepared.notices.slice(0, 8),
        );
      }

      const coverage = prepared.complete ? "whole" : "cut";
      const built = buildGenerationRequest(kind, { ...options, coverage, materialWords: prepared.words });
      if (!built.ok) throw new StudyFailure("empty-request", built.errors[0] ?? "");
      const request = built.value;
      const instructions =
        prepared.delivery === null ? request.instructions : `${request.instructions}\n\n${prepared.delivery}`;

      /** One request. An answer in the wrong form comes back as errors; anything else is thrown. */
      const ask = async (text: string, line: string, extra: Part[] = []): Promise<Validation<StudySetContent>> => {
        const askedAt = Date.now();
        report(line);
        const ticker = setInterval(() => {
          const waited = Date.now() - askedAt;
          report(
            `${line} ${elapsedWords(waited)} so far.` +
              (waited >= 60_000 ? " A long material or a big request can take a few minutes." : ""),
          );
        }, tickMs);
        let reply: string;
        try {
          reply = await provider.generate({
            instructions: text,
            parts: extra.length === 0 ? prepared.parts : [...prepared.parts, ...extra],
            signal,
            ...(request.jsonSchema === null ? {} : { jsonSchema: request.jsonSchema }),
            ...(prepared.workingDirectory === undefined ? {} : { workingDirectory: prepared.workingDirectory }),
            ...(model === undefined ? {} : { model }),
          });
        } catch (error) {
          stopIfCancelled();
          // The tool answered, but not in the expected form: the same as a failed check.
          if (error instanceof ProviderFailure && error.code === "bad-output") {
            return {
              ok: false,
              errors: [
                request.format === "json"
                  ? "The reply was not one JSON object in the required shape."
                  : "The reply was empty or was not a Markdown document.",
              ],
            };
          }
          throw error;
        } finally {
          clearInterval(ticker);
        }
        stopIfCancelled();
        report("Checking the answer…");
        // "I could not read the material" is not a result and not worth asking again: it is
        // never saved, however well it is written.
        const refusal = readRefusal(kind, reply);
        if (refusal !== null) {
          stats["refused"] = true;
          throw new StudyFailure(
            "unusable-material",
            `${provider.label} could not make this from the material, so nothing was saved. Check that the files open and can be read; for a scan, add photos of the pages instead. Then try again.`,
            // The model's own words, marked as such. Never the app's sentence.
            refusal.reason === "" ? undefined : [`${provider.label} said: “${refusal.reason}”`],
          );
        }
        return parseGenerationOutput(kind, reply, request.options);
      };

      let attempts: 1 | 2 = 1;
      let content = await ask(instructions, `Asking ${provider.label}…`);
      if (!content.ok) {
        // The one retry. The first reply is not quoted back: for a command-line tool the
        // instructions travel as an argument, which must stay short and free of material, and
        // the model writes the whole result again either way.
        attempts = 2;
        stats["firstErrors"] = content.errors.length;
        const again = buildRetryMessage({ kind, errors: content.errors });
        content = await ask(
          `${instructions}\n\n${again}`,
          `The first answer could not be used. Asking ${provider.label} once more…`,
        );
      }
      stats["attempts"] = attempts;
      if (!content.ok) {
        stats["secondErrors"] = content.errors.length;
        throw new StudyFailure(
          "invalid-result",
          `${provider.label} answered twice, but not in a form Studiplan can save, so nothing was saved. ` +
            `Try again. If it keeps happening, ${SMALLER[kind]} or pick another model in Settings.`,
        );
      }

      const warnings = [...content.warnings];
      let value: StudySetContent = content.value;

      // A practice test asked for as multiple choice only is exactly that: a written question
      // the model added anyway is taken out rather than left for the student to stumble on.
      if (kind === "test" && request.options.written === false && "questions" in value) {
        const kept = value.questions.filter((question) => question.type === "multiple_choice");
        if (kept.length === 0) {
          throw new StudyFailure(
            "invalid-result",
            `${provider.label} wrote only written questions where multiple choice was asked for, so nothing was saved. Try again.`,
          );
        }
        if (kept.length < value.questions.length) {
          warnings.push(
            `${value.questions.length - kept.length} written ${value.questions.length - kept.length === 1 ? "question was" : "questions were"} left out: this test was asked for as multiple choice only.`,
          );
          value = { ...value, questions: kept };
        }
      }

      // A summary, explanation or cheat sheet far over its length gets one corrective request,
      // with the text itself to shorten. Nothing is lost by it: whatever happens, the first
      // version is there to save.
      const noun = RESULT_NOUNS[kind] ?? "result";
      const budget = wordBudgetFor(kind, request.options);
      if (budget !== null && "body" in value) {
        const first = value;
        let words = countMarkdownWords(first.body);
        stats["words"] = words;
        if (words > budget.limit * TOO_LONG_FACTOR && attempts === 1) {
          attempts = 2;
          stats["firstWords"] = words;
          try {
            const shorter = await ask(
              `${instructions}\n\n${buildShortenMessage({ words, budget, kind })}`,
              `The ${noun} came out too long. Asking ${provider.label} to shorten it…`,
              [{ type: "text", text: `${FIRST_SUMMARY_START}\n${first.body}\n${FIRST_SUMMARY_END}` }],
            );
            if (shorter.ok && "body" in shorter.value) {
              const shorterWords = countMarkdownWords(shorter.value.body);
              if (shorterWords < words && shorterWords >= budget.target * TOO_SHORT_SHARE) {
                // What was asked for (a summary's length) stays with the text that is saved.
                value = { ...first, body: shorter.value.body };
                words = shorterWords;
                warnings.push(...shorter.warnings);
              }
            }
          } catch (error) {
            // A cancel is a cancel. Anything else: the first summary is still a good one.
            stopIfCancelled();
            stats["shortenFailed"] =
              error instanceof StudyFailure || error instanceof ProviderFailure ? error.code : "unexpected";
          }
          stats["words"] = words;
          stats["attempts"] = attempts;
        }
        if (words > budget.limit * TOO_LONG_FACTOR) {
          warnings.push(
            `This ${noun} is longer than asked for: about ${words.toLocaleString("en-US")} words, where about ${budget.target.toLocaleString("en-US")} were asked for.`,
          );
        }
      }

      // Saving. The text is read back the way an opened file is before it is written: what
      // lands in `sets/` is always something the app can open.
      report("Saving…");
      stopIfCancelled();
      const created = now();
      // The correct options of a quiz or exam are put in fair places; see `shuffle.ts`.
      if ("questions" in value) value = { ...value, ...spreadAnswers(value, `${created.toISOString()} ${material.id}`) };
      const set = createStudySet({
        kind,
        content: value as never,
        title: defaultStudySetTitle(kind, material.title, request.options.request),
        created,
        provider: provider.id,
        model: model ?? null,
        coverage,
      });
      const text = serialiseStudySet(set);
      const readBack = parseStudySetFile(studySetFileName(kind, created), text);
      if (!readBack.ok) {
        throw new StudyFailure("failed", "The result could not be saved in a form the app can open. Try again.");
      }
      const saved = unwrap(
        await library.saveSetFile(
          ref,
          (existing) => {
            // The last moment a cancel still means "nothing saved".
            if (signal.aborted) return null;
            return { name: studySetFileName(kind, created, existing), text };
          },
          // Only into the folder the material was read from: not into one that was deleted
          // and made again under the same name while the AI was working.
          material.identity,
        ),
      );
      if (saved === null) throw new StudyFailure("cancelled", CANCELLED);

      const result = summaryOfSet(saved.name, readBack.value);
      remember(rowKey(ref as MaterialRef, saved), result);
      const durationMs = Date.now() - started;
      log("study: made a result", { ...stats, items: result.itemCount, bytes: saved.size, durationMs });
      return { result, notices: prepared.notices, warnings, attempts, durationMs };
    } catch (error) {
      const code =
        error instanceof StudyFailure || error instanceof ProviderFailure || error instanceof LibraryFailure
          ? error.code
          : "unexpected";
      log("study: nothing was made", { ...stats, code, durationMs: Date.now() - started });
      // A cancel wins over whatever the cancelled work then reported.
      if (signal.aborted && code !== "cancelled") throw new StudyFailure("cancelled", CANCELLED);
      throw error;
    }
  }

  function generate(ref: unknown, request: unknown): Promise<StudyResult<GenerateOutcome>> {
    if (typeof request !== "object" || request === null || !isRefShaped(ref)) {
      return Promise.resolve({ ok: false, error: BAD_REQUEST });
    }
    const raw = request as Record<string, unknown>;
    const { requestId, kind } = raw;
    // Only the kinds the app offers are made; a quiz or a mock exam of an earlier version is still read.
    if (!isRequestId(requestId) || !isMakeableKind(kind)) return Promise.resolve({ ok: false, error: BAD_REQUEST });
    if (active !== null) return Promise.resolve({ ok: false, error: ALREADY_GENERATING });

    // Registered before the first `await`, so a cancel sent right behind this call finds it.
    const done = tasks.run<StudyResult<GenerateOutcome>>(
      requestId,
      async (signal) => {
        const activity: StudyActivity = {
          requestId,
          ref: { subject: ref.subject, material: ref.material },
          kind,
          started: now().toISOString(),
          message: "",
        };
        active = activity;
        try {
          return await toStudyResult(() => make(ref, kind, raw, signal, activity));
        } finally {
          if (active === activity) active = null;
        }
      },
      () => ({ ok: false, error: BAD_REQUEST }),
    );
    running = done;
    return done;
  }

  /** The names of a folder are the same folder whatever their capitals (Windows, default macOS). */
  const sameName = (a: string, b: string): boolean => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

  function isMakingFrom(target: unknown): boolean {
    if (active === null || typeof target !== "object" || target === null) return false;
    const { subject, material } = target as Record<string, unknown>;
    if (typeof subject !== "string" || !sameName(subject, active.ref.subject)) return false;
    if (material === undefined || material === null) return true;
    return typeof material === "string" && sameName(material, active.ref.material);
  }

  async function cancelFor(target: unknown): Promise<boolean> {
    if (!isMakingFrom(target) || active === null) return false;
    const pending = running;
    tasks.cancel(active.requestId);
    // Its promise never rejects; when it settles, the AI's process is gone and nothing is written.
    await pending?.catch(() => undefined);
    return true;
  }

  /** Whether a string is a result's name, and inside the library, is decided by the library. */
  function checkName(name: unknown): void {
    if (typeof name !== "string") throw new StudyFailure(BAD_REQUEST.code, BAD_REQUEST.message);
  }

  return {
    isMakingFrom,
    cancelFor,
    generate,
    current: () => (active === null ? null : { ...active, ref: { ...active.ref } }),
    list: (ref) => toStudyResult(() => list(ref)),
    read: (ref, name) =>
      toStudyResult(async () => {
        checkName(name);
        return read(ref, name);
      }),
    rename: (ref, name, title) =>
      toStudyResult(async () => {
        checkName(name);
        return rename(ref, name, title);
      }),
    remove: (ref, name) =>
      toStudyResult(async () => {
        checkName(name);
        return remove(ref, name);
      }),
  };
}

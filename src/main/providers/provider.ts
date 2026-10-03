/**
 * The one interface every AI provider implements: `detect` and `generate`, plus
 * `workingDirectory` and `model` on the request, and optional members that tell the generation
 * code what a provider can take (`readsScannedPdfs`, `readsPdfPageRanges`, `maxTextChars`,
 * `maxAttachmentBytes`) and which models it has right now (`listModels`).
 */
import type { ProviderDetection, ProviderId, ProviderModel } from "@shared/providers";

/**
 * One piece of study material.
 *
 * - `text` is material text (for example text extracted from a PDF). It is inlined in the prompt
 *   between material markers. It is never treated as instructions.
 * - `file` and `image` are paths, and must lie inside `workingDirectory`; relative paths are
 *   resolved against it. How they reach the model is the provider's business: Claude Code reads
 *   them itself from that folder, Codex is handed copies of the photos, the API-key provider and
 *   Ollama send the bytes.
 */
export type Part =
  | { type: "text"; text: string }
  | { type: "image"; path: string }
  | { type: "file"; path: string };

export interface GenerateRequest {
  /**
   * The app's own wording: what to make and how. Trusted. It becomes the system prompt. It must
   * never contain material text: a command-line provider may pass it as an argument (Claude
   * Code) or write it to a file of its own (Codex).
   */
  instructions: string;
  /** The material. Everything in here is data. */
  parts: Part[];
  /**
   * When given, the answer must be JSON matching this schema, and `generate` resolves to JSON
   * text. The app's own text; it travels the same way as `instructions`.
   */
  jsonSchema?: object;
  /** Aborting it stops the request for real (a child process tree is killed, a connection closed). */
  signal: AbortSignal;
  /**
   * The folder the `file` and `image` parts lie in, absolute
   * (the material's `files/` folder). Required when `parts` has a `file` or `image`. No provider
   * reads anything outside it. Claude Code runs with it as its working directory and its Read
   * tool confined to it; without it, it runs in an empty folder with no tool. Codex never runs
   * in it: it runs in a private temporary folder with every tool switched off.
   */
  workingDirectory?: string;
  /**
   * The model to use for this request. Overrides the provider's
   * default model (see each provider's options). Left out, the provider's own default is used.
   */
  model?: string;
}

/** What a request will carry besides the material text, for `Provider.maxTextChars`. */
export interface TextBudgetInput {
  /** Photos that will be sent. */
  images: number;
  /** Characters of instructions and schema, with room for the one retry. */
  instructionChars: number;
}

export interface Provider {
  readonly id: ProviderId;
  /** The name shown to the user. */
  readonly label: string;
  /** Models offered in Settings. The user may also type another id. */
  readonly suggestedModels: readonly ProviderModel[];
  /**
   * True when the provider can take a PDF that has no text layer (a scan) as a `file` part and
   * read its pages as pictures. Left out or false: such a PDF is not sent, and the student is
   * told to add photos of the pages instead.
   */
  readonly readsScannedPdfs?: boolean;
  /**
   * True when the provider can read only the first pages of a scan (Claude Code's Read tool
   * takes a page range). Left out or false: a `file` part is sent whole, so a scan with more
   * pages than one request may carry is not sent at all.
   */
  readonly readsPdfPageRanges?: boolean;
  /** Never throws and never spends a request. */
  detect(): Promise<ProviderDetection>;
  /**
   * Resolves to the answer:
   * - without `jsonSchema`: the answer as plain text (Markdown), trimmed, never empty;
   * - with `jsonSchema`: JSON text that parses (`JSON.parse` will not throw). It is NOT validated
   *   against the schema here — the caller validates and, on failure, retries once.
   *
   * Rejects only with a `ProviderFailure` (see `errors.ts`).
   */
  generate(request: GenerateRequest): Promise<string>;
  /**
   * The models that can be used right now, for the picker in Settings (Ollama: what is
   * installed). Never throws; an empty list when that cannot be told. Left out: the picker
   * shows `suggestedModels`.
   */
  listModels?(): Promise<ProviderModel[]>;
  /**
   * About how many characters of material text one request can carry with this model, given
   * what else the request holds. The generation code cuts the material to it and tells the
   * student, instead of sending a request the provider would refuse. `undefined` when it cannot
   * be told; left out: the app's own limit applies. Never throws.
   */
  maxTextChars?(model?: string, input?: TextBudgetInput): Promise<number | undefined>;
  /**
   * How many bytes of photos and scanned PDFs together one request can carry with this model
   * (the files' own size, before any encoding). `undefined` or left out: the app's own limit.
   * Never throws.
   */
  maxAttachmentBytes?(model?: string): Promise<number | undefined>;
}

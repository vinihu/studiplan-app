/**
 * The bridge between the renderer and the main process, defined once.
 *
 * `ipcContract` below is the single source of truth. Everything else is derived from it:
 *   - the preload script walks it to build `window.studiplan`,
 *   - the main process must supply a handler for every entry (`IpcHandlers`),
 *   - the renderer sees it as the fully typed `StudiplanApi`.
 *
 * To add a call: add one line to `ipcContract`, then write its handler in `src/main/ipc/`.
 * TypeScript reports the missing handler until it exists. No channel name is typed by hand.
 */

import type {
  AddFilesOutcome,
  ChooseRootOutcome,
  FolderTarget,
  LibraryInfo,
  LibraryResult,
  Material,
  MaterialRef,
  MaterialSummary,
  Subject,
} from "./library";
import type { FileTextResult } from "./preview";
import type {
  AiSettings,
  ApiKeyStatus,
  ApiKeyVendor,
  ProviderModel,
  ProviderDetectionEntry,
  ProviderId,
  ProviderInfo,
  ProviderResult,
  ProviderTestOptions,
  ProviderTestReply,
} from "./providers";
import type {
  GenerateOutcome,
  GenerateRequest,
  OpenedStudySet,
  StudyActivity,
  StudyResult,
  StudySetSummary,
} from "./results";
import type { TaskProgress } from "./tasks";

/** What `app.getInfo()` returns. */
export interface AppInfo {
  /** Display name of the app. */
  name: string;
  /** Version from package.json. */
  version: string;
  /** Operating system identifier, e.g. `win32`, `darwin`, `linux`. */
  platform: string;
  /** Version of the Electron runtime the app is running on. */
  electronVersion: string;
  /**
   * `release` for the app as published. `test` for a build with the development hooks on (the
   * dev server, the smoke tests): its folders and its AI can be replaced from outside.
   */
  build: "release" | "test";
}

declare const signature: unique symbol;

/** A typed marker for one call. It carries its argument and result types and no runtime data. */
export interface Channel<Args extends unknown[], Result> {
  readonly [signature]?: (...args: Args) => Result;
}

function channel<Args extends unknown[] = [], Result = void>(): Channel<Args, Result> {
  return {};
}

export const ipcContract = {
  app: {
    getInfo: channel<[], AppInfo>(),
  },
  library: {
    getInfo: channel<[], LibraryResult<LibraryInfo>>(),

    listSubjects: channel<[], LibraryResult<Subject[]>>(),
    createSubject: channel<[name: string], LibraryResult<Subject>>(),
    renameSubject: channel<[subject: string, newName: string], LibraryResult<Subject>>(),
    deleteSubject: channel<[subject: string], LibraryResult<null>>(),

    listMaterials: channel<[subject: string], LibraryResult<MaterialSummary[]>>(),
    createMaterial: channel<[subject: string, title: string], LibraryResult<MaterialSummary>>(),
    renameMaterial: channel<[ref: MaterialRef, title: string], LibraryResult<MaterialSummary>>(),
    deleteMaterial: channel<[ref: MaterialRef], LibraryResult<null>>(),
    getMaterial: channel<[ref: MaterialRef], LibraryResult<Material>>(),

    /** Copies PDFs and .pptx files into the material. `paths` are the user's source files. */
    addFiles: channel<[ref: MaterialRef, paths: string[]], LibraryResult<AddFilesOutcome>>(),
    /** Saves one photo set. `pages` are JPEG bytes, already downscaled, in page order. */
    addPhotoSet: channel<[ref: MaterialRef, pages: Uint8Array[]], LibraryResult<AddFilesOutcome>>(),
    /**
     * "Turn into PDF": makes one PDF from a photo set's pages, in order, and adds it to the
     * material directly after the set, named after it (`notes-2026-10-03.pdf`). The photos
     * stay. The PDF's pages are the photos themselves, unchanged. `added` holds the PDF, with
     * `madeFrom` set; the set in `material.files` then has `pdf`. Refused with code
     * `already-exists` while the set already has its PDF, and with a sentence when a page is
     * not a usable picture or the pages add up to more than one file may weigh.
     */
    photoSetToPdf: channel<[ref: MaterialRef, name: string], LibraryResult<AddFilesOutcome>>(),
    /** Removes one entry of `files/`: a file, or a whole photo set. */
    removeFile: channel<[ref: MaterialRef, name: string], LibraryResult<Material>>(),

    /**
     * The text of one PDF or .pptx of a material, read locally. Can take seconds for a large
     * file; the result is remembered until the file changes. With a `requestId`,
     * `tasks.cancel(requestId)` makes the call resolve early with code `"cancelled"`.
     */
    extractText: channel<[ref: MaterialRef, name: string, requestId?: string], FileTextResult>(),

    /**
     * Opens the system's folder picker and makes the chosen folder the library. Nothing is
     * moved. The renderer sends no path. Refused while `LibraryInfo.fixedByEnvironment`.
     */
    chooseRoot: channel<[], LibraryResult<ChooseRootOutcome>>(),
    /** Puts the library back at `Documents/Studiplan`. Nothing is moved. */
    useDefaultRoot: channel<[], LibraryResult<ChooseRootOutcome>>(),
    /** Shows the library folder, a subject's or a material's folder in the system file manager. */
    openFolder: channel<[target?: FolderTarget], LibraryResult<null>>(),
  },
  providers: {
    /** Every AI the app knows, in display order, with the models it suggests. Instant. */
    list: channel<[], ProviderInfo[]>(),
    /** Checks which of them are installed and signed in. Costs no request; can take seconds. */
    detectAll: channel<[], ProviderDetectionEntry[]>(),
    getSettings: channel<[], AiSettings>(),
    /** Chooses the provider results are made with. `null` clears the choice. */
    setDefault: channel<[id: ProviderId | null], ProviderResult<AiSettings>>(),
    /** Chooses the model for one provider. `null` goes back to the provider's own default. */
    setModel: channel<[id: ProviderId, model: string | null], ProviderResult<AiSettings>>(),
    /**
     * The Settings "Test" button: one tiny real request, answered with one line. Cancel it with
     * `tasks.cancel(options.requestId)`; it then resolves with code `"cancelled"`.
     */
    test: channel<[id: ProviderId, options: ProviderTestOptions], ProviderResult<ProviderTestReply>>(),
    /**
     * The models to offer in the picker for one provider, right now: for Ollama what is
     * installed, for the API key the models of the vendors that have a key, otherwise the
     * provider's suggestions. Never fails; an empty list means "none found" (Ollama not
     * running, or no model pulled). Any other name can still be typed and saved with `setModel`.
     */
    listModels: channel<[id: ProviderId], ProviderModel[]>(),
    /** Which vendors have an API key saved. Never the key. */
    apiKeyStatus: channel<[], ApiKeyStatus>(),
    /**
     * Stores one vendor's API key, encrypted by the operating system. The key crosses the
     * bridge here, once, and is never sent back. A new key replaces the vendor's old one.
     */
    saveApiKey: channel<[vendor: ApiKeyVendor, key: string], ProviderResult<ApiKeyStatus>>(),
    /** Removes one vendor's key. Fine when there is none. */
    clearApiKey: channel<[vendor: ApiKeyVendor], ProviderResult<ApiKeyStatus>>(),
  },
  study: {
    /**
     * Makes one result from a material with the student's AI, checks it and saves it in the
     * material's `sets/` folder. Takes seconds to minutes. Sends `taskProgress` events with
     * `request.requestId`; `tasks.cancel(request.requestId)` stops it, and it then resolves
     * with code `"cancelled"` and nothing saved. One at a time in the whole app: while one is
     * running, another resolves at once with code `"already-generating"`.
     */
    generate: channel<[ref: MaterialRef, request: GenerateRequest], StudyResult<GenerateOutcome>>(),
    /** What is being made right now, or `null`. Instant. */
    current: channel<[], StudyActivity | null>(),
    /** A material's results, newest first. A file that cannot be opened is listed with its `problem`. */
    list: channel<[ref: MaterialRef], StudyResult<StudySetSummary[]>>(),
    /** One result, validated again. `name` is `StudySetSummary.name`. */
    read: channel<[ref: MaterialRef, name: string], StudyResult<OpenedStudySet>>(),
    /** Changes a result's title. The file keeps its name. */
    rename: channel<[ref: MaterialRef, name: string, title: string], StudyResult<StudySetSummary>>(),
    /** Moves a result to the system's recycle bin. */
    remove: channel<[ref: MaterialRef, name: string], StudyResult<null>>(),
  },
  tasks: {
    /**
     * Stops the running call that was started with this `requestId`. True if one was running.
     * False if it had already finished or never existed; that is not an error.
     */
    cancel: channel<[requestId: string], boolean>(),
  },
} as const;

declare const payload: unique symbol;

/** A typed marker for one event the main process sends to the page. No runtime data. */
export interface EventChannel<Payload> {
  readonly [payload]?: Payload;
}

function event<Payload>(): EventChannel<Payload> {
  return {};
}

/**
 * Everything the main process may push to the page without being asked. The page listens with
 * `window.studiplan.events.subscribe(name, listener)`; the main process sends with `emit`.
 * To add an event: add one line here.
 */
export const ipcEvents = {
  /** Progress of a running call that was started with a `requestId`. */
  taskProgress: event<TaskProgress>(),
} as const;

export type IpcEvents = typeof ipcEvents;
export type EventName = keyof IpcEvents;
export type EventPayload<Name extends EventName> =
  IpcEvents[Name] extends EventChannel<infer Payload> ? Payload : never;

export type IpcContract = typeof ipcContract;

type Signature<C> = C extends Channel<infer Args, infer Result> ? [Args, Result] : never;
type ChannelArgs<C> = Signature<C>[0];
type ChannelResult<C> = Signature<C>[1];

/**
 * What the preload exposes besides the contract: things that must run in the page's own
 * process and so cannot be an IPC call.
 */
export interface LocalApi {
  readonly files: {
    /**
     * The path on disk of a `File` the user dropped or picked, to pass to `library.addFiles`.
     * Synchronous. Returns an empty string for a `File` that was made in code and is not on disk.
     */
    pathFor(file: File): string;
  };
  readonly events: {
    /**
     * Calls `listener` every time the main process sends `event`, until the function this
     * returns is called. Only the events of `ipcEvents` can be listened to.
     */
    subscribe<Name extends EventName>(event: Name, listener: (payload: EventPayload<Name>) => void): () => void;
  };
}

/** The object exposed to the renderer as `window.studiplan`. Every contract call is asynchronous. */
export type StudiplanApi = {
  readonly [Namespace in keyof IpcContract]: {
    readonly [Method in keyof IpcContract[Namespace]]: (
      ...args: ChannelArgs<IpcContract[Namespace][Method]>
    ) => Promise<ChannelResult<IpcContract[Namespace][Method]>>;
  };
} & LocalApi;

/** What the main process has to implement: one handler per entry of the contract. */
export type IpcHandlers = {
  readonly [Namespace in keyof IpcContract]: {
    readonly [Method in keyof IpcContract[Namespace]]: (
      ...args: ChannelArgs<IpcContract[Namespace][Method]>
    ) =>
      | ChannelResult<IpcContract[Namespace][Method]>
      | Promise<ChannelResult<IpcContract[Namespace][Method]>>;
  };
};

/** The name the bridge is exposed under on `window`. */
export const BRIDGE_KEY = "studiplan";

/** The IPC channel name for one call. Derived, never written by hand. */
export function channelName(namespace: string, method: string): string {
  return `${BRIDGE_KEY}:${namespace}:${method}`;
}

/** Every call of the contract as `[namespace, method]`, in declaration order. */
export function listChannels(): Array<[namespace: string, method: string]> {
  return Object.entries(ipcContract).flatMap(([namespace, methods]) =>
    Object.keys(methods).map((method): [string, string] => [namespace, method]),
  );
}

/** The IPC channel name for one event. Derived, never written by hand. */
export function eventChannelName(event: EventName): string {
  return `${BRIDGE_KEY}:event:${event}`;
}

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && Object.hasOwn(ipcEvents, value);
}

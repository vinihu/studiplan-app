/**
 * The long-lived parts of the main process that the bridge handlers and the preview scheme
 * share: the settings file, the library, the text reader, the AI providers, the running tasks.
 *
 * Built on first use, not on import, so `app.setPath("userData", …)` has already run. This is
 * the one place that supplies what needs Electron (where Documents and the settings file are,
 * the recycle bin); the modules themselves do not import it.
 */
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import type { LibraryInfo } from "@shared/library";
import { DEV_HOOKS, hookValue } from "../build";
import { checkLibraryRoot } from "../library/choose-root";
import { createLibrary } from "../library/library";
import type { LibraryService } from "../library/library";
import { LIBRARY_DIR_ENV, resolveCheckedLibraryRoot } from "../library/root";
import type { CheckedLibraryRoot } from "../library/root";
import { createIsolatedExtractor } from "../extract/isolated";
import type { IsolatedExtractor } from "../extract/isolated";
import extractWorkerFile from "../extract/worker?modulePath";
import { startExtractWorker } from "../extract/worker-host";
import { createTextReader } from "../library/text";
import { describeError } from "../log-safe";
import type { TextReader } from "../library/text";
import {
  createApiKeyStore,
  createDefaultProviderRegistry,
  createFakeProvider,
  createProviderRegistry,
  fakeAiMode,
} from "../providers";
import type { ApiKeyStore, ProviderRegistry } from "../providers";
import { createSettingsStore } from "../settings";
import type { SettingsStore } from "../settings";
import { createTaskRegistry } from "../tasks";
import type { TaskRegistry } from "../tasks";
import { rootPlaces } from "./root-places";

export interface MainContext {
  settings: SettingsStore;
  library: LibraryService;
  text: TextReader;
  providers: ProviderRegistry;
  /** The saved API keys, encrypted by the operating system, in the app's profile folder. */
  apiKeys: ApiKeyStore;
  tasks: TaskRegistry;
  /**
   * Reads the text of PDFs and decks in a worker that can be stopped (`src/main/extract/isolated.ts`).
   * Every extraction in the app goes through it, never through the extraction functions directly.
   */
  extractor: IsolatedExtractor;
  /**
   * Where the library is right now: the environment override (builds with the development hooks
   * only), the folder from Settings if it passes the checks, or the default.
   */
  libraryInfo(): Promise<LibraryInfo>;
}

let context: MainContext | null = null;

/** How long a refused folder stays refused before it is looked at again (a drive plugged back in). */
const REFUSAL_MS = 10_000;

/**
 * The verdict on the folder in the settings file, kept per folder so the disk is not probed on
 * every library call: an accepted folder for as long as the app runs, a refused one for a while.
 */
function createRootResolver(settings: SettingsStore): () => Promise<LibraryInfo> {
  let last: { configured: string | undefined; verdict: Promise<CheckedLibraryRoot>; until: number } | null = null;
  const told = new Set<string>();

  /** Once per folder and run: a message box, since the folder shown is not the one expected. */
  const tell = (folder: string, notice: string): void => {
    if (told.has(folder)) return;
    told.add(folder);
    console.error("[library] the folder in settings.json was refused; using the default place");
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: app.getName(),
      message: "The library folder could not be used",
      detail: notice,
      buttons: ["OK"],
      noLink: true,
    };
    const window = BrowserWindow.getAllWindows()[0];
    void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).catch(() => {});
  };

  return async () => {
    const configured = (await settings.read()).libraryRoot;
    if (last === null || last.configured !== configured || Date.now() > last.until) {
      const verdict = resolveCheckedLibraryRoot({
        // A development hook: a release build does not read the variable.
        override: hookValue(LIBRARY_DIR_ENV),
        configured,
        documents: app.getPath("documents"),
        check: (folder) => checkLibraryRoot(folder, rootPlaces()),
      });
      const entry = { configured, verdict, until: Number.POSITIVE_INFINITY };
      last = entry;
      void verdict.then((checked) => {
        if (checked.refused !== null) entry.until = Date.now() + REFUSAL_MS;
      });
    }
    const checked = await last.verdict;
    if (checked.refused !== null && checked.info.notice !== undefined) tell(checked.refused, checked.info.notice);
    return checked.info;
  };
}

export function getContext(): MainContext {
  if (context) return context;

  const settings = createSettingsStore(app.getPath("userData"));
  const libraryInfo = createRootResolver(settings);

  const library = createLibrary({
    // Asked on every call, so a folder chosen in Settings is used from the next call on.
    root: libraryInfo,
    // Deleting goes to the recycle bin, so a subject deleted by mistake can be brought back.
    trash: (target) => shell.trashItem(target),
    trashName: process.platform === "win32" ? "Recycle Bin" : "Trash",
    log: (error) => console.error("[library]", describeError(error)),
  });

  // `safeStorage` works once the app is ready, and the context is first asked for after that.
  // The profile folder honours STUDIPLAN_USER_DATA_DIR where that hook exists (see `src/main/index.ts`).
  const apiKeys = createApiKeyStore({ directory: app.getPath("userData"), safeStorage });

  // The test seam (`src/main/providers/fake.ts`): a development hook, never in a release build.
  const fake = fakeAiMode(process.env, DEV_HOOKS);
  if (fake !== null) console.error(`[providers] STUDIPLAN_FAKE_AI is set: every AI is replaced by the Test AI (${fake}).`);

  const extractor = createIsolatedExtractor({ start: startExtractWorker(extractWorkerFile) });

  context = {
    apiKeys,
    extractor,
    settings,
    library,
    text: createTextReader({
      locateFile: (ref, name) => library.locateFile(ref, name),
      extract: (kind, path) => extractor.extractText(kind, path),
    }),
    providers:
      fake === null
        ? createDefaultProviderRegistry({ apiKeyStore: apiKeys })
        : createProviderRegistry([createFakeProvider(fake)]),
    tasks: createTaskRegistry(),
    libraryInfo,
  };
  return context;
}

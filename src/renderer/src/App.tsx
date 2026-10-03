import { Button } from "@heroui/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiSettings, ProviderInfo } from "@shared/providers";
import { ai } from "./ai/api";
import { describeChosenAi } from "./ai/labels";
import { ErrorNotice } from "./components/ErrorNotice";
import { GenerationStatus } from "./components/GenerationStatus";
import { NameDialog } from "./components/NameDialog";
import { Page } from "./components/Page";
import { Sidebar } from "./components/Sidebar";
import { useDialog } from "./components/use-dialog";
import { useFocusOnMount } from "./components/use-escape";
import { carriesFiles } from "./components/use-file-drop";
import { trashName } from "./lib/format";
import { library } from "./library/api";
import { useLibraryQuery } from "./library/use-library-query";
import { useNavigation } from "./navigation";
import { FirstRunScreen } from "./screens/FirstRunScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { useLibraryFolderChange } from "./settings/use-library-folder";
import { MaterialScreen } from "./screens/MaterialScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { StudyScreen } from "./screens/StudyScreen";
import { useGeneration } from "./study/use-generation";

/**
 * The frame every screen lives in: the subjects on the left, one screen on the right.
 *
 * Which screen is decided here and only here, from `useNavigation`: Settings while it is open,
 * else a result when one is open, else a material when one is open, otherwise the selected
 * subject's list. Screens are told what to show and report back
 * what changed; they never switch screens on their own.
 */
export function App() {
  const navigation = useNavigation();
  const { location } = navigation;
  const subjects = useLibraryQuery(library.listSubjects);
  const info = useLibraryQuery(library.getInfo);
  const newSubject = useDialog();
  const trash = trashName(usePlatform());
  const [aiSettings, setAiSettings] = useAiSettings();
  const providers = useProviders();
  // Held here, not in a screen: a result keeps being made while the student looks elsewhere.
  const generation = useGeneration();
  /** The name a subject was really saved under, when it differs from what was typed. */
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const aiLabel = describeChosenAi(
    aiSettings,
    Object.fromEntries((providers ?? []).map((provider) => [provider.id, provider.label])),
  );

  useIgnoreStrayFileDrops();

  // One flow for changing the library folder, whichever control starts it. From the app proper
  // it ends in Settings, where it says that nothing was moved (or why the folder was refused).
  const refreshInfo = info.refresh;
  const refreshSubjects = subjects.refresh;
  const inApp = useRef(false);
  const folder = useLibraryFolderChange(() => {
    if (inApp.current) {
      // Another folder: what was open may not exist there. Start from its subject list.
      navigation.selectSubject(null);
      navigation.openSettings();
    }
    refreshInfo();
    refreshSubjects();
  });

  const list = subjects.state.status === "ready" ? subjects.state.value : null;
  // The remembered subject may be gone (deleted, or renamed outside the app): fall back to the first.
  const subject = list?.find((item) => item.id === location.subject) ?? list?.[0] ?? null;
  const root = info.state.status === "ready" ? info.state.value : null;

  // First run: shown once, to someone who has no subjects and no AI yet. It latches when it
  // appears, so choosing an AI on it does not make it vanish, and ends with Start or Skip.
  const [firstRun, setFirstRun] = useState<"undecided" | "showing" | "over">(() =>
    firstRunIsDone() ? "over" : "undecided",
  );
  if (firstRun === "undecided" && list !== null && aiSettings !== null) {
    setFirstRun(list.length === 0 && aiSettings.defaultProvider === null ? "showing" : "over");
  }
  const endFirstRun = () => {
    rememberFirstRunDone();
    setFirstRun("over");
  };

  useEffect(() => {
    inApp.current = firstRun !== "showing";
  }, [firstRun]);

  if (firstRun === "undecided" && !firstRunIsDone() && subjects.state.status !== "error") {
    // Nothing yet: a blank moment is calmer than the library flashing up before the first-run screen.
    return (
      <div className="flex h-full flex-col" data-testid="app-starting" aria-busy="true">
        <TitleStrip />
      </div>
    );
  }

  if (firstRun === "showing") {
    return (
      <div className="flex h-full flex-col">
        <TitleStrip />
        <div className="min-h-0 flex-1">
          <FirstRunScreen
            info={root}
            aiSettings={aiSettings}
            onAiSettings={setAiSettings}
            folder={folder}
            onDone={endFirstRun}
            onOpenSettings={() => {
              endFirstRun();
              navigation.openSettings();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full" data-testid="app-shell">
      <Sidebar
        subjects={subjects.state}
        selected={subject?.id ?? null}
        // Always to the subject's list of materials, also from one of its materials or
        // results and from Settings (whose own back button returns to where the user was).
        onSelect={navigation.selectSubject}
        activity={
          <GenerationStatus
            generation={generation}
            viewing={
              !location.settings && subject && location.material !== null
                ? { subject: subject.id, material: location.material }
                : null
            }
            onOpenResult={(ref, name) => navigation.openResultOf(ref.subject, ref.material, name)}
            onOpenMaterial={(ref) => navigation.openMaterial(ref.subject, ref.material)}
          />
        }
        onNewSubject={() => newSubject.open(true)}
        info={root}
        settingsOpen={location.settings}
        onSettings={navigation.openSettings}
        aiMissing={aiSettings !== null && aiSettings.defaultProvider === null}
        folderBusy={folder.busy}
        onChangeFolder={() => {
          // A refusal is said in Settings, next to the folder; so is "nothing was moved".
          void folder.choose().then((end) => {
            if (end === "failed") navigation.openSettings();
          });
        }}
      />

      {/* The screen, under the strip that belongs to the window's buttons: nothing of a screen
          can ever lie under them, at any width. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleStrip />
      <main className="min-h-0 min-w-0 flex-1">
        {location.settings ? (
          <SettingsScreen
            backLabel={subject?.id ?? "Library"}
            onBack={navigation.closeSettings}
            info={root}
            aiSettings={aiSettings}
            onAiSettings={setAiSettings}
            folder={folder}
          />
        ) : null}

        {!location.settings && subjects.state.status === "error" ? (
          <Page>
            <ErrorNotice
              title="Your library could not be opened"
              message={subjects.state.error.message}
              onRetry={subjects.refresh}
            />
          </Page>
        ) : null}

        {!location.settings && list && subject === null ? (
          <Welcome root={root?.root ?? null} onNewSubject={() => newSubject.open(true)} />
        ) : null}

        {!location.settings && subject && location.material !== null && location.result !== null ? (
          <StudyScreen
            key={`${subject.id}/${location.material}/${location.result}`}
            material={{ subject: subject.id, material: location.material }}
            name={location.result}
            onBack={navigation.closeResult}
          />
        ) : null}

        {!location.settings && subject && location.material !== null && location.result === null ? (
          <MaterialScreen
            key={`${subject.id}/${location.material}`}
            subject={subject.id}
            materialId={location.material}
            trash={trash}
            generation={generation}
            aiChosen={aiSettings === null ? null : aiSettings.defaultProvider !== null}
            aiLabel={aiLabel}
            onOpenSettings={navigation.openSettings}
            onOpenResult={navigation.openResult}
            onBack={() => {
              navigation.closeMaterial();
              // Counts in the sidebar may have changed while the material was open.
              subjects.refresh();
            }}
            onRenamed={(renamed) => navigation.openMaterial(subject.id, renamed.id)}
            onDeleted={() => {
              navigation.closeMaterial();
              subjects.refresh();
            }}
            onLibraryChanged={subjects.refresh}
          />
        ) : null}

        {!location.settings && subject && location.material === null ? (
          <LibraryScreen
            key={subject.id}
            subject={subject}
            trash={trash}
            generation={generation}
            savedAs={savedAs}
            onDismissSavedAs={() => setSavedAs(null)}
            onOpenMaterial={(material) => navigation.openMaterial(subject.id, material)}
            onSubjectRenamed={(renamed, typed) => {
              setSavedAs(renamed.id === typed.trim() ? null : renamed.id);
              navigation.selectSubject(renamed.id);
              subjects.refresh();
            }}
            onSubjectDeleted={() => {
              navigation.selectSubject(null);
              subjects.refresh();
            }}
            onLibraryChanged={subjects.refresh}
          />
        ) : null}
      </main>
      </div>

      <NameDialog
        isOpen={newSubject.isOpen}
        onClose={newSubject.close}
        title="New subject"
        hint="A class you study, like Biology or History."
        label="Name"
        placeholder="Biology"
        submitLabel="Create"
        onSubmit={async (name) => {
          const result = await library.createSubject(name);
          if (!result.ok) return result.error.message;
          // A folder cannot have every character: when the name was changed on the way, say so.
          setSavedAs(result.value.id === name.trim() ? null : result.value.id);
          navigation.selectSubject(result.value.id);
          subjects.refresh();
          return null;
        }}
      />
    </div>
  );
}

/**
 * The top of the window where there is no sidebar under it: as tall as the window's own buttons,
 * empty, and the window moves when it is dragged. Where the system draws its own title bar
 * (Linux) it has no height.
 */
function TitleStrip() {
  return <div className="app-drag h-(--titlebar-height) shrink-0" data-testid="title-strip" />;
}

/** The first thing a new user sees: no subjects yet. It says what a subject is and what to do. */
function Welcome({ root, onNewSubject }: { root: string | null; onNewSubject: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(heading);
  return (
    <Page>
      <div className="max-w-lg pt-16">
        <h1 ref={heading} tabIndex={-1} className="text-2xl leading-8 font-semibold tracking-tight outline-none">
          Start with a subject
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted">
          Turn your study materials into summaries, cheat sheets, flashcards and practice tests,
          with your own AI, for free.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted">
          A subject is a class you study, like Biology or History. Inside it you keep your
          materials: a chapter, a set of slides, photos of your notes.
        </p>
        <Button variant="primary" className="mt-7" onPress={onNewSubject}>
          <Plus aria-hidden />
          New subject
        </Button>
        {root ? (
          <p className="mt-12 border-t border-separator pt-5 text-sm leading-relaxed text-muted">
            Everything you add is saved as ordinary folders on this computer, in
            <span className="block break-all text-foreground">{root}</span>
          </p>
        ) : null}
      </div>
    </Page>
  );
}

/**
 * Which AI the user chose, read once at start and replaced whenever Settings changes it.
 * `null` until the main process answers. The Make buttons will read the same value.
 */
function useAiSettings(): [AiSettings | null, (settings: AiSettings) => void] {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ai.getSettings().then((value) => {
      if (!cancelled) setSettings((current) => current ?? value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return [settings, useCallback((value: AiSettings) => setSettings(value), [])];
}

const FIRST_RUN_KEY = "studiplan.firstRunDone";

function firstRunIsDone(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_KEY) !== null;
  } catch {
    // Without storage the screen could never be put away for good: do not show it at all.
    return true;
  }
}

function rememberFirstRunDone(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // It will be offered once more next time; Skip is one click.
  }
}

/** The AIs this version of the app has, for their names. `null` until the main process answers. */
function useProviders(): ProviderInfo[] | null {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ai.list().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}

/** The operating system (`win32`, `darwin`, `linux`), or `null` until the main process answers. */
function usePlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.studiplan.app.getInfo().then(
      (info) => {
        if (!cancelled) setPlatform(info.platform);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return platform;
}

/**
 * A file dropped anywhere that is not a drop target would make the window try to open it.
 * Outside a drop target, a dragged file is shown as "not allowed" and a drop does nothing.
 */
function useIgnoreStrayFileDrops() {
  useEffect(() => {
    const ignore = (event: DragEvent) => {
      if (!carriesFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", ignore);
    window.addEventListener("drop", ignore);
    return () => {
      window.removeEventListener("dragover", ignore);
      window.removeEventListener("drop", ignore);
    };
  }, []);
}

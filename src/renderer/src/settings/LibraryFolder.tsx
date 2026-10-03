import { Button, Skeleton } from "@heroui/react";
import { useEffect, useRef } from "react";
import type { LibraryInfo } from "@shared/library";
import { Notice } from "../components/Notice";
import { count } from "../lib/format";
import type { LibraryFolderChange } from "./use-library-folder";

/** What is said when the folder cannot be changed in the app, wherever a control for it is shown. */
export const FOLDER_FIXED_REASON =
  "This folder is set from outside the app for this run (STUDIPLAN_LIBRARY_DIR), so it cannot be changed here.";

/** The same, where there is room for a few words only (the sidebar). */
export const FOLDER_FIXED_SHORT = "Set from outside the app for this run, so it cannot be changed here.";

/**
 * Where the library is kept, and the ways to change that. Used in Settings and on the first-run
 * screen. Changing the folder moves nothing, and the screen says so. The change itself is
 * `useLibraryFolderChange`, shared with the sidebar's own "Change…", so what is said here is
 * said whichever control was pressed.
 */
export function LibraryFolder({
  info,
  folder,
  showOpen = true,
}: {
  /** Where the library is, or `null` while that is not known. */
  info: LibraryInfo | null;
  /** The flow that changes the folder, and what it has to say. */
  folder: LibraryFolderChange;
  /** Offer "Open folder". Off on the first-run screen, where the folder is still empty. */
  showOpen?: boolean;
}) {
  const { busy, moved, error } = folder;
  // A change started from the sidebar ends here: bring what there is to say into view.
  const notices = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moved === null && error === null) return;
    const show = () => notices.current?.scrollIntoView({ block: "nearest" });
    show();
    // Settings may still be filling in above (the AIs are being checked), which pushes this
    // down again: keep it in view for a moment, unless the student scrolls or clicks meanwhile.
    let left = 15;
    const timer = window.setInterval(() => {
      show();
      if (--left === 0) stop();
    }, 100);
    const stop = () => {
      window.clearInterval(timer);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("pointerdown", stop);
    window.addEventListener("keydown", stop);
    return stop;
  }, [moved, error]);

  const fixed = info?.fixedByEnvironment ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div>
        {info ? (
          <p className="text-[0.9375rem] font-medium break-all" data-testid="library-root">
            {info.root}
          </p>
        ) : (
          <Skeleton className="h-5 w-96 max-w-full" />
        )}
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {info === null
            ? " "
            : fixed
              ? FOLDER_FIXED_REASON
              : info.isDefault
                ? "This is the default folder, in your Documents."
                : "A folder you chose."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {showOpen ? (
          <Button variant="outline" onPress={() => void folder.open()} isDisabled={info === null}>
            Open folder
          </Button>
        ) : null}
        <Button variant="outline" onPress={() => void folder.choose()} isDisabled={info === null || fixed || busy}>
          Change…
        </Button>
        {info && !info.isDefault ? (
          <Button variant="ghost" onPress={() => void folder.useDefault()} isDisabled={fixed || busy}>
            Use the default folder
          </Button>
        ) : null}
      </div>

      <div ref={notices} className="flex flex-col gap-4 empty:hidden">
      {error ? (
        <Notice status="danger" role="alert" title="The folder was not changed" onClose={folder.dismissError}>
          {error}
        </Notice>
      ) : null}

      {moved && moved.previousRoot !== null ? (
        <Notice
          role="status"
          testId="library-moved"
          title={`The library is now in this folder. ${count(moved.subjectCount, "subject")} found here.`}
          onClose={folder.dismissMoved}
        >
          <p className="text-sm break-words text-muted">
            Nothing was moved or copied. Everything you had before is still in{" "}
            <span className="break-all text-foreground">{moved.previousRoot}</span>. To keep using it
            here, move those folders into the new folder yourself.
          </p>
        </Notice>
      ) : null}
      </div>
    </div>
  );
}

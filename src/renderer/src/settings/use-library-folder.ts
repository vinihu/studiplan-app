import { useCallback, useState } from "react";
import type { ChooseRootOutcome, LibraryResult } from "@shared/library";
import { library } from "../library/api";

/** How an attempt to change the folder ended: it is another one now, it stayed, or it was refused. */
export type FolderChangeEnd = "changed" | "same" | "failed";

/**
 * Changing where the library is kept: the one flow behind every control that does it (Settings,
 * the first-run screen, the sidebar). It asks the main process to show the folder picker, and
 * keeps what there is to say afterwards: that nothing was moved, or why the folder was refused.
 * `LibraryFolder` shows those sentences.
 */
export interface LibraryFolderChange {
  /** A picker is open or the answer is on its way. */
  busy: boolean;
  /** The last change, until its notice is put away. */
  moved: ChooseRootOutcome | null;
  /** Why the last attempt did not work, until its notice is put away. */
  error: string | null;
  /** Lets the user pick a folder. */
  choose: () => Promise<FolderChangeEnd>;
  /** Goes back to the default folder. */
  useDefault: () => Promise<FolderChangeEnd>;
  /** Shows the library folder in the system's file manager. */
  open: () => Promise<void>;
  dismissMoved: () => void;
  dismissError: () => void;
}

export function useLibraryFolderChange(
  /** The library is in another folder now: everything read from it is out of date. */
  onMoved: () => void,
): LibraryFolderChange {
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState<ChooseRootOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<LibraryResult<ChooseRootOutcome>>): Promise<FolderChangeEnd> => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return "failed";
    }
    setError(null);
    if (!result.value.changed) return "same";
    setMoved(result.value);
    onMoved();
    return "changed";
  };

  return {
    busy,
    moved,
    error,
    choose: () => run(library.chooseRoot),
    useDefault: () => run(library.useDefaultRoot),
    open: async () => {
      const result = await library.openFolder();
      setError(result.ok ? null : result.error.message);
    },
    dismissMoved: useCallback(() => setMoved(null), []),
    dismissError: useCallback(() => setError(null), []),
  };
}

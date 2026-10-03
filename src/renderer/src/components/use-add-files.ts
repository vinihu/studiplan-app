import { useCallback, useState } from "react";
import type { MaterialRef } from "@shared/library";
import { addToMaterial } from "../lib/files/add-to-material";
import type { AddProgress, AddReport } from "../lib/files/add-to-material";
import { photoToJpeg } from "../lib/files/photo-to-jpeg";
import { library, pathFor } from "../library/api";

/** Adding files to one material: nothing going on, in progress, or finished with a report. */
export type AddFilesState =
  | { status: "idle" }
  | { status: "working"; title: string; progress: AddProgress }
  | { status: "done"; title: string; report: AddReport };

export interface AddFiles {
  state: AddFilesState;
  isWorking: boolean;
  /** Adds what the user dropped or picked. Ignored while an earlier add is still running. */
  start: (ref: MaterialRef, title: string, files: File[]) => void;
  /** Puts the report away. */
  dismiss: () => void;
}

/**
 * Runs one add action at a time and keeps what the screen shows about it.
 * `onFinished` is called once per action with the report, whether or not anything was added.
 */
export function useAddFiles(onFinished: (ref: MaterialRef, report: AddReport) => void): AddFiles {
  const [state, setState] = useState<AddFilesState>({ status: "idle" });
  const isWorking = state.status === "working";

  const start = useCallback(
    (ref: MaterialRef, title: string, files: File[]) => {
      if (isWorking || files.length === 0) return;
      setState({ status: "working", title, progress: { step: "saving" } });
      void addToMaterial(
        ref,
        files,
        {
          pathFor,
          toJpeg: photoToJpeg,
          addFiles: library.addFiles,
          addPhotoSet: library.addPhotoSet,
        },
        (progress) => setState({ status: "working", title, progress }),
      ).then((report) => {
        setState({ status: "done", title, report });
        onFinished(ref, report);
      });
    },
    [isWorking, onFinished],
  );

  const dismiss = useCallback(() => setState({ status: "idle" }), []);

  return { state, isWorking, start, dismiss };
}

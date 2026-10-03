import { Label, ProgressBar } from "@heroui/react";
import { hasNotes, hasProblems } from "../lib/files/add-to-material";
import type { AddProgress } from "../lib/files/add-to-material";
import { countInline, describeAdded } from "../lib/format";
import { Notice } from "./Notice";
import type { AddFilesState } from "./use-add-files";

/**
 * What the screen says about files being added: a progress bar while it runs, then a notice.
 * A notice with problems stays until it is closed and lists every file that was turned away
 * with its reason, next to what did get added.
 */
export function AddFilesStatus({
  state,
  onDismiss,
  showSuccess = false,
}: {
  state: AddFilesState;
  onDismiss: () => void;
  /** Also confirm an add that had no problems. Off where the new files are visible anyway. */
  showSuccess?: boolean;
}) {
  if (state.status === "idle") return null;

  if (state.status === "working") {
    return <Working title={state.title} progress={state.progress} />;
  }

  const { report, title } = state;
  const added = describeAdded(report.added);
  const problems = hasProblems(report);
  const copies = report.copies;
  if (!hasNotes(report) && !showSuccess) return null;
  if (!hasNotes(report) && added === "") return null;

  const notAdded = report.rejected.length;
  const heading = !problems
    ? copies.length > 0 && !showSuccess
      ? copies.length === 1
        ? "A second copy was added"
        : "Second copies were added"
      : `Added ${added} to ${title}`
    : notAdded > 0
      ? `${countInline(notAdded, "file")} ${notAdded === 1 ? "was" : "were"} not added`
      : "The files could not be added";

  return (
    <Notice status={problems ? "danger" : "default"} role={problems ? "alert" : "status"} title={heading} onClose={onDismiss}>
      <>
        {problems ? (
          <div className="flex flex-col gap-2 text-sm text-muted">
            {report.failures.map((failure) => (
              <p key={failure}>{failure}</p>
            ))}
            {notAdded > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {report.rejected.map((file, index) => (
                  <li key={`${index}-${file.name}`} className="break-words">
                    <span className="font-medium text-foreground">{file.name}</span>
                    <span className="block">{file.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {added !== "" ? <p className="text-foreground">Added to {title}: {added}.</p> : null}
          </div>
        ) : null}
        {copies.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-muted" data-testid="second-copies">
            {copies.map((copy) => (
              <li key={copy.savedAs} className="break-words">
                “{copy.original}” was already here, so a second copy was added as “{copy.savedAs}”.
              </li>
            ))}
          </ul>
        ) : null}
      </>
    </Notice>
  );
}

function Working({ title, progress }: { title: string; progress: AddProgress }) {
  if (progress.step === "photos") {
    const current = Math.min(progress.done + 1, progress.total);
    return (
      <ProgressBar value={progress.done} maxValue={progress.total} size="sm">
        <Label className="truncate">
          Preparing photo {current} of {progress.total} for {title}
        </Label>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
    );
  }
  return (
    <ProgressBar isIndeterminate size="sm">
      <Label className="truncate">Saving to {title}</Label>
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  );
}

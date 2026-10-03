import { Skeleton } from "@heroui/react";
import { useCallback } from "react";
import type { MaterialRef } from "@shared/library";
import type { OpenedStudySet, StudyError } from "@shared/results";
import { BackLink } from "../components/BackLink";
import { ErrorNotice } from "../components/ErrorNotice";
import { Page } from "../components/Page";
import { library } from "../library/api";
import { useLibraryQuery } from "../library/use-library-query";
import { StudySetView } from "../study";
import { study } from "../study/api";

interface Opened extends OpenedStudySet {
  /** The material's title, for the way back. Its folder name when the title cannot be read. */
  materialTitle: string;
}

/**
 * Study: one saved result, read from disk and handed to the viewer for its kind. The file is
 * checked again every time it is opened, because a student may have edited it.
 */
export function StudyScreen({
  material,
  name,
  onBack,
}: {
  material: MaterialRef;
  /** The result's file name in the material's `sets/` folder. */
  name: string;
  onBack: () => void;
}) {
  const { subject, material: materialId } = material;
  const load = useCallback(async (): Promise<{ ok: true; value: Opened } | { ok: false; error: StudyError }> => {
    const ref = { subject, material: materialId };
    const [opened, info] = await Promise.all([study.read(ref, name), library.getMaterial(ref)]);
    if (!opened.ok) return opened;
    return { ok: true, value: { ...opened.value, materialTitle: info.ok ? info.value.title : materialId } };
  }, [subject, materialId, name]);
  const query = useLibraryQuery<Opened, StudyError>(load);

  if (query.state.status === "ready") {
    const { set, warnings, materialTitle } = query.state.value;
    return <StudySetView key={name} set={set} materialTitle={materialTitle} warnings={warnings} onBack={onBack} />;
  }

  const back = <BackLink label={materialId} onPress={onBack} />;

  if (query.state.status === "loading") {
    return (
      <Page>
        <div className="mb-8 flex flex-col gap-3" aria-busy="true" aria-label="Opening the result">
          {back}
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="flex max-w-[37rem] flex-col gap-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </Page>
    );
  }

  const { error } = query.state;
  return (
    <Page>
      <div className="mb-8 flex flex-col gap-3">{back}</div>
      <div data-testid="study-error">
        <ErrorNotice title="This result could not be opened" message={error.message} onRetry={query.refresh} />
        {error.details && error.details.length > 0 ? (
          <ul className="mt-4 flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-muted">
            {error.details.map((detail, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                {detail}
              </li>
            ))}
          </ul>
        ) : null}
        {error.code === "unreadable-result" ? (
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">
            The file is still in the material’s folder. You can fix it in an editor, or delete it from Results.
          </p>
        ) : null}
      </div>
    </Page>
  );
}

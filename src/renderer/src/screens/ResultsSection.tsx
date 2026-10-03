import { Skeleton, Table } from "@heroui/react";
import { useCallback, useEffect } from "react";
import type { MaterialRef } from "@shared/library";
import type { StudyError, StudySetSummary } from "@shared/results";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { KIND_ICONS } from "../components/kind-icons";
import { NameDialog } from "../components/NameDialog";
import { OptionsMenu } from "../components/OptionsMenu";
import { Section } from "../components/Page";
import { CELL_CONTROL, CELL_FACT, CELL_NAME, OUTDENT, ROW_OPENS, ROW_STATIC, RowList } from "../components/RowList";
import { useDialog } from "../components/use-dialog";
import { count, formatDatesApart } from "../lib/format";
import { describeMaker, describeResult, describeResultDetail } from "../lib/make";
import { useLibraryQuery } from "../library/use-library-query";
import { study } from "../study/api";
import { isFor } from "../study/use-generation";
import type { Generation } from "../study/use-generation";

const RESULT_COLUMNS = [
  { name: "Title" },
  { name: "Kind", className: "max-lg:hidden" },
  { name: "Made with", className: "max-lg:hidden" },
  { name: "Made on" },
  { name: "Options" },
];

/**
 * Results: everything made from this material, newest first. Pressing a row opens it in its
 * viewer. A file that can no longer be opened is still listed, with the reason, so it can be
 * deleted.
 */
export function ResultsSection({
  material,
  hasFiles,
  trash,
  generation,
  onOpen,
  onChanged,
}: {
  material: MaterialRef;
  hasFiles: boolean;
  /** What the system calls its bin ("Recycle Bin", "Trash"), or `null` while not known. */
  trash: string | null;
  generation: Generation;
  onOpen: (name: string) => void;
  /** The number of results changed: the Library shows it. */
  onChanged: () => void;
}) {
  const { subject, material: materialId } = material;
  const load = useCallback(() => study.list({ subject, material: materialId }), [subject, materialId]);
  const query = useLibraryQuery<StudySetSummary[], StudyError>(load);
  const rename = useDialog<StudySetSummary>();
  const remove = useDialog<StudySetSummary>();

  // A result that was just made (or failed, or was cancelled) changes what is in the folder.
  const refresh = query.refresh;
  const onEnd = generation.onEnd;
  useEffect(
    () =>
      onEnd((ref) => {
        if (ref.subject === subject && ref.material === materialId) {
          refresh();
          onChanged();
        }
      }),
    [onEnd, refresh, onChanged, subject, materialId],
  );

  const list = query.state.status === "ready" ? query.state.value : null;
  // Three summaries made on one afternoon are told apart by when: the time joins the date
  // wherever two results share a day.
  const dates = formatDatesApart((list ?? []).map((result) => result.created));
  const newest =
    generation.finished && isFor(material, generation.finished) && generation.finished.result.ok
      ? generation.finished.result.value.result.name
      : null;

  return (
    <Section title="Results" detail={list && list.length > 0 ? count(list.length, "result") : null}>
      {query.state.status === "loading" ? (
        <div className={`${OUTDENT} flex h-11.25 items-center px-4`} aria-busy="true" aria-label="Loading results">
          <Skeleton className="h-4 w-56" />
        </div>
      ) : null}

      {query.state.status === "error" ? (
        <ErrorNotice
          title="The results could not be loaded"
          message={query.state.error.message}
          onRetry={query.refresh}
        />
      ) : null}

      {list && list.length === 0 ? (
        <p className="max-w-xl text-sm leading-relaxed text-muted" data-testid="results-empty">
          {hasFiles
            ? "Nothing made yet. Choose what to make above. It is saved here and stays until you delete it."
            : "What you make from this material is kept here."}
        </p>
      ) : null}

      {list && list.length > 0 ? (
        <RowList
          label="Results made from this material"
          columns={RESULT_COLUMNS}
          onOpen={(name) => {
            const row = list.find((item) => item.name === name);
            if (row && row.problem === null) onOpen(row.name);
          }}
        >
                  {list.map((result, index) => {
                    const Icon = KIND_ICONS[result.kind];
                    const broken = result.problem !== null;
                    const detail = describeResultDetail(result);
                    return (
                      <Table.Row
                        key={result.name}
                        id={result.name}
                        data-result={result.name}
                        className={broken ? ROW_STATIC : ROW_OPENS}
                      >
                        <Table.Cell className={CELL_NAME}>
                          <span className="flex items-center gap-3">
                            <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                            <span className="min-w-0">
                              <span className={`block truncate font-medium ${broken ? "text-muted" : ""}`}>
                                {result.title}
                                {result.name === newest ? (
                                  <span className="ml-2.5 text-xs font-medium text-accent">New</span>
                                ) : null}
                              </span>
                              {broken ? (
                                <span className="block text-xs leading-relaxed whitespace-normal text-danger">
                                  {result.problem}
                                </span>
                              ) : (
                                // In a narrow window the column of facts gives its room to the title,
                                // and what it said is said here instead.
                                <span className={`block truncate text-xs text-muted ${detail ? "" : "lg:hidden"}`}>
                                  <span className="lg:hidden">
                                    {describeResult(result)}
                                    {detail ? ` · ${detail.charAt(0).toLowerCase()}${detail.slice(1)}` : ""}
                                  </span>
                                  <span className="max-lg:hidden">{detail}</span>
                                </span>
                              )}
                            </span>
                          </span>
                        </Table.Cell>
                        <Table.Cell className={`${CELL_FACT} max-lg:hidden`}>{describeResult(result)}</Table.Cell>
                        {/* In a narrow window the title needs the room more than the AI's name does. */}
                        <Table.Cell className={`${CELL_FACT} max-lg:hidden`}>{describeMaker(result)}</Table.Cell>
                        <Table.Cell className={`${CELL_FACT} text-end`}>{dates[index]}</Table.Cell>
                        <Table.Cell className={CELL_CONTROL}>
                          <OptionsMenu
                            label={`Options for ${result.title}`}
                            onDelete={() => remove.open(result)}
                            {...(broken ? {} : { onRename: () => rename.open(result) })}
                          />
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
        </RowList>
      ) : null}

      <NameDialog
        isOpen={rename.isOpen}
        onClose={rename.close}
        title="Rename result"
        label="Title"
        initialValue={rename.target?.title ?? ""}
        submitLabel="Rename"
        onSubmit={async (title) => {
          const target = rename.target;
          if (!target) return null;
          const result = await study.rename(material, target.name, title);
          if (!result.ok) return result.error.message;
          query.refresh();
          return null;
        }}
      />

      <ConfirmDialog
        isOpen={remove.isOpen}
        onClose={remove.close}
        title={`Delete “${remove.target?.title ?? ""}”?`}
        confirmLabel="Delete result"
        onConfirm={async () => {
          const target = remove.target;
          if (!target) return null;
          const result = await study.remove(material, target.name);
          if (!result.ok) return result.error.message;
          if (target.name === newest) generation.dismiss();
          query.refresh();
          onChanged();
          return null;
        }}
      >
        {trash === null
          ? "This result will be deleted. The material's files stay."
          : `This result will be moved to the ${trash}. You can restore it from there. The material's files stay.`}
      </ConfirmDialog>
    </Section>
  );
}

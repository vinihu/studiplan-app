import { Button, Kbd, Skeleton, Table, Tooltip } from "@heroui/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect } from "react";
import type { MaterialSummary, Subject } from "@shared/library";
import { AddFilesStatus } from "../components/AddFilesStatus";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { NameDialog } from "../components/NameDialog";
import { Notice } from "../components/Notice";
import { OptionsMenu } from "../components/OptionsMenu";
import { Page, PageHeader } from "../components/Page";
import { CELL_CONTROL, CELL_FACT, CELL_NAME, OUTDENT, ROW_OPENS, RowList } from "../components/RowList";
import { useAddFiles } from "../components/use-add-files";
import { useDialog } from "../components/use-dialog";
import { useFileDrop } from "../components/use-file-drop";
import { formatDate, count, materialDeletion, subjectDeletion } from "../lib/format";
import { deletionStopsMaking, describeContents } from "../lib/make";
import type { Generation } from "../study/use-generation";
import { library } from "../library/api";
import { useLibraryQuery } from "../library/use-library-query";

const sameId = (a: MaterialSummary, b: MaterialSummary) => a.id === b.id;

/**
 * The selected subject and its materials. Pressing a material opens it; files dropped on a
 * material's row are added to it without opening it.
 */
export function LibraryScreen({
  subject,
  trash,
  onOpenMaterial,
  onSubjectRenamed,
  onSubjectDeleted,
  onLibraryChanged,
  generation,
  savedAs,
  onDismissSavedAs,
}: {
  subject: Subject;
  /** What the system calls its bin ("Recycle Bin", "Trash"), or `null` while not known. */
  trash: string | null;
  onOpenMaterial: (material: string) => void;
  /** `typed` is what the student wrote: the folder's name can differ from it. */
  onSubjectRenamed: (renamed: Subject, typed: string) => void;
  onSubjectDeleted: () => void;
  /** Something that the subject list shows has changed (a material was added or deleted). */
  onLibraryChanged: () => void;
  /** What is being made right now: deleting what it is made from stops it, and the dialog says so. */
  generation: Generation;
  /** This subject's name, when it was saved differently from what was typed. */
  savedAs: string | null;
  onDismissSavedAs: () => void;
}) {
  const subjectId = subject.id;
  const making = generation.running?.ref.subject === subjectId ? generation.running : null;
  const load = useCallback(() => library.listMaterials(subjectId), [subjectId]);
  const materials = useLibraryQuery(load);
  const list = materials.state.status === "ready" ? materials.state.value : null;

  const newMaterial = useDialog();
  const renameSubject = useDialog();
  const deleteSubject = useDialog();
  const renameMaterial = useDialog<MaterialSummary>();
  const deleteMaterial = useDialog<MaterialSummary>();

  // Ctrl+N (Cmd+N on a Mac): a new material, the thing done most often on this screen.
  const openNewMaterial = newMaterial.open;
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      openNewMaterial(true);
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, [openNewMaterial]);

  const refreshMaterials = materials.refresh;
  const adding = useAddFiles(useCallback(() => refreshMaterials(), [refreshMaterials]));

  const drop = useFileDrop<MaterialSummary>({
    targetAt: (element) => {
      const id = element.closest("[data-material-id]")?.getAttribute("data-material-id");
      return list?.find((material) => material.id === id) ?? null;
    },
    isSame: sameId,
    onDrop: (material, files) =>
      adding.start({ subject: subjectId, material: material.id }, material.title, files),
    disabled: adding.isWorking,
  });

  const fileTotal = list?.reduce((sum, material) => sum + material.fileCount, 0) ?? null;
  const materialTotal = list?.length ?? subject.materialCount;

  return (
    <Page>
      <PageHeader
        title={subjectId}
        detail={list && list.length > 0 ? count(list.length, "material") : null}
        actions={
          <>
            <OptionsMenu
              label={`Options for ${subjectId}`}
              onRename={() => renameSubject.open(true)}
              onDelete={() => deleteSubject.open(true)}
            />
            <Tooltip delay={500}>
              <Button variant="primary" aria-keyshortcuts="Control+N" onPress={() => newMaterial.open(true)}>
                <Plus aria-hidden />
                New material
              </Button>
              <Tooltip.Content className="flex items-center gap-1.5">
                <Kbd>Ctrl</Kbd>
                <Kbd>N</Kbd>
              </Tooltip.Content>
            </Tooltip>
          </>
        }
      />

      <div className="flex flex-col gap-5">
        {savedAs === subjectId ? (
          <Notice role="status" title={`Saved as “${subjectId}”`} onClose={onDismissSavedAs} testId="saved-as">
            Some characters cannot be used in the name of a folder, so they were left out.
          </Notice>
        ) : null}

        <AddFilesStatus state={adding.state} onDismiss={adding.dismiss} showSuccess />

        {materials.state.status === "loading" ? <LoadingRows /> : null}

        {materials.state.status === "error" ? (
          <ErrorNotice
            title="The materials could not be loaded"
            message={materials.state.error.message}
            onRetry={materials.refresh}
          />
        ) : null}

        {list && list.length === 0 ? (
          <div className={`${OUTDENT} px-4 pt-6`}>
            <h2 className="text-base font-semibold">No materials yet</h2>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
              A material is one topic, such as a chapter, a lecture or a set of notes. Press New
              material, give it a title, then add its files.
            </p>
          </div>
        ) : null}

        {list && list.length > 0 ? (
          <RowList
            label={`Materials in ${subjectId}`}
            columns={MATERIAL_COLUMNS}
            onOpen={onOpenMaterial}
            frame={drop.handlers}
          >
                    {list.map((material) => {
                      const isDropTarget = drop.over?.id === material.id;
                      return (
                        <Table.Row
                          key={material.id}
                          id={material.id}
                          data-material-id={material.id}
                          className={`${ROW_OPENS} ${isDropTarget ? "[&_td]:bg-accent-soft" : ""}`}
                        >
                          <Table.Cell className={CELL_NAME}>
                            <span className="block truncate font-medium">{material.title}</span>
                            {isDropTarget ? (
                              <span className="block text-xs font-medium text-accent">
                                Drop to add here
                              </span>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell className={CELL_FACT}>{describeContents(material)}</Table.Cell>
                          <Table.Cell className={`${CELL_FACT} text-end`}>{formatDate(material.created)}</Table.Cell>
                          <Table.Cell className={CELL_CONTROL}>
                            <OptionsMenu
                              label={`Options for ${material.title}`}
                              onRename={() => renameMaterial.open(material)}
                              onDelete={() => deleteMaterial.open(material)}
                            />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
          </RowList>
        ) : null}
      </div>

      <NameDialog
        isOpen={newMaterial.isOpen}
        onClose={newMaterial.close}
        title="New material"
        hint={`One topic in ${subjectId}: a chapter, a lecture, a set of notes.`}
        label="Title"
        placeholder="Cell division"
        submitLabel="Create"
        onSubmit={async (title) => {
          const result = await library.createMaterial(subjectId, title);
          if (!result.ok) return result.error.message;
          onLibraryChanged();
          onOpenMaterial(result.value.id);
          return null;
        }}
      />

      <NameDialog
        isOpen={renameSubject.isOpen}
        onClose={renameSubject.close}
        title="Rename subject"
        label="Name"
        initialValue={subjectId}
        submitLabel="Rename"
        onSubmit={async (name) => {
          const result = await library.renameSubject(subjectId, name);
          if (!result.ok) return result.error.message;
          onSubjectRenamed(result.value, name);
          return null;
        }}
      />

      <ConfirmDialog
        isOpen={deleteSubject.isOpen}
        onClose={deleteSubject.close}
        title={`Delete “${subjectId}”?`}
        confirmLabel="Delete subject"
        onConfirm={async () => {
          if (making) await generation.stopQuietly();
          const result = await library.deleteSubject(subjectId);
          if (!result.ok) return result.error.message;
          onSubjectDeleted();
          return null;
        }}
      >
        {subjectDeletion(materialTotal, fileTotal, trash)}
        {making ? <span className="mt-2 block font-medium text-foreground">{deletionStopsMaking(making.kind, making.title)}</span> : null}
      </ConfirmDialog>

      <NameDialog
        isOpen={renameMaterial.isOpen}
        onClose={renameMaterial.close}
        title="Rename material"
        label="Title"
        initialValue={renameMaterial.target?.title ?? ""}
        submitLabel="Rename"
        onSubmit={async (title) => {
          const target = renameMaterial.target;
          if (!target) return null;
          const result = await library.renameMaterial(
            { subject: subjectId, material: target.id },
            title,
          );
          if (!result.ok) return result.error.message;
          materials.refresh();
          return null;
        }}
      />

      <ConfirmDialog
        isOpen={deleteMaterial.isOpen}
        onClose={deleteMaterial.close}
        title={`Delete “${deleteMaterial.target?.title ?? ""}”?`}
        confirmLabel="Delete material"
        onConfirm={async () => {
          const target = deleteMaterial.target;
          if (!target) return null;
          if (making?.ref.material === target.id) await generation.stopQuietly();
          const result = await library.deleteMaterial({ subject: subjectId, material: target.id });
          if (!result.ok) return result.error.message;
          materials.refresh();
          onLibraryChanged();
          return null;
        }}
      >
        {deleteMaterial.target ? materialDeletion(deleteMaterial.target, trash) : null}
        {making && making.ref.material === deleteMaterial.target?.id ? (
          <span className="mt-2 block font-medium text-foreground">{deletionStopsMaking(making.kind)}</span>
        ) : null}
      </ConfirmDialog>
    </Page>
  );
}

const MATERIAL_COLUMNS = [{ name: "Title" }, { name: "Contents" }, { name: "Added" }, { name: "Options" }];

function LoadingRows() {
  return (
    <div className={`${OUTDENT} flex flex-col`} aria-busy="true" aria-label="Loading materials">
      {["w-48", "w-64", "w-40"].map((width) => (
        <div key={width} className="flex h-11.25 items-center border-b border-separator px-4">
          <Skeleton className={`h-4 ${width}`} />
        </div>
      ))}
    </div>
  );
}

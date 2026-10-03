import { Button, Label, ProgressBar, Skeleton, Table } from "@heroui/react";
import { CornerDownRight, FileOutput, FileText, Images, Plus, Presentation, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { Material, MaterialFile, MaterialFileKind, MaterialRef, MaterialSummary } from "@shared/library";
import { previewUrl } from "@shared/preview";
import { AddFilesStatus } from "../components/AddFilesStatus";
import { BackLink } from "../components/BackLink";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { IconButton } from "../components/IconButton";
import { NameDialog } from "../components/NameDialog";
import { Notice } from "../components/Notice";
import { OptionsMenu } from "../components/OptionsMenu";
import { Page, PageHeader, Section } from "../components/Page";
import { CELL_CONTROL, CELL_FACT, CELL_NAME, ROW_OPENS, RowList } from "../components/RowList";
import { useAddFiles } from "../components/use-add-files";
import { useDialog } from "../components/use-dialog";
import { useFileDrop } from "../components/use-file-drop";
import type { AddReport } from "../lib/files/add-to-material";
import { count, describeFile, fileRemoval, formatDate, formatSize, madeFromLine, MADE_FROM_PHOTOS_NOTE, materialDeletion, PDF_STAYS_NOTE } from "../lib/format";
import { deletionStopsMaking } from "../lib/make";
import { library } from "../library/api";
import { useLibraryQuery } from "../library/use-library-query";
import { isFor } from "../study/use-generation";
import type { Generation } from "../study/use-generation";
import { FilePreview, Photo } from "./FilePreview";
import { MakeSection } from "./MakeSection";
import { ResultsSection } from "./ResultsSection";

const KIND_ICONS: Record<MaterialFileKind, LucideIcon> = {
  pdf: FileText,
  pptx: Presentation,
  "photo-set": Images,
};

/** What the file picker offers. Dropped files are checked the same way, by `splitFiles`. */
const PICKER_ACCEPT = ".pdf,.pptx,image/*";

const always = () => true as const;
const same = () => true;

/**
 * One material, in the order a student uses it: Files (what you have), Make (turn it into
 * something to study), Results (what was made).
 *
 * The one blue button follows that order. With no files it is Add files; once there are files,
 * making something is the point of the screen, so the blue moves to Make and Add files steps
 * back to an outline.
 *
 * Files can be dropped anywhere on the screen. Pressing a file opens it in place: the preview
 * takes over this screen's area until the student goes back.
 */
export function MaterialScreen({
  subject,
  materialId,
  trash,
  onBack,
  onRenamed,
  onDeleted,
  onLibraryChanged,
  generation,
  aiChosen,
  aiLabel,
  onOpenSettings,
  onOpenResult,
}: {
  subject: string;
  materialId: string;
  /** What the system calls its bin ("Recycle Bin", "Trash"), or `null` while not known. */
  trash: string | null;
  onBack: () => void;
  onRenamed: (renamed: MaterialSummary) => void;
  onDeleted: () => void;
  /** Something the Library shows has changed (the number of files or results). */
  onLibraryChanged: () => void;
  /** The app's one generation at a time: what is being made, and how the last one ended. */
  generation: Generation;
  /** Whether an AI is chosen in Settings. `null` while that is being read. */
  aiChosen: boolean | null;
  aiLabel: string | null;
  onOpenSettings: () => void;
  /** Opens one of this material's results in the Study screen. */
  onOpenResult: (name: string) => void;
}) {
  const load = useCallback(
    () => library.getMaterial({ subject, material: materialId }),
    [subject, materialId],
  );
  const query = useLibraryQuery(load);
  const material = query.state.status === "ready" ? query.state.value : null;

  const rename = useDialog();
  const remove = useDialog();
  const removeFile = useDialog<MaterialFile>();
  const picker = useRef<HTMLInputElement>(null);
  /** Name of the file that is open in the preview, or `null` for the material itself. */
  const [openName, setOpenName] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  /** Turning a photo set into a PDF: which set it is working on, and how the last one ended. */
  const [pdf, setPdf] = useState<
    { status: "idle" } | { status: "working"; set: string } | { status: "made"; set: string; name: string } | { status: "failed"; message: string }
  >({ status: "idle" });
  const closePreview = useCallback(() => setOpenName(null), []);

  const setMaterial = query.set;
  const adding = useAddFiles(
    useCallback(
      (_ref: unknown, report: AddReport) => {
        if (report.material) setMaterial(report.material);
        onLibraryChanged();
      },
      [setMaterial, onLibraryChanged],
    ),
  );

  const add = (files: File[]) => {
    if (material) adding.start({ subject, material: materialId }, material.title, files);
  };

  const turnIntoPdf = async (file: MaterialFile) => {
    if (pdf.status === "working") return;
    setPdf({ status: "working", set: file.name });
    const result = await library.photoSetToPdf({ subject, material: materialId }, file.name);
    if (!result.ok) {
      setPdf({ status: "failed", message: result.error.message });
      return;
    }
    setMaterial(result.value.material);
    onLibraryChanged();
    setPdf({ status: "made", set: file.name, name: result.value.added[0]?.name ?? `${file.name}.pdf` });
  };

  const drop = useFileDrop<true>({
    targetAt: always,
    isSame: same,
    onDrop: (_target, files) => add(files),
    disabled: material === null || adding.isWorking || openName !== null,
  });

  const back = <BackLink label={subject} onPress={onBack} />;

  if (query.state.status === "loading") {
    return (
      <Page>
        <div className="mb-8 flex flex-col gap-3" aria-busy="true" aria-label="Loading material">
          {back}
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-4 w-full" />
      </Page>
    );
  }

  if (query.state.status === "error" || material === null) {
    return (
      <Page>
        <div className="mb-8 flex flex-col gap-3">{back}</div>
        <ErrorNotice
          title="This material could not be opened"
          message={query.state.status === "error" ? query.state.error.message : ""}
          onRetry={query.refresh}
        />
      </Page>
    );
  }

  const ref: MaterialRef = { subject, material: materialId };
  // Looked up by name on every render, so a file that is gone closes its own preview.
  const openFile = material.files.find((file) => file.name === openName) ?? null;
  if (openFile) {
    return <FilePreview material={ref} title={material.title} file={openFile} onBack={closePreview} />;
  }

  const openFolder = async () => {
    const result = await library.openFolder(ref);
    setFolderError(result.ok ? null : result.error.message);
  };

  const added = formatDate(material.created);

  return (
    <Page
      frame={drop.handlers}
      overlay={drop.over ? <DropOverlay title={material.title} /> : null}
    >
      <PageHeader
        above={back}
        title={material.title}
        detail={added ? `Added ${added}` : null}
        actions={
          <OptionsMenu
            label={`Options for ${material.title}`}
            onRename={() => rename.open(true)}
            onDelete={() => remove.open(true)}
            onOpenFolder={() => void openFolder()}
          />
        }
      />

      {folderError ? (
        <Notice status="danger" role="alert" className="mb-8" title="The folder could not be opened" onClose={() => setFolderError(null)}>
          {folderError}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-12">
        <Section
          title="Files"
          detail={material.files.length > 0 ? count(material.files.length, "file") : null}
          actions={
            <Button
              variant={material.files.length === 0 ? "primary" : "outline"}
              onPress={() => picker.current?.click()}
              isDisabled={adding.isWorking}
            >
              <Plus aria-hidden />
              Add files
            </Button>
          }
        >
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            accept={PICKER_ACCEPT}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              // Cleared so that picking the same file again still counts as a change.
              event.currentTarget.value = "";
              add(files);
            }}
          />

          <AddFilesStatus state={adding.state} onDismiss={adding.dismiss} />

          {pdf.status === "working" ? (
            <ProgressBar isIndeterminate size="sm" data-testid="pdf-working">
              <Label className="truncate">Turning {pdf.set} into a PDF</Label>
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          ) : null}
          {pdf.status === "made" ? (
            <Notice role="status" testId="pdf-made" title={`“${pdf.name}” was added`} onClose={() => setPdf({ status: "idle" })}>
              {`It has the same pages as the photos in ${pdf.set}. ${MADE_FROM_PHOTOS_NOTE}`}
            </Notice>
          ) : null}
          {pdf.status === "failed" ? (
            <Notice status="danger" role="alert" testId="pdf-failed" title="The PDF could not be made" onClose={() => setPdf({ status: "idle" })}>
              {pdf.message}
            </Notice>
          ) : null}

          {material.files.length === 0 ? (
            <EmptyFiles />
          ) : (
            <FileList
              material={ref}
              files={material.files}
              onOpen={setOpenName}
              onRemove={removeFile.open}
              onTurnIntoPdf={(file) => void turnIntoPdf(file)}
              working={pdf.status === "working" ? pdf.set : null}
            />
          )}
        </Section>

        <MakeSection
          material={ref}
          title={material.title}
          hasFiles={material.files.length > 0}
          hasPhotoPdf={material.files.some((file) => file.madeFrom !== undefined)}
          aiChosen={aiChosen}
          aiLabel={aiLabel}
          generation={generation}
          onOpenSettings={onOpenSettings}
          onOpenResult={onOpenResult}
        />

        <ResultsSection
          material={ref}
          hasFiles={material.files.length > 0}
          trash={trash}
          generation={generation}
          onOpen={onOpenResult}
          onChanged={onLibraryChanged}
        />
      </div>

      <NameDialog
        isOpen={rename.isOpen}
        onClose={rename.close}
        title="Rename material"
        label="Title"
        initialValue={material.title}
        submitLabel="Rename"
        onSubmit={async (title) => {
          const result = await library.renameMaterial({ subject, material: materialId }, title);
          if (!result.ok) return result.error.message;
          onRenamed(result.value);
          return null;
        }}
      />

      <ConfirmDialog
        isOpen={remove.isOpen}
        onClose={remove.close}
        title={`Delete “${material.title}”?`}
        confirmLabel="Delete material"
        onConfirm={async () => {
          if (isFor(ref, generation.running)) await generation.stopQuietly();
          const result = await library.deleteMaterial({ subject, material: materialId });
          if (!result.ok) return result.error.message;
          onDeleted();
          return null;
        }}
      >
        {materialDeletion({ fileCount: material.files.length, setCount: material.setCount }, trash)}
        {generation.running && isFor(ref, generation.running) ? (
          <span className="mt-2 block font-medium text-foreground">{deletionStopsMaking(generation.running.kind)}</span>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={removeFile.isOpen}
        onClose={removeFile.close}
        title={`Remove “${removeFile.target?.name ?? ""}”?`}
        confirmLabel="Remove file"
        onConfirm={async () => {
          const target = removeFile.target;
          if (!target) return null;
          const result = await library.removeFile({ subject, material: materialId }, target.name);
          if (!result.ok) return result.error.message;
          setMaterial(result.value);
          onLibraryChanged();
          return null;
        }}
      >
        {removeFile.target ? fileRemoval(removeFile.target, trash) : null}
        {removeFile.target?.pdf ? <span className="mt-2 block font-medium text-foreground">{PDF_STAYS_NOTE}</span> : null}
      </ConfirmDialog>
    </Page>
  );
}

/** How many pages of a photo set are shown in its row. */
const ROW_THUMBNAILS = 4;

function FileList({
  material,
  files,
  onOpen,
  onRemove,
  onTurnIntoPdf,
  working,
}: {
  material: MaterialRef;
  files: Material["files"];
  onOpen: (name: string) => void;
  onRemove: (file: MaterialFile) => void;
  onTurnIntoPdf: (file: MaterialFile) => void;
  /** The photo set that is being turned into a PDF right now, or `null`. */
  working: string | null;
}) {
  return (
    <RowList label="Files in this material" columns={FILE_COLUMNS} onOpen={onOpen}>
              {files.map((file) => {
                const Icon = KIND_ICONS[file.kind];
                // A PDF made from a photo set is the same pages in another form: it hangs under
                // its set, indented, and says so, so it is not taken for more material.
                const from = madeFromLine(file);
                return (
                  <Table.Row key={file.name} id={file.name} className={ROW_OPENS}>
                    <Table.Cell className={CELL_NAME}>
                      <span className="flex items-center gap-3" {...(from ? { "data-made-from": file.madeFrom } : {})}>
                        {from ? <CornerDownRight aria-hidden className="ml-1 size-4 shrink-0 text-muted" /> : null}
                        <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{file.name}</span>
                          {from ? <span className="block truncate text-xs text-muted">{from}</span> : null}
                        </span>
                        {file.kind === "photo-set" && file.pages && file.pages.length > 0 ? (
                          // The first pages, so one set of notes can be told from another at a glance.
                          <span className="-my-1 ml-1 flex shrink-0 gap-1" aria-hidden data-testid="row-thumbnails">
                            {file.pages.slice(0, ROW_THUMBNAILS).map((page) => (
                              <Photo
                                key={page}
                                src={previewUrl(material, file.name, page)}
                                className="size-7 rounded-sm border border-border object-cover"
                              />
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </Table.Cell>
                    <Table.Cell className={CELL_FACT}>{describeFile(file)}</Table.Cell>
                    <Table.Cell className={`${CELL_FACT} text-end`}>{formatSize(file.size)}</Table.Cell>
                    <Table.Cell className={CELL_CONTROL}>
                      <span className="flex justify-end gap-1">
                        {file.kind === "photo-set" && !file.pdf ? (
                          <IconButton
                            label={`Turn ${file.name} into a PDF`}
                            tooltip="Turn into PDF"
                            isPending={working === file.name}
                            isDisabled={working !== null && working !== file.name}
                            onPress={() => onTurnIntoPdf(file)}
                          >
                            <FileOutput aria-hidden />
                          </IconButton>
                        ) : null}
                        <IconButton label={`Remove ${file.name}`} tooltip="Remove" onPress={() => onRemove(file)}>
                          <Trash2 aria-hidden />
                        </IconButton>
                      </span>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
    </RowList>
  );
}

const FILE_COLUMNS = [{ name: "Name" }, { name: "Kind" }, { name: "Size" }, { name: "Remove" }];

function EmptyFiles() {
  return (
    <div className="rounded-md border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium">Drop files here, or press Add files</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
        PDFs, PowerPoint files (.pptx) and photos of your notes. Photos you add together are kept
        as one set, in the order you picked them.
      </p>
    </div>
  );
}

/** Shown over the whole screen while files are dragged over it. */
function DropOverlay({ title }: { title: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-background/80 p-3">
      <div className="absolute inset-3 rounded-md border-2 border-dashed border-accent" />
      <p className="relative mb-8 max-w-md truncate rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">
        Drop to add to {title}
      </p>
    </div>
  );
}

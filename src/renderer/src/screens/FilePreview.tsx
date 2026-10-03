import { Button, Label, ProgressBar } from "@heroui/react";
import { ChevronLeft, ChevronRight, Info, LayoutGrid, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MaterialFile, MaterialRef } from "@shared/library";
import { previewUrl } from "@shared/preview";
import { BackLink } from "../components/BackLink";
import { ErrorNotice } from "../components/ErrorNotice";
import { IconButton } from "../components/IconButton";
import { Notice } from "../components/Notice";
import { useEscape, useFocusOnMount } from "../components/use-escape";
import {
  FORMULAS_LOST_NOTE,
  canRetryTextError,
  coverageNote,
  isCalmTextError,
  splitSections,
  textErrorTitle,
  textlessNote,
} from "../lib/file-text";
import type { TextSection } from "../lib/file-text";
import { countInline, describeFile, formatSize, MADE_FROM_PHOTOS_NOTE } from "../lib/format";
import { useFileText } from "../library/use-file-text";

/**
 * One file of a material, opened in place. It takes over the screen's whole area, because a PDF
 * page or a photo of handwriting needs the room, and has one way back: to the material.
 *
 *   PDF        the system's own PDF viewer, in a frame
 *   photo set  the pages as a grid, and one page large with previous / next
 *   .pptx      the text of the slides, for reading (the slides themselves cannot be drawn)
 */
export function FilePreview({
  material,
  title,
  file,
  onBack,
}: {
  material: MaterialRef;
  /** The material's title, for the way back. */
  title: string;
  file: MaterialFile;
  onBack: () => void;
}) {
  if (file.kind === "photo-set") {
    return <PhotoSetPreview material={material} title={title} file={file} onBack={onBack} />;
  }
  if (file.kind === "pptx") {
    return <SlideTextPreview material={material} title={title} file={file} onBack={onBack} />;
  }
  return <PdfPreview material={material} title={title} file={file} onBack={onBack} />;
}

interface PreviewProps {
  material: MaterialRef;
  title: string;
  file: MaterialFile;
  onBack: () => void;
}

/** The part every preview shares: the way back, the file's name, and the area below it. */
function PreviewFrame({
  title,
  file,
  onBack,
  actions,
  children,
}: {
  title: string;
  file: MaterialFile;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(heading);
  return (
    // The same column as every other screen, so the way back and the title do not move.
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-10 pt-(--screen-top)" data-testid="file-preview">
      {/* As in `PageHeader`: heading first for the keyboard, the way back above it on screen. */}
      <header className="mb-5 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-x-6 gap-y-3">
        <div className="col-start-1 row-start-2 min-w-0">
          <h1 ref={heading} tabIndex={-1} className="truncate text-2xl leading-8 font-semibold tracking-tight outline-none">
            {file.name}
          </h1>
          <p className="mt-1 text-sm text-muted tabular-nums">
            {describeFile(file)} · {formatSize(file.size)}
          </p>
        </div>
        <div className="col-span-2 col-start-1 row-start-1 flex min-w-0">
          <BackLink label={title} onPress={onBack} />
        </div>
        {actions ? <div className="col-start-2 row-start-2 flex min-h-9 shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

/* ── PDF ─────────────────────────────────────────────────────────────────────────────────── */

function PdfPreview({ material, title, file, onBack }: PreviewProps) {
  useEscape(onBack);
  // The viewer shows a scan like any other PDF. Whether there is text in it for the app to read
  // is found out beside it (the reading is remembered, and stopped when the preview is left).
  const text = useFileText(material, file.name);
  // A PDF made from a photo set has no text either, and that is not a problem to report: the
  // photos are what is read. It says what it is instead.
  const fromPhotos = file.madeFrom !== undefined;
  const noText = !fromPhotos && text.state.status === "error" && text.state.error.code === "no-text";
  const partly = !fromPhotos && text.state.status === "ready" ? textlessNote(text.state.value) : null;
  const formulasLost = text.state.status === "ready" && text.state.value.formulasLost === true;
  return (
    <PreviewFrame title={title} file={file} onBack={onBack}>
      {fromPhotos ? (
        <div className="mb-4 flex max-w-3xl gap-2.5 text-sm leading-relaxed" role="note" data-testid="pdf-from-photos">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
          <p>
            <span className="font-medium">Made from your photos.</span> <span className="text-muted">{MADE_FROM_PHOTOS_NOTE}</span>
          </p>
        </div>
      ) : null}
      {noText ? (
        <div className="mb-4 flex max-w-3xl gap-2.5 text-sm leading-relaxed" role="note" data-testid="pdf-no-text">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
          <p>
            <span className="font-medium">This PDF has no text Studiplan can read.</span>{" "}
            <span className="text-muted">
              It looks like a scan: its pages are pictures. Claude Code and an AI used with an API key can read a
              scan of up to 20 pages; a longer one, and any scan with Codex or Ollama, is left out of what you
              make. Adding photos of the pages always works.
            </span>
          </p>
        </div>
      ) : null}
      {partly ? (
        <div className="mb-4 flex max-w-3xl gap-2.5 text-sm leading-relaxed" role="note" data-testid="pdf-partly-scanned">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
          <p>
            <span className="font-medium">{partly.title}</span> <span className="text-muted">{partly.body}</span>
          </p>
        </div>
      ) : null}
      {formulasLost ? (
        <div className="mb-4 flex max-w-3xl gap-2.5 text-sm leading-relaxed" role="note" data-testid="pdf-formulas-lost">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
          <p className="text-muted">{FORMULAS_LOST_NOTE}</p>
        </div>
      ) : null}
      {/* The viewer brings its own dark toolbar; a hairline and the app's radius seat it in the page. */}
      <div className="relative mb-8 min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-surface-secondary">
        {/* Shows through until the viewer has drawn itself over it. */}
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
          Opening {file.name}…
        </p>
        {/* No sandbox attribute: the built-in viewer does not start inside one. */}
        <iframe
          // Starts without the viewer's page list, so the page itself gets the width.
          src={`${previewUrl(material, file.name)}#navpanes=0`}
          title={file.name}
          data-testid="pdf-frame"
          className="relative block h-full w-full border-0"
        />
      </div>
    </PreviewFrame>
  );
}

/* ── Photos ──────────────────────────────────────────────────────────────────────────────── */

function PhotoSetPreview({ material, title, file, onBack }: PreviewProps) {
  const pages = file.pages ?? [];
  /** Index of the page shown large, or `null` for the grid of all pages. */
  const [open, setOpen] = useState<number | null>(pages.length === 1 ? 0 : null);
  const hasGrid = pages.length > 1;
  /** The large view at the photo's own size, to read small handwriting; otherwise fitted to the area. */
  const [zoomed, setZoomed] = useState(false);
  const current = open !== null && open < pages.length ? open : null;

  useEscape(() => {
    if (current !== null && hasGrid) setOpen(null);
    else onBack();
  });

  useEffect(() => {
    if (current === null) return;
    const listen = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft") setOpen(Math.max(0, current - 1));
      else if (event.key === "ArrowRight") setOpen(Math.min(pages.length - 1, current + 1));
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, [current, pages.length]);

  if (pages.length === 0) {
    return (
      <PreviewFrame title={title} file={file} onBack={onBack}>
        <p className="border-t border-separator pt-6 text-sm text-muted">This photo set has no pages.</p>
      </PreviewFrame>
    );
  }

  if (current === null) {
    return (
      <PreviewFrame title={title} file={file} onBack={onBack}>
        <div className="scrollbar -mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-10">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-5 gap-y-6" aria-label="Pages">
            {pages.map((page, index) => (
              <li key={page}>
                <Button
                  variant="ghost"
                  className="group flex h-auto w-full flex-col items-stretch gap-2 rounded-md p-0 text-left hover:bg-transparent"
                  aria-label={`Open page ${index + 1}`}
                  onPress={() => setOpen(index)}
                >
                  <Photo
                    src={previewUrl(material, file.name, page)}
                    className="aspect-[3/4] w-full rounded-md border border-border object-cover transition-[border-color] duration-100 ease-out group-hover:border-foreground motion-reduce:transition-none"
                  />
                  <span className="px-0.5 text-xs font-normal text-muted tabular-nums">Page {index + 1}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </PreviewFrame>
    );
  }

  const pageName = pages[current] ?? "";
  return (
    <PreviewFrame
      title={title}
      file={file}
      onBack={onBack}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted"
            aria-pressed={zoomed}
            onPress={() => setZoomed((now) => !now)}
          >
            {zoomed ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}
            {zoomed ? "Fit to window" : "Actual size"}
          </Button>
          {hasGrid ? (
            <Button variant="ghost" size="sm" className="mr-3 text-muted" onPress={() => setOpen(null)}>
              <LayoutGrid aria-hidden />
              All pages
            </Button>
          ) : null}
          {hasGrid ? (
            <>
              <IconButton
                label="Previous page"
                tooltip="Previous page (←)"
                isDisabled={current === 0}
                onPress={() => setOpen(current - 1)}
              >
                <ChevronLeft aria-hidden />
              </IconButton>
              <p className="min-w-24 text-center text-sm tabular-nums" aria-live="polite">
                Page {current + 1} of {pages.length}
              </p>
              <IconButton
                label="Next page"
                tooltip="Next page (→)"
                isDisabled={current === pages.length - 1}
                onPress={() => setOpen(current + 1)}
              >
                <ChevronRight aria-hidden />
              </IconButton>
            </>
          ) : null}
        </>
      }
    >
      {/* A click on the photo does what the button does; the button is the keyboard's way. */}
      <div
        className={`scrollbar mb-8 min-h-0 flex-1 rounded-md border border-border bg-surface-secondary ${
          zoomed ? "cursor-zoom-out overflow-auto" : "cursor-zoom-in overflow-hidden"
        }`}
        data-testid="photo-stage"
        onClick={() => setZoomed((now) => !now)}
      >
        <Photo
          key={pageName}
          eager
          src={previewUrl(material, file.name, pageName)}
          alt={`Page ${current + 1} of ${file.name}`}
          className={zoomed ? "mx-auto block max-w-none" : "h-full w-full object-contain"}
          testId="photo-large"
        />
      </div>
    </PreviewFrame>
  );
}

/** One photo page. If it cannot be loaded, the same box says so instead of showing a broken image. */
export function Photo({
  src,
  alt = "",
  className,
  eager = false,
  testId,
}: {
  src: string;
  alt?: string;
  className: string;
  eager?: boolean;
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className={`flex items-center justify-center bg-surface-secondary p-2 text-center text-xs font-normal text-muted ${className}`}
      >
        This page could not be shown
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      data-testid={testId}
      onError={() => setFailed(true)}
      className={`bg-surface-secondary ${className}`}
    />
  );
}

/* ── Slides, as text ─────────────────────────────────────────────────────────────────────── */

function SlideTextPreview({ material, title, file, onBack }: PreviewProps) {
  useEscape(onBack);
  const { state, stop, retry } = useFileText(material, file.name);

  return (
    <PreviewFrame title={title} file={file} onBack={onBack}>
      <div className="scrollbar min-h-0 flex-1 overflow-y-auto border-t border-separator pb-16">
        <div className="max-w-[68ch] pt-6">
          {state.status === "reading" ? (
            <div className="flex items-end gap-4" data-testid="text-reading">
              <ProgressBar
                className="flex-1"
                size="sm"
                {...(state.fraction === null ? { isIndeterminate: true } : { value: state.fraction * 100 })}
              >
                <Label className="truncate">{state.message ?? "Reading the slides…"}</Label>
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <Button variant="outline" size="sm" onPress={stop}>
                Cancel
              </Button>
            </div>
          ) : null}

          {state.status === "stopped" ? (
            <div className="flex items-center justify-between gap-6">
              <p className="text-sm text-muted">Reading was cancelled. Nothing was changed.</p>
              <Button variant="outline" size="sm" onPress={retry}>
                Read again
              </Button>
            </div>
          ) : null}

          {state.status === "error" ? (
            isCalmTextError(state.error) ? (
              <div data-testid="text-error">
                <h2 className="text-base font-semibold">{textErrorTitle(state.error, "slide")}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{state.error.message}</p>
              </div>
            ) : (
              <div data-testid="text-error">
                <ErrorNotice
                  title={textErrorTitle(state.error, "slide")}
                  message={state.error.message}
                  {...(canRetryTextError(state.error) ? { onRetry: retry } : {})}
                />
              </div>
            )
          ) : null}

          {state.status === "ready" ? (
            <SlideText
              sections={splitSections(state.value.text)}
              count={state.value.readCount}
              note={[coverageNote(state.value), textlessNote(state.value)?.title ?? null].filter(Boolean).join(" ") || null}
            />
          ) : null}
        </div>
      </div>
    </PreviewFrame>
  );
}

function SlideText({
  sections,
  count,
  note,
}: {
  sections: TextSection[];
  count: number;
  note: string | null;
}) {
  return (
    <article data-testid="slide-text">
      <p className="text-sm leading-relaxed text-muted">
        This is the text of {count === 1 ? "the slide" : `the ${countInline(count, "slide")}`} and
        the speaker notes, not the slides themselves. Pictures, diagrams and layout are not shown.
      </p>

      {note ? (
        <Notice className="mt-5" title="Not everything is here">
          {note}
        </Notice>
      ) : null}

      <div className="mt-7 flex flex-col">
        {sections.map((section, index) => (
          <section key={index} className="border-t border-separator py-6 first:border-t-0 first:pt-0">
            {section.heading ? <SlideHeading heading={section.heading} /> : null}
            {section.body ? (
              <p className="mt-2 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap">
                {section.body}
              </p>
            ) : null}
            {section.notes ? (
              <div className="mt-4">
                <h3 className="text-sm font-medium">Speaker notes</h3>
                <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-muted">
                  {section.notes}
                </p>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}

/** "Slide 3: Phases of mitosis" with the number stepped back, so the titles read as an outline. */
function SlideHeading({ heading }: { heading: string }) {
  const at = heading.indexOf(": ");
  const number = at === -1 ? heading : heading.slice(0, at);
  const name = at === -1 ? "" : heading.slice(at + 2);
  return (
    <h2 className="text-base leading-6 font-semibold break-words">
      <span className={name ? "mr-1.5 font-normal text-muted tabular-nums" : "tabular-nums"}>{number}</span>
      {name ? ` ${name}` : null}
    </h2>
  );
}

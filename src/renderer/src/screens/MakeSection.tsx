import { Button, Label, ProgressBar, TextArea, TextField, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import type { MaterialRef } from "@shared/library";
import type { StudyError } from "@shared/results";
import { DEFAULT_TEST_WRITTEN, isMakeableKind, MAX_REQUEST } from "@shared/study";
import type { MakeableKind } from "@shared/study";
import { Notice } from "../components/Notice";
import { Section } from "../components/Page";
import { KIND_ICONS } from "../components/kind-icons";
import {
  MAKE_ACTIONS,
  MAKE_GROUPS,
  MAKE_HINTS,
  MAKE_LABELS,
  NO_SIZE_NOTE,
  WRITTEN_CHOICES,
  defaultSize,
  kindInSentence,
  makeOptions,
  makingTitle,
  sizeChoices,
  sizeLabel,
} from "../lib/make";
import { isFor } from "../study/use-generation";
import type { FinishedGeneration, Generation } from "../study/use-generation";

/**
 * Make: the middle of a material. Choose what to make, choose its size, press the one blue
 * button. The choice of kind and size is a selection ("you are here"), the button is the action.
 *
 * Six kinds, in the groups a student thinks in: three to read (summary, explanation, cheat
 * sheet), one to learn with (flashcards), one to test with (practice test), and the free request.
 *
 * It explains itself instead of failing: with no files it says to add some, with no AI chosen
 * its button leads to Settings, and while something is being made (here or in another
 * material: one at a time in the whole app) it shows that, with Cancel.
 */
export function MakeSection({
  material,
  title,
  hasFiles,
  hasPhotoPdf = false,
  aiChosen,
  aiLabel,
  generation,
  onOpenSettings,
  onOpenResult,
}: {
  material: MaterialRef;
  /** The material's title, for the progress line shown on other screens. */
  title: string;
  hasFiles: boolean;
  /** The material holds a photo set together with the PDF made from it: only the photos are sent. */
  hasPhotoPdf?: boolean;
  /** Whether an AI is chosen in Settings. `null` while that is being read. */
  aiChosen: boolean | null;
  /** The chosen AI's name, when known: "Claude Code". */
  aiLabel: string | null;
  generation: Generation;
  onOpenSettings: () => void;
  onOpenResult: (name: string) => void;
}) {
  const [kind, setKind] = useState<MakeableKind>("summary");
  /** The size chosen per kind; a kind not in here uses its default. */
  const [sizes, setSizes] = useState<Partial<Record<MakeableKind, string>>>({});
  /** A practice test: with written questions, or multiple choice only. */
  const [written, setWritten] = useState(DEFAULT_TEST_WRITTEN);
  const [request, setRequest] = useState("");
  const kindsLabel = useId();
  const sizeLabelId = useId();
  const writtenLabelId = useId();

  const { running, finished } = generation;
  const runningHere = isFor(material, running);
  const size = sizes[kind] ?? defaultSize(kind);
  const options = makeOptions(kind, size, request, written);
  const choices = sizeChoices(kind);
  const tooLong = request.trim().length > MAX_REQUEST;

  const make = () => {
    if (options === null) return;
    generation.start(material, title, { kind, options });
  };

  return (
    <Section title="Make">
      {finished && isFor(material, finished) ? (
        <Outcome
          finished={finished}
          onDismiss={generation.dismiss}
          onOpenSettings={onOpenSettings}
          onOpen={onOpenResult}
        />
      ) : null}

      {!hasFiles ? (
        <p className="max-w-xl text-sm leading-relaxed text-muted" data-testid="make-needs-files">
          Add files first. A summary, a cheat sheet, flashcards or a practice test is made from the
          files in this material, and saved here next to them.
        </p>
      ) : (
        <div className="flex flex-col gap-5" data-testid="make">
          <div className="flex flex-col gap-3">
            <p id={kindsLabel} className="sr-only">
              What to make
            </p>
            {/* One choice among six, standing in the groups a student thinks in: read, learn, test,
                and the free request set apart. The groups wrap as wholes in a narrow window. */}
            <ToggleButtonGroup
              aria-labelledby={kindsLabel}
              isDetached
              selectionMode="single"
              disallowEmptySelection
              isDisabled={running !== null}
              className="flex-wrap items-end justify-start gap-x-6 gap-y-3"
              selectedKeys={[kind]}
              onSelectionChange={(keys) => {
                const [key] = [...keys];
                if (isMakeableKind(key)) setKind(key);
              }}
            >
              {MAKE_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-1.5" data-make-group={group.label}>
                  <p className="text-xs font-medium text-muted">{group.label}</p>
                  <div className="flex gap-2">
                    {group.kinds.map((item) => {
                      const Icon = KIND_ICONS[item];
                      return (
                        <ToggleButton key={item} id={item}>
                          <Icon aria-hidden />
                          {MAKE_LABELS[item]}
                        </ToggleButton>
                      );
                    })}
                  </div>
                </div>
              ))}
            </ToggleButtonGroup>
            <p className="text-sm leading-relaxed text-muted" data-testid="make-hint">
              {MAKE_HINTS[kind]}
            </p>
          </div>

          {running !== null ? (
            <Progress
              title={
                runningHere
                  ? makingTitle(running.kind)
                  : `${capitalise(kindInSentence(running.kind))} ${running.kind === "flashcards" ? "are" : "is"} being made in “${running.title}”`
              }
              detail={runningHere ? null : "One result is made at a time. You can make another when this one is done."}
              message={running.message}
              onCancel={generation.cancel}
            />
          ) : (
            <>
              {kind === "custom" ? (
                <TextField
                  fullWidth
                  value={request}
                  onChange={setRequest}
                  isInvalid={tooLong}
                  className="max-w-[40rem]"
                >
                  <Label>What should it make?</Label>
                  <TextArea
                    fullWidth
                    rows={3}
                    dir="auto"
                    placeholder="A timeline of the events, with one line on why each mattered"
                    className="resize-y text-[0.9375rem] leading-6"
                  />
                  <p className={`text-xs tabular-nums ${tooLong ? "font-medium text-danger" : "text-muted"}`}>
                    {tooLong
                      ? `That is ${request.trim().length} characters. Keep it under ${MAX_REQUEST}.`
                      : "The result is saved in this material, like the others."}
                  </p>
                </TextField>
              ) : (
                // As tall as the kind with the most to choose (a practice test: two lines), so the
                // Make button below does not move when another kind is picked.
                <div className="flex min-h-[4.75rem] flex-col gap-3" data-testid="make-options">
                  {choices.length === 0 ? (
                    <p className="flex min-h-8 items-center text-sm text-muted">{NO_SIZE_NOTE}</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <p id={sizeLabelId} className="w-20 text-sm font-medium">
                        {sizeLabel(kind)}
                      </p>
                      <ToggleButtonGroup
                        aria-labelledby={sizeLabelId}
                        isDetached
                        size="sm"
                        selectionMode="single"
                        disallowEmptySelection
                        className="flex-wrap justify-start gap-1.5"
                        selectedKeys={size === null ? [] : [size]}
                        onSelectionChange={(keys) => {
                          const [key] = [...keys];
                          if (typeof key === "string") setSizes((current) => ({ ...current, [kind]: key }));
                        }}
                      >
                        {choices.map((choice) => (
                          <ToggleButton key={choice.id} id={choice.id} className="tabular-nums">
                            {choice.label}
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    </div>
                  )}
                  {kind === "test" ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <p id={writtenLabelId} className="w-20 text-sm font-medium">
                        Questions
                      </p>
                      <ToggleButtonGroup
                        aria-labelledby={writtenLabelId}
                        isDetached
                        size="sm"
                        selectionMode="single"
                        disallowEmptySelection
                        className="flex-wrap justify-start gap-1.5"
                        selectedKeys={[written ? "written" : "choice"]}
                        onSelectionChange={(keys) => {
                          const [key] = [...keys];
                          if (typeof key === "string") setWritten(key === "written");
                        }}
                      >
                        {WRITTEN_CHOICES.map((choice) => (
                          <ToggleButton key={choice.id} id={choice.id}>
                            {choice.label}
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    </div>
                  ) : null}
                </div>
              )}

              {aiChosen === false ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="make-needs-ai">
                  <Button variant="primary" onPress={onOpenSettings}>
                    Connect your AI
                  </Button>
                  <p className="text-sm text-muted">
                    Studiplan is free and works with your own AI. Connecting it takes a minute in Settings.
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button variant="primary" onPress={make} isDisabled={options === null || aiChosen === null}>
                    {MAKE_ACTIONS[kind]}
                  </Button>
                  {aiLabel ? (
                    <p className="text-sm text-muted">
                      With {aiLabel}. Your files are sent to it when you press the button.
                      {hasPhotoPdf ? <span data-testid="make-pdf-not-sent"> The PDF of your photos is not sent again.</span> : null}
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Pressing Make replaces the button with the progress, and the end replaces the progress with
 * a message: each time the thing that had the focus is gone. This hands the focus to the next
 * thing to press (Cancel, then Open), unless the student has moved it somewhere else meanwhile.
 */
function useTakeLostFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      ref.current?.focus({ preventScroll: true });
    }
  }, [ref]);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Progress({
  title,
  detail,
  message,
  onCancel,
}: {
  title: string;
  detail: string | null;
  message: string | null;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useTakeLostFocus(cancel);
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3" data-testid="make-progress">
      <ProgressBar isIndeterminate size="sm" className="min-w-64 flex-1">
        <Label className="flex flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          {/* The sentence changes as the work moves on; it keeps its line so nothing jumps. */}
          <span className="min-h-5 font-normal text-muted tabular-nums" aria-live="polite">
            {message ?? "Starting…"}
          </span>
        </Label>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <Button ref={cancel} variant="outline" onPress={onCancel}>
        Cancel
      </Button>
      {detail ? <p className="basis-full text-sm text-muted">{detail}</p> : null}
    </div>
  );
}

/** How the last generation in this material ended. Stays until it is closed or another starts. */
function Outcome({
  finished,
  onDismiss,
  onOpenSettings,
  onOpen,
}: {
  finished: FinishedGeneration;
  onDismiss: () => void;
  onOpenSettings: () => void;
  onOpen: (name: string) => void;
}) {
  const { result } = finished;
  const first = useRef<HTMLButtonElement>(null);
  useTakeLostFocus(first);

  if (!result.ok) {
    if (result.error.code === "cancelled") {
      return (
        <Notice role="status" testId="make-outcome" title="Cancelled. Nothing was saved." onClose={onDismiss} closeRef={first} />
      );
    }
    return <Failure error={result.error} onDismiss={onDismiss} onOpenSettings={onOpenSettings} closeRef={first} />;
  }

  const { result: saved, notices, warnings } = result.value;
  const notes = notices.length + warnings.length;
  return (
    <Notice
      role="status"
      testId="make-outcome"
      title={`“${saved.title}” is saved in Results`}
      action={
        <Button ref={first} variant="outline" size="sm" onPress={() => onOpen(saved.name)}>
          Open
        </Button>
      }
      onClose={onDismiss}
    >
        {notes > 0 ? (
          <div className="flex flex-col gap-1 text-sm leading-relaxed text-muted">
            {/* Said once, here: the notices are not stored with the result. */}
            {notices.length > 0 ? (
              <p className="text-foreground">Not everything in the material was sent to the AI:</p>
            ) : null}
            <ul className="flex flex-col gap-1">
              {[...notices, ...warnings].map((note, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
    </Notice>
  );
}

function Failure({
  error,
  onDismiss,
  onOpenSettings,
  closeRef,
}: {
  error: StudyError;
  onDismiss: () => void;
  onOpenSettings: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  const needsAi = error.code === "no-provider" || error.code === "not-installed" || error.code === "not-signed-in";
  return (
    <Notice
      status="danger"
      role="alert"
      testId="make-outcome"
      title="Nothing was made"
      action={
        needsAi ? (
          <Button variant="outline" size="sm" onPress={onOpenSettings}>
            Open Settings
          </Button>
        ) : null
      }
      onClose={onDismiss}
      closeRef={closeRef}
    >
      <>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">{error.message}</p>
        {error.details && error.details.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm leading-relaxed text-muted">
            {error.details.map((detail, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                {detail}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    </Notice>
  );
}

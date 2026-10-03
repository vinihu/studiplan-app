import { Button, CloseButton, Spinner } from "@heroui/react";
import { useState } from "react";
import type { MaterialRef } from "@shared/library";
import { kindInSentence } from "../lib/make";
import type { FinishedGeneration, Generation } from "../study/use-generation";

/**
 * The block in the sidebar: a hairline as wide as the rows, and text that starts where the rows'
 * text starts. Its buttons are the small outline ones the same actions have on a material's screen.
 */
const BOX = "mx-3 mb-1 flex border-t border-separator px-2 pt-3 pb-2";

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What is being made right now, in the frame, so it can be seen and stopped from every screen;
 * and how the last one ended, when the student was somewhere else at the time, until it is put
 * away. Nothing is shown when nothing is going on. The material's own screen says the same in
 * its Make section, so there this only shows the progress.
 */
export function GenerationStatus({
  generation,
  viewing,
  onOpenResult,
  onOpenMaterial,
}: {
  generation: Generation;
  /**
   * The material the student is in right now (its own screen or one of its results), or `null`.
   * Its Make section shows the outcome itself, so an outcome met there is not repeated here.
   */
  viewing: MaterialRef | null;
  onOpenResult: (ref: MaterialRef, name: string) => void;
  onOpenMaterial: (ref: MaterialRef) => void;
}) {
  const { running, finished } = generation;
  /** The outcome the student has already met in its own material. */
  const [seen, setSeen] = useState<FinishedGeneration | null>(null);
  const there =
    finished !== null && viewing !== null && viewing.subject === finished.ref.subject && viewing.material === finished.ref.material;
  if (there && seen !== finished) setSeen(finished);

  if (running !== null) {
    return (
      <div className={`${BOX} flex-col gap-2`} data-testid="generation-status" role="status">
        <p className="flex items-start gap-2 text-xs leading-relaxed">
          <Spinner size="sm" color="accent" className="mt-0.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Making {kindInSentence(running.kind)} in “{running.title}”
          </span>
        </p>
        <Button variant="outline" size="sm" className="self-start" onPress={generation.cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  if (finished === null) return null;
  const { ref, result, title, kind } = finished;
  // A cancel was the student's own doing, and the material's screen shows its own outcome.
  if (!result.ok && result.error.code === "cancelled") return null;
  if (there || seen === finished) return null;

  return (
    <div className={`${BOX} items-start gap-1`} data-testid="generation-status" role="status">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-xs leading-relaxed [overflow-wrap:anywhere]">
          {result.ok
            ? `${capitalise(kindInSentence(kind))} ${kind === "flashcards" ? "are" : "is"} saved in “${title}”`
            : `Nothing was made in “${title}”`}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onPress={() => {
            if (result.ok) {
              onOpenResult(ref, result.value.result.name);
              generation.dismiss();
            } else onOpenMaterial(ref);
          }}
        >
          {result.ok ? "Open" : "See why"}
        </Button>
      </div>
      <CloseButton aria-label="Close this message" onPress={generation.dismiss} />
    </div>
  );
}

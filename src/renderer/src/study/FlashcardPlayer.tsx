import { Button, Kbd, ProgressBar, ToggleButton } from "@heroui/react";
import { ArrowLeft, ArrowRight, Check, RotateCcw, Shuffle } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { RefObject } from "react";
import type { Flashcard } from "@shared/study";
import { IconButton } from "../components/IconButton";
import { createDeck, currentCard, deckReducer, missedCards, tally } from "./deck";
import type { DeckState } from "./deck";
import { plural } from "./describe";

/**
 * Flashcards, one at a time. The rules of a round live in `deck.ts`; this is the screen for them.
 *
 * Keys, shown under the card: Space or Enter flips, ← and → move, and once the answer is
 * showing 1 marks "again" and 2 marks "got it". They work while focus is on the card or
 * nowhere in particular, and are left alone while it is in the sidebar, a field or a dialog.
 * Space and Enter on a button press that button, as they always do.
 *
 * Focus: the card is the home. Showing the answer or marking a card replaces the buttons under
 * it, so focus goes back to the card rather than being dropped; the end of a round moves it to
 * the result, and a new round back to the card.
 *
 * Card text is plain text, not Markdown: text nodes with line breaks kept.
 */
export function FlashcardPlayer({ cards }: { cards: readonly Flashcard[] }) {
  const [state, dispatch] = useReducer(deckReducer, cards.length, createDeck);
  const root = useRef<HTMLElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLHeadingElement>(null);

  const focusCard = useCallback(() => face.current?.focus({ preventScroll: true }), []);

  // A deck opens with the focus on its first card, so Space flips it straight away. (The screen
  // would otherwise put the focus on its heading, which yields to whatever already has it.)
  useEffect(() => {
    face.current?.focus({ preventScroll: true });
  }, []);
  const flip = useCallback(() => dispatch({ type: "flip" }), []);

  // The end of a round and the start of the next one each replace what is on screen.
  const wasFinished = useRef(state.finished);
  useEffect(() => {
    if (wasFinished.current === state.finished) return;
    wasFinished.current = state.finished;
    if (state.finished) result.current?.focus();
    else focusCard();
  }, [state.finished, focusCard]);

  useEffect(() => {
    if (state.finished) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Only when focus is in the player, on the screen's heading or nowhere: the sidebar's list
      // has its own arrow keys.
      const here =
        target === null || target === document.body || target.tagName === "H1" || root.current?.contains(target) === true;
      if (!here) return;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog'], [role='alertdialog']")) return;
      const onControl = target?.closest("button, a") != null;

      if ((event.key === " " || event.key === "Enter") && !onControl) dispatch({ type: "flip" });
      else if (event.key === "ArrowRight") dispatch({ type: "next" });
      else if (event.key === "ArrowLeft") dispatch({ type: "previous" });
      else if (event.key === "1" && state.flipped) dispatch({ type: "mark", mark: "again" });
      else if (event.key === "2" && state.flipped) dispatch({ type: "mark", mark: "got" });
      else return;
      event.preventDefault();
      // A key can remove the button that had focus (marking with 1 while on "Again").
      if (onControl) focusCard();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state.finished, state.flipped, focusCard]);

  if (state.finished) {
    return (
      <section ref={root} aria-label="Flashcards" className="flex flex-col gap-5">
        <RoundResult state={state} headingRef={result} onAction={dispatch} />
      </section>
    );
  }

  const card = cards[currentCard(state)] ?? { front: "", back: "" };
  const total = state.order.length;
  const mark = state.marks[currentCard(state)];
  const side = state.flipped ? "Answer" : "Question";
  const text = state.flipped ? card.back : card.front;
  const isLast = state.position === total - 1;

  return (
    <section ref={root} aria-label="Flashcards" className="flex flex-col gap-5">
      {/* A div, not a <button>: the text on a card can be selected and copied. */}
      <div
        ref={face}
        role="button"
        tabIndex={0}
        aria-keyshortcuts="Space"
        onClick={() => {
          // Dragging to select text ends in a click too; that is not a flip.
          if (window.getSelection()?.toString()) return;
          flip();
        }}
        // Like a photo's tile: something large that acts answers the pointer with its border, not a fill.
        className="flex min-h-80 cursor-pointer flex-col rounded-md border border-border bg-surface px-10 pt-5 pb-10 outline-none transition-[border-color] duration-100 ease-out hover:border-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
      >
        <div className="flex items-center justify-between gap-4 text-xs font-medium text-muted">
          <span>{side}</span>
          {mark ? <span>Marked {mark === "got" ? "got it" : "again"}</span> : null}
        </div>
        <div className="flex flex-1 items-center justify-center pt-5">
          <CardText text={text} side={state.flipped ? "back" : "front"} />
        </div>
      </div>
      <p className="sr-only" role="status">
        {side}: {text}
      </p>

      <div className="flex items-center justify-between gap-4">
        {/* As tall as the buttons between them. */}
        <IconButton
          size="md"
          label="Previous card"
          tooltip="Previous card (←)"
          isDisabled={state.position === 0}
          onPress={() => dispatch({ type: "previous" })}
        >
          <ArrowLeft aria-hidden />
        </IconButton>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {state.flipped ? (
            <>
              <Button
                variant="outline"
                className="min-w-28"
                onPress={() => {
                  dispatch({ type: "mark", mark: "again" });
                  focusCard();
                }}
              >
                <RotateCcw aria-hidden className="text-muted" />
                Again
              </Button>
              <Button
                variant="outline"
                className="min-w-28"
                onPress={() => {
                  dispatch({ type: "mark", mark: "got" });
                  focusCard();
                }}
              >
                <Check aria-hidden className="text-muted" />
                Got it
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              className="min-w-36"
              onPress={() => {
                flip();
                focusCard();
              }}
            >
              Show answer
            </Button>
          )}
        </div>

        <IconButton
          size="md"
          label={isLast ? "Finish the round" : "Next card"}
          tooltip={isLast ? "Finish the round (→)" : "Next card (→)"}
          onPress={() => dispatch({ type: "next" })}
        >
          <ArrowRight aria-hidden />
        </IconButton>
      </div>

      {/* Shown above the card, but after it for the keyboard: Tab goes from the card to its buttons, and only then to Shuffle. */}
      <div className="order-first flex flex-col gap-3">
        <div className="flex min-h-9 items-center justify-between gap-6">
          <p className="text-sm tabular-nums">
            <span className="font-medium">
              Card {state.position + 1} of {total}
            </span>
            {state.pass > 1 ? <span className="text-muted"> · the ones you missed</span> : null}
          </p>
          <ToggleButton
            size="sm"
            variant="ghost"
            isSelected={state.shuffled}
            onChange={(on) => dispatch({ type: "shuffle", on, seed: newSeed() })}
          >
            <Shuffle aria-hidden />
            Shuffle
          </ToggleButton>
        </div>
        <ProgressBar
          aria-label="Cards done in this round"
          size="sm"
          color="accent"
          value={state.position}
          maxValue={total}
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      </div>

      <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted">
        <Hint keys={["Space"]}>flip</Hint>
        <Hint keys={["←", "→"]}>move</Hint>
        <Hint keys={["1"]}>again</Hint>
        <Hint keys={["2"]}>got it</Hint>
      </p>
    </section>
  );
}

function newSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/**
 * One side of a card. A short side is set large and centred, like a card; a long one (a side
 * can hold 2,000 characters) or one with its own line breaks is set as reading text.
 */
function CardText({ text, side }: { text: string; side: "front" | "back" }) {
  const long = text.length > 140 || text.includes("\n");
  const size = long
    ? "text-base leading-7 text-start"
    : side === "front"
      ? "text-2xl leading-9 font-semibold tracking-tight text-center text-balance"
      : "text-xl leading-8 text-center text-balance";
  return (
    <p dir="auto" className={`w-full max-w-[65ch] whitespace-pre-line [overflow-wrap:anywhere] ${size}`}>
      {text}
    </p>
  );
}

function Hint({ keys, children }: { keys: string[]; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {keys.map((key) => (
        <Kbd key={key} className="h-5 min-w-5 justify-center px-1.5 text-xs">
          {key}
        </Kbd>
      ))}
      {children}
    </span>
  );
}

function RoundResult({
  state,
  headingRef,
  onAction,
}: {
  state: DeckState;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onAction: (action: { type: "redo-missed" | "start-over"; seed: number }) => void;
}) {
  const { cards, got, again, skipped } = tally(state);
  const missed = missedCards(state).length;
  const details = [
    again > 0 ? `${again} to go again` : null,
    skipped > 0 ? `${skipped} skipped` : null,
  ].filter(Boolean);

  return (
    <div className="flex min-h-80 flex-col items-start justify-center rounded-md border border-border bg-surface px-10 py-10">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl leading-9 font-semibold tracking-tight tabular-nums outline-none"
      >
        You got {got} of {cards}
      </h2>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted" role="status">
        {missed === 0
          ? state.pass > 1
            ? "That was the last of the ones you missed."
            : "Every card in the deck."
          : `${details.join(", ")}.`}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        {missed > 0 ? (
          <Button variant="primary" onPress={() => onAction({ type: "redo-missed", seed: newSeed() })}>
            Redo the {missed === 1 ? "one" : missed} you missed
          </Button>
        ) : null}
        <Button
          variant={missed > 0 ? "outline" : "primary"}
          onPress={() => onAction({ type: "start-over", seed: newSeed() })}
        >
          <RotateCcw aria-hidden />
          Start over with {state.total === 1 ? "the card" : `all ${plural(state.total, "card")}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * A round of flashcards as a state machine. Pure: no DOM, no clock, no `Math.random`.
 *
 * A round is a set of cards (all of them, or the ones missed last time) shown in some order,
 * one at a time. Each card can be flipped and marked "got it" or "again"; marking moves on, and
 * moving past the last card ends the round. From the end, the student redoes the cards they did
 * not get, or starts over with all of them. Nothing here is kept between sessions and nothing
 * is scheduled: there is no spaced repetition.
 *
 * Shuffling takes its randomness from a seed carried by the action, so the reducer stays pure
 * (React may run it twice) and a test can say exactly what a shuffle does.
 */

export type Mark = "got" | "again";

export interface DeckState {
  /** How many cards the deck has. Cards are known by their index, 0 … total-1. */
  readonly total: number;
  /** The cards of this round in the order they were written. */
  readonly round: readonly number[];
  /** The same cards in the order they are shown. */
  readonly order: readonly number[];
  readonly shuffled: boolean;
  /** Index into `order` of the card on screen. */
  readonly position: number;
  /** Whether the back is showing. */
  readonly flipped: boolean;
  /** This round's marks, by card. */
  readonly marks: Readonly<Record<number, Mark>>;
  readonly finished: boolean;
  /** 1 for the first pass, counting up with every redo. Start over returns to 1. */
  readonly pass: number;
}

export type DeckAction =
  | { type: "flip" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "mark"; mark: Mark }
  /** Turns shuffle on (with a seed for the order) or off. */
  | { type: "shuffle"; on: boolean; seed: number }
  /** A new round of the cards not marked "got it". Ignored when there are none. */
  | { type: "redo-missed"; seed: number }
  | { type: "start-over"; seed: number };

export function createDeck(total: number): DeckState {
  const all = range(total);
  return {
    total,
    round: all,
    order: all,
    shuffled: false,
    position: 0,
    flipped: false,
    marks: {},
    finished: false,
    pass: 1,
  };
}

function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

/** A small seeded generator (mulberry32): the same seed always gives the same sequence. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates. Returns a new array; with two or more cards the order always changes. */
export function shuffle(list: readonly number[], seed: number): number[] {
  const next = [...list];
  if (next.length < 2) return next;
  const random = generator(seed);
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = next[i];
    const b = next[j];
    if (a !== undefined && b !== undefined) {
      next[i] = b;
      next[j] = a;
    }
  }
  // A shuffle that changes nothing reads as a button that does nothing.
  if (next.every((card, i) => card === list[i])) {
    const head = next.shift();
    if (head !== undefined) next.push(head);
  }
  return next;
}

function newRound(state: DeckState, cards: readonly number[], pass: number, seed: number): DeckState {
  return {
    ...state,
    round: cards,
    order: state.shuffled ? shuffle(cards, seed) : cards,
    position: 0,
    flipped: false,
    marks: {},
    finished: false,
    pass,
  };
}

function goTo(state: DeckState, position: number): DeckState {
  if (position < 0) return state;
  if (position >= state.order.length) return { ...state, finished: true, flipped: false };
  return { ...state, position, flipped: false };
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "flip":
      return state.finished ? state : { ...state, flipped: !state.flipped };

    case "next":
      return state.finished ? state : goTo(state, state.position + 1);

    case "previous":
      return state.finished ? state : goTo(state, state.position - 1);

    case "mark": {
      if (state.finished) return state;
      const card = currentCard(state);
      return goTo({ ...state, marks: { ...state.marks, [card]: action.mark } }, state.position + 1);
    }

    case "shuffle": {
      if (state.finished) return { ...state, shuffled: action.on };
      // Nothing has happened yet: shuffle the whole round, so the first card changes too.
      const untouched = state.position === 0 && !state.flipped && Object.keys(state.marks).length === 0;
      if (untouched) {
        return {
          ...state,
          shuffled: action.on,
          order: action.on ? shuffle(state.round, action.seed) : state.round,
        };
      }
      // Mid-round: the cards already seen and the one on screen stay put; only what is still to
      // come is reordered. Nothing the student has done is lost.
      const seen = state.order.slice(0, state.position + 1);
      const rest = state.order.slice(state.position + 1);
      const restInOrder = state.round.filter((card) => rest.includes(card));
      return {
        ...state,
        shuffled: action.on,
        order: [...seen, ...(action.on ? shuffle(restInOrder, action.seed) : restInOrder)],
      };
    }

    case "redo-missed": {
      const missed = missedCards(state);
      return missed.length === 0 ? state : newRound(state, missed, state.pass + 1, action.seed);
    }

    case "start-over":
      return newRound(state, range(state.total), 1, action.seed);
  }
}

/* ------------------------------------------------------------------ *
 * Reading a state
 * ------------------------------------------------------------------ */

/** The card on screen, as an index into the deck. */
export function currentCard(state: DeckState): number {
  return state.order[state.position] ?? 0;
}

/** The cards of this round not marked "got it": marked "again", or passed without a mark. */
export function missedCards(state: DeckState): number[] {
  return state.round.filter((card) => state.marks[card] !== "got");
}

export interface DeckTally {
  /** Cards in this round. */
  cards: number;
  got: number;
  again: number;
  /** Passed with the arrow keys without a mark. */
  skipped: number;
}

export function tally(state: DeckState): DeckTally {
  let got = 0;
  let again = 0;
  for (const card of state.round) {
    if (state.marks[card] === "got") got++;
    else if (state.marks[card] === "again") again++;
  }
  return { cards: state.round.length, got, again, skipped: state.round.length - got - again };
}

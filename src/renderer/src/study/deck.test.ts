import { describe, expect, it } from "vitest";
import { createDeck, currentCard, deckReducer, missedCards, shuffle, tally } from "./deck";
import type { DeckAction, DeckState } from "./deck";

function run(state: DeckState, ...actions: DeckAction[]): DeckState {
  return actions.reduce(deckReducer, state);
}

const flip: DeckAction = { type: "flip" };
const next: DeckAction = { type: "next" };
const previous: DeckAction = { type: "previous" };
const got: DeckAction = { type: "mark", mark: "got" };
const again: DeckAction = { type: "mark", mark: "again" };

describe("a new deck", () => {
  it("starts on the first card, front up, in the written order", () => {
    const deck = createDeck(4);
    expect(deck).toMatchObject({ total: 4, order: [0, 1, 2, 3], position: 0, flipped: false, finished: false, pass: 1 });
    expect(currentCard(deck)).toBe(0);
  });
});

describe("flipping and moving", () => {
  it("flips there and back", () => {
    expect(run(createDeck(3), flip).flipped).toBe(true);
    expect(run(createDeck(3), flip, flip).flipped).toBe(false);
  });

  it("shows the front of the card it moves to", () => {
    const deck = run(createDeck(3), flip, next);
    expect(deck).toMatchObject({ position: 1, flipped: false });
    expect(run(deck, flip, previous)).toMatchObject({ position: 0, flipped: false });
  });

  it("stays on the first card when going back from it", () => {
    const deck = run(createDeck(3), flip);
    expect(run(deck, previous)).toBe(deck);
  });

  it("ends the round when moving past the last card", () => {
    const deck = run(createDeck(2), next, next);
    expect(deck.finished).toBe(true);
    expect(tally(deck)).toEqual({ cards: 2, got: 0, again: 0, skipped: 2 });
  });

  it("ignores everything but a new round once finished", () => {
    const done = run(createDeck(1), got);
    expect(run(done, flip, next, previous, again)).toBe(done);
  });
});

describe("again / got it", () => {
  it("marks the card on screen and moves on", () => {
    const deck = run(createDeck(3), flip, got, flip, again);
    expect(deck).toMatchObject({ position: 2, flipped: false, marks: { 0: "got", 1: "again" } });
  });

  it("ends the round on the last mark", () => {
    const deck = run(createDeck(3), got, again, got);
    expect(deck.finished).toBe(true);
    expect(tally(deck)).toEqual({ cards: 3, got: 2, again: 1, skipped: 0 });
    expect(missedCards(deck)).toEqual([1]);
  });

  it("lets a mark be changed by going back", () => {
    const deck = run(createDeck(2), again, previous, got);
    expect(deck.marks).toEqual({ 0: "got" });
  });

  it("counts a card passed without a mark as missed", () => {
    const deck = run(createDeck(3), got, next, again);
    expect(tally(deck)).toEqual({ cards: 3, got: 1, again: 1, skipped: 1 });
    expect(missedCards(deck)).toEqual([1, 2]);
  });
});

describe("redo the missed ones", () => {
  it("starts a round of only the cards not marked got it, in their written order", () => {
    const first = run(createDeck(5), got, again, got, next, again);
    const second = run(first, { type: "redo-missed", seed: 1 });
    expect(second).toMatchObject({ round: [1, 3, 4], order: [1, 3, 4], position: 0, flipped: false, finished: false, pass: 2, marks: {} });
  });

  it("narrows round by round until nothing is missed", () => {
    const second = run(createDeck(3), again, again, got, { type: "redo-missed", seed: 1 });
    expect(second.round).toEqual([0, 1]);
    const third = run(second, got, again, { type: "redo-missed", seed: 1 });
    expect(third).toMatchObject({ round: [1], pass: 3 });
    const done = run(third, got);
    expect(missedCards(done)).toEqual([]);
    expect(run(done, { type: "redo-missed", seed: 1 })).toBe(done);
  });

  it("counts only the round's own cards in the result", () => {
    const second = run(createDeck(4), got, got, again, again, { type: "redo-missed", seed: 1 }, got, again);
    expect(tally(second)).toEqual({ cards: 2, got: 1, again: 1, skipped: 0 });
  });
});

describe("start over", () => {
  it("brings back every card and forgets the marks", () => {
    const deck = run(createDeck(3), again, again, got, { type: "redo-missed", seed: 1 }, got, { type: "start-over", seed: 1 });
    expect(deck).toMatchObject({ round: [0, 1, 2], order: [0, 1, 2], position: 0, finished: false, pass: 1, marks: {} });
  });

  it("keeps shuffle on, with a new order", () => {
    const shuffled = run(createDeck(12), { type: "shuffle", on: true, seed: 5 });
    const over = run(shuffled, got, { type: "start-over", seed: 6 });
    expect(over.shuffled).toBe(true);
    expect([...over.order].sort((a, b) => a - b)).toEqual(over.round);
    expect(over.order).not.toEqual(over.round);
  });
});

describe("shuffle", () => {
  it("is a permutation, the same for the same seed and different for another", () => {
    const list = Array.from({ length: 12 }, (_, i) => i);
    const a = shuffle(list, 42);
    expect([...a].sort((x, y) => x - y)).toEqual(list);
    expect(shuffle(list, 42)).toEqual(a);
    expect(shuffle(list, 43)).not.toEqual(a);
    expect(list).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("always changes the order of two or more cards", () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(shuffle([0, 1], seed)).toEqual([1, 0]);
      expect(shuffle([0, 1, 2], seed)).not.toEqual([0, 1, 2]);
    }
    expect(shuffle([7], 1)).toEqual([7]);
    expect(shuffle([], 1)).toEqual([]);
  });

  it("shuffles the whole round before anything has happened, and restores it when turned off", () => {
    const on = run(createDeck(12), { type: "shuffle", on: true, seed: 9 });
    expect(on.shuffled).toBe(true);
    expect(on.order).not.toEqual(on.round);
    expect([...on.order].sort((a, b) => a - b)).toEqual(on.round);
    const off = run(on, { type: "shuffle", on: false, seed: 0 });
    expect(off).toMatchObject({ shuffled: false, order: on.round, position: 0 });
  });

  it("mid-round, leaves the cards already seen and the one on screen where they are", () => {
    const mid = run(createDeck(10), got, again, got, flip);
    const on = run(mid, { type: "shuffle", on: true, seed: 3 });
    expect(on.order.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect([...on.order.slice(4)].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(on.order.slice(4)).not.toEqual([4, 5, 6, 7, 8, 9]);
    expect(on).toMatchObject({ position: 3, flipped: true, marks: mid.marks });

    const off = run(on, next, { type: "shuffle", on: false, seed: 0 });
    expect(off.order.slice(0, 5)).toEqual(on.order.slice(0, 5));
    const rest = off.order.slice(5);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  it("applies to the next round when turned on at the result", () => {
    const done = run(createDeck(6), again, again, again, again, again, again, { type: "shuffle", on: true, seed: 1 });
    expect(done.finished).toBe(true);
    const redo = run(done, { type: "redo-missed", seed: 2 });
    expect(redo.order).not.toEqual(redo.round);
  });
});

describe("large and small decks", () => {
  it("handles 200 cards", () => {
    let deck = run(createDeck(200), { type: "shuffle", on: true, seed: 11 });
    for (let i = 0; i < 200; i++) deck = deckReducer(deck, i % 4 === 0 ? again : got);
    expect(deck.finished).toBe(true);
    expect(tally(deck)).toEqual({ cards: 200, got: 150, again: 50, skipped: 0 });
    expect(missedCards(deck)).toHaveLength(50);
  });

  it("handles one card", () => {
    const deck = run(createDeck(1), { type: "shuffle", on: true, seed: 1 }, flip, again);
    expect(deck.finished).toBe(true);
    expect(run(deck, { type: "redo-missed", seed: 1 })).toMatchObject({ round: [0], order: [0], pass: 2 });
  });
});

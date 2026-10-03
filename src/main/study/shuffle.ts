/**
 * Putting the correct option of every multiple-choice question in a fair place before a quiz
 * or mock exam is saved.
 *
 * Models cluster their answers: one real mock exam had all 22 correct options in first place,
 * others never used the last. The viewer shuffles on every attempt, but the saved file is read
 * too — printed, opened in an editor, shown by another program — so it should not be degenerate
 * itself. Each position is used equally often (as far as the number of questions allows), in
 * an order that depends only on `seed`: the same result always comes out the same.
 *
 * Pure: no I/O, no clock, no `Math.random`.
 */
import type { QuestionsContent } from "@shared/study";

/** A small seeded generator (mulberry32 over an FNV-1a hash of the seed). */
function generator(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

/**
 * An option that only makes sense where it stands ("all of the above", "both A and C"). The
 * instructions forbid them; a question that has one anyway keeps its order.
 */
const POSITIONAL = /\b(?:all|none|both|neither|either) of the (?:above|below|these)\b|\bthe above\b|\b(?:both|neither|either) [A-F]\b|\b[A-F] (?:and|or|und|oder) [A-F]\b|\balle (?:oben|genannten)\b|\bkeine der\b/i;

/** `content` with the options of every multiple-choice question reordered. The input is not changed. */
export function spreadAnswers(content: QuestionsContent, seed: string): QuestionsContent {
  const random = generator(seed);
  // One queue of positions per number of options: every position once, then again.
  const queues = new Map<number, number[]>();
  const nextPosition = (count: number): number => {
    let queue = queues.get(count);
    if (queue === undefined || queue.length === 0) {
      queue = shuffled(
        Array.from({ length: count }, (_, index) => index),
        random,
      );
      queues.set(count, queue);
    }
    return queue.pop() as number;
  };

  return {
    questions: content.questions.map((question) => {
      if (question.type !== "multiple_choice") return question;
      const correct = question.options[question.answerIndex];
      if (correct === undefined || question.options.some((option) => POSITIONAL.test(option))) return question;

      const others = shuffled(
        question.options.filter((_, index) => index !== question.answerIndex),
        random,
      );
      const answerIndex = nextPosition(question.options.length);
      const options = [...others.slice(0, answerIndex), correct, ...others.slice(answerIndex)];
      return { ...question, options, answerIndex };
    }),
  };
}

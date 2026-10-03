/**
 * For tests that say "this stays fast on hostile input": a measure that does not depend on how
 * busy the machine is.
 *
 * An absolute bound ("under 500 ms") fails when the computer is loaded and proves little when it
 * is not. What such a test really means is "the time grows with the length of the input, not
 * with its square". So the work is timed at one size and at four times that size: a linear
 * pattern takes about 4 times as long, a quadratic one 16 times. The test passes while the
 * larger run stays under `MAX_RATIO` times the smaller — or is so quick that there is nothing
 * to measure (`FLOOR_MS`). Each size is run a few times and the best time counts, which is what
 * the code can do when nothing else is in its way.
 *
 * Choose a size at which a quadratic implementation would take a second or more; then neither
 * way out hides it.
 *
 * Only tests import this file.
 */

/** Between linear (4) and quadratic (16) for a fourfold input. */
export const MAX_RATIO = 10;
/** A larger run faster than this is fast whatever the ratio says: timers are not that exact. */
export const FLOOR_MS = 60;
const FACTOR = 4;
const RUNS = 3;

export interface Growth {
  smallMs: number;
  largeMs: number;
  ratio: number;
  /** True when the time grows no faster than the input, as far as can be measured. */
  linear: boolean;
}

function verdict(smallMs: number, largeMs: number): Growth {
  const ratio = largeMs / Math.max(smallMs, 0.001);
  return { smallMs, largeMs, ratio, linear: largeMs <= FLOOR_MS || ratio <= MAX_RATIO };
}

/** Times `work(size)` and `work(4 × size)`. */
export function growthOf(work: (size: number) => unknown, size: number): Growth {
  const best = (n: number): number => {
    let fastest = Infinity;
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      work(n);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  return verdict(best(size), best(size * FACTOR));
}

/** The same for work that is asynchronous. `prepare` builds the input outside the measured time. */
export async function growthOfAsync<T>(
  prepare: (size: number) => T | Promise<T>,
  work: (input: T) => Promise<unknown>,
  size: number,
): Promise<Growth> {
  const best = async (n: number): Promise<number> => {
    const input = await prepare(n);
    let fastest = Infinity;
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      await work(input);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  return verdict(await best(size), await best(size * FACTOR));
}

// Compares decrementFefo with a simple reference on thousands of random mixes
// of expired, unreadable, sold-out and fractional batches, from a fixed seed.
import { describe, it, expect } from "vitest";

import { decrementFefo } from "./fefo";
import { computeBatchFreshness, isCalendarDate, isInStock } from "./freshness";

const TODAY = "2026-10-19";
const CASES = 5_000;

const DATES = [
  "2026-10-10", // expired
  "2026-10-18", // expired yesterday
  TODAY, // expires today, still usable
  "2026-10-20",
  "2026-10-25",
  "2026-11-01",
  "", // unreadable
  "2026-02-30", // unreadable
];
const QUANTITIES = [0, 1, 2, 3, 5, 10, -2, 1.5];
const REQUESTS = [1, 2, 3, 4, 7, 12, 30, 0, -1, 2.5, Number.NaN];

interface TestBatch {
  id: string;
  quantity: number;
  expirationDate: string;
}

// Small seeded generator (LCG), so runs are repeatable
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function isUsable(batch: TestBatch): boolean {
  if (!isInStock(batch)) return false;
  return (
    !isCalendarDate(batch.expirationDate) ||
    computeBatchFreshness(batch.expirationDate, TODAY).status !== "Expired"
  );
}

// The rules written as plainly as possible: order usable batches, then take
// greedily
function referenceDecrement(batches: TestBatch[], quantity: number) {
  const after = batches.map((batch) => batch.quantity);
  const touched = new Set<number>();
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { after, touched, shortfall: 0 };
  }

  // Readable dates first by date, unreadable last, ties by position
  const sortKey = (index: number): [number, string, number] => {
    const date = batches[index].expirationDate;
    return isCalendarDate(date) ? [0, date, index] : [1, "", index];
  };
  const order = batches
    .map((_, index) => index)
    .filter((index) => isUsable(batches[index]))
    .sort((a, b) => {
      const [aGroup, aDate, aIndex] = sortKey(a);
      const [bGroup, bDate, bIndex] = sortKey(b);
      if (aGroup !== bGroup) return aGroup - bGroup;
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
      return aIndex - bIndex;
    });

  let left = quantity;
  for (const index of order) {
    if (left === 0) break;
    const take = Math.min(after[index], left);
    after[index] -= take;
    left -= take;
    touched.add(index);
  }
  return { after, touched, shortfall: left };
}

describe("decrementFefo (property)", () => {
  it(`matches the reference and keeps its guarantees on ${CASES} random cases`, () => {
    const random = seededRandom(12345);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];

    for (let n = 0; n < CASES; n++) {
      const batches: TestBatch[] = Array.from(
        { length: Math.floor(random() * 7) },
        (_, i) => ({
          id: `b${i}`,
          quantity: pick(QUANTITIES),
          expirationDate: pick(DATES),
        }),
      );
      const quantity = pick(REQUESTS);
      const before = JSON.stringify(batches);

      const actual = decrementFefo(batches, quantity, TODAY);
      const ref = referenceDecrement(batches, quantity);
      const context = JSON.stringify({ batches, quantity, actual });

      const expected = {
        remaining: [] as TestBatch[],
        updated: [] as TestBatch[],
        emptied: [] as TestBatch[],
        shortfall: ref.shortfall,
      };
      batches.forEach((batch, index) => {
        if (!ref.touched.has(index)) {
          expected.remaining.push(batch);
          return;
        }
        const next = { ...batch, quantity: ref.after[index] };
        if (next.quantity === 0) {
          expected.emptied.push(next);
        } else {
          expected.remaining.push(next);
          expected.updated.push(next);
        }
      });

      expect(actual, context).toStrictEqual(expected);
      expect(JSON.stringify(batches), "input was modified").toBe(before);

      if (!Number.isInteger(quantity) || quantity <= 0) continue;

      // Every requested unit is either taken or reported as shortfall
      const taken = batches.reduce(
        (sum, batch, index) => sum + batch.quantity - ref.after[index],
        0,
      );
      expect(taken + actual.shortfall, context).toBe(quantity);

      batches.forEach((batch, index) => {
        if (isUsable(batch)) {
          expect(ref.after[index], context).toBeGreaterThanOrEqual(0);
          // Shortfall only once every usable batch is empty
          if (actual.shortfall > 0) expect(ref.after[index], context).toBe(0);
        } else {
          // Expired, sold-out and fractional batches are never touched
          expect(ref.after[index], context).toBe(batch.quantity);
        }
      });
    }
  });
});

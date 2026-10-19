import {
  type Batch,
  computeBatchFreshness,
  isCalendarDate,
  isInStock,
} from "./freshness";

export interface FefoResult<T extends Batch> {
  // Batches still linked to the product, in their original order
  remaining: T[];
  // Decremented but not empty: save the new quantity
  updated: T[];
  // Decremented to zero: delete and unlink
  emptied: T[];
  // Units no usable batch could cover: an oversell, or only expired stock
  // left. 0 normally
  shortfall: number;
}

/**
 * First expired, first out: takes `quantity` units from the soonest-expiring
 * in-stock batches, splitting across batches when one runs out. Expired
 * batches are never used, since expired stock shouldn't be shipped. Pure, so
 * the caller decides how to write the result.
 *
 * @param batches - each batch once; callers dedupe by id
 * @param today - the shop-local "today", "YYYY-MM-DD" (see getShopToday)
 * @throws if `today` isn't a YYYY-MM-DD date, since a bad one would
 *   silently change which batches count as expired
 */
export function decrementFefo<T extends Batch>(
  batches: T[],
  quantity: number,
  today: string,
): FefoResult<T> {
  if (!isCalendarDate(today)) {
    throw new Error(`Expected today as YYYY-MM-DD, got: "${today}"`);
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { remaining: [...batches], updated: [], emptied: [], shortfall: 0 };
  }

  // Usable batches, keyed by position. sort() is stable, so equal dates
  // keep their order
  const pickOrder = batches
    .flatMap((batch, index) => {
      if (!isInStock(batch)) return [];
      const readable = isCalendarDate(batch.expirationDate);
      // Same expiry rule as the dashboard; an unreadable date can't be judged
      if (
        readable &&
        computeBatchFreshness(batch.expirationDate, today).status === "Expired"
      ) {
        return [];
      }
      return [{ batch, index, readable }];
    })
    .sort(compareExpiry);

  const taken = new Map<number, number>();
  let left = quantity;
  for (const { batch, index } of pickOrder) {
    if (left === 0) break;
    const take = Math.min(batch.quantity, left);
    taken.set(index, take);
    left -= take;
  }

  const remaining: T[] = [];
  const updated: T[] = [];
  const emptied: T[] = [];
  batches.forEach((batch, index) => {
    const take = taken.get(index);
    if (take === undefined) {
      remaining.push(batch);
      return;
    }

    const next = { ...batch, quantity: batch.quantity - take };
    if (next.quantity === 0) {
      emptied.push(next);
    } else {
      remaining.push(next);
      updated.push(next);
    }
  });

  return { remaining, updated, emptied, shortfall: left };
}

interface Candidate {
  batch: Batch;
  readable: boolean;
}

// Soonest date first; unreadable dates go last so real ones are used first
function compareExpiry(a: Candidate, b: Candidate): number {
  if (a.readable !== b.readable) return a.readable ? -1 : 1;
  const aDate = a.batch.expirationDate;
  const bDate = b.batch.expirationDate;
  if (!a.readable || aDate === bDate) return 0;
  // YYYY-MM-DD strings sort in calendar order
  return aDate < bDate ? -1 : 1;
}

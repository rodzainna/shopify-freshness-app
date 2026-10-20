import { decrementFefo } from "./fefo";
import {
  type Batch,
  computeBatchFreshness,
  getEarliestExpirationDate,
  isCalendarDate,
  isInStock,
} from "./freshness";

export interface StoredBatch extends Batch {
  id: string;
}

// Absolute target state, so applying it twice gives the same result.
// The `before` values let a retry detect edits made in between.
export interface FulfillmentPlanData {
  updates: { id: string; before: number; after: number }[];
  deletes: { id: string; before: number }[];
  beforeBatchIds: string[];
  batchIds: string[];
  earliestExpirationDate: string | null;
}

export interface StockShortfall {
  reason: "oversell" | "expired_stock_only";
  shortfall: number;
  expiredUnits: number;
}

/**
 * Plans one product's share of a fulfillment: which batches to set, delete
 * and keep linked, and any units fresh stock couldn't cover.
 *
 * @param today - the shop-local "today", "YYYY-MM-DD" (see getShopToday)
 */
export function planFulfillment(
  batches: StoredBatch[],
  quantity: number,
  today: string,
): { plan: FulfillmentPlanData; shortfall: StockShortfall | null } {
  const unique = dedupeById(batches);
  const before = new Map(unique.map((batch) => [batch.id, batch.quantity]));
  const { remaining, updated, emptied, shortfall } = decrementFefo(
    unique,
    quantity,
    today,
  );

  const plan: FulfillmentPlanData = {
    updates: updated.map(({ id, quantity: after }) => ({
      id,
      before: before.get(id)!,
      after,
    })),
    deletes: emptied.map(({ id }) => ({ id, before: before.get(id)! })),
    beforeBatchIds: unique.map(({ id }) => id),
    batchIds: remaining.map(({ id }) => id),
    earliestExpirationDate: getEarliestExpirationDate(remaining),
  };

  if (shortfall === 0) return { plan, shortfall: null };

  const expiredUnits = unique
    .filter((batch) => isInStock(batch) && isExpired(batch, today))
    .reduce((sum, batch) => sum + batch.quantity, 0);
  return {
    plan,
    shortfall: {
      // Only "expired stock only" when expired units could have covered it all
      reason: expiredUnits >= shortfall ? "expired_stock_only" : "oversell",
      shortfall,
      expiredUnits,
    },
  };
}

// First occurrence wins, keeping the list's order.
function dedupeById(batches: StoredBatch[]): StoredBatch[] {
  const seen = new Set<string>();
  return batches.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Same rule decrementFefo uses to skip a batch
function isExpired(batch: Batch, today: string): boolean {
  return (
    isCalendarDate(batch.expirationDate) &&
    computeBatchFreshness(batch.expirationDate, today).status === "Expired"
  );
}

import { decrementFefo } from "./fefo";
import {
  type Batch,
  getEarliestExpirationDate,
  isExpired,
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

/**
 * Before re-applying a saved plan, checks that each batch it touches is at
 * its "before" or "after" value. Anything else means someone edited it in
 * between, and re-applying would overwrite that edit.
 *
 * @param current - the product's batches as just re-read from Shopify
 */
export function checkPlanBeforeRetry(
  plan: FulfillmentPlanData,
  current: StoredBatch[],
): "safe" | "changed" {
  const unique = dedupeById(current);
  const listIds = unique.map(({ id }) => id);
  if (
    !sameIds(listIds, plan.beforeBatchIds) &&
    !sameIds(listIds, plan.batchIds)
  ) {
    return "changed";
  }

  const quantities = new Map(unique.map((batch) => [batch.id, batch.quantity]));
  const updatesOk = plan.updates.every(({ id, before, after }) => {
    const quantity = quantities.get(id);
    return quantity === before || quantity === after;
  });
  // A deleted batch is unlinked first, so it's either gone or untouched
  const deletesOk = plan.deletes.every(({ id, before }) => {
    const quantity = quantities.get(id);
    return quantity === undefined || quantity === before;
  });
  return updatesOk && deletesOk ? "safe" : "changed";
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

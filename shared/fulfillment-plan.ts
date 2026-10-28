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
}

export interface StockShortfall {
  reason: "oversell" | "expired_stock_only";
  shortfall: number;
  expiredUnits: number;
}

/**
 * Plans one product's share of a fulfillment: which batches to set and delete,
 * and any units fresh stock couldn't cover.
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
  const { updated, emptied, shortfall } = decrementFefo(
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

/**
 * The batch list and earliest date to write for a plan, given the product's
 * batches as just re-read. Batches the plan doesn't delete are kept, so a
 * batch another client added or removed meanwhile stays that way.
 */
export function freshnessAfterPlan(
  plan: FulfillmentPlanData,
  current: StoredBatch[],
): { batchIds: string[]; earliestExpirationDate: string | null } {
  const deleted = new Set(plan.deletes.map(({ id }) => id));
  const kept = dedupeById(current).filter(({ id }) => !deleted.has(id));
  return {
    batchIds: kept.map(({ id }) => id),
    earliestExpirationDate: getEarliestExpirationDate(kept),
  };
}

/**
 * Right after a plan's quantities are written, checks nobody changed them
 * since: updated batches must be at "after", emptied ones untouched or gone.
 */
export function checkPlanApplied(
  plan: FulfillmentPlanData,
  current: StoredBatch[],
): "safe" | "changed" {
  const quantities = new Map(
    dedupeById(current).map((batch) => [batch.id, batch.quantity]),
  );
  const updatesOk = plan.updates.every(
    ({ id, after }) => quantities.get(id) === after,
  );
  const deletesOk = plan.deletes.every(({ id, before }) => {
    const quantity = quantities.get(id);
    return quantity === undefined || quantity === before;
  });
  return updatesOk && deletesOk ? "safe" : "changed";
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
 * Before re-applying a saved plan, checks each batch it touches is still at
 * "before" or "after"; others may change, as freshnessAfterPlan keeps them.
 *
 * @param current - the product's batches as just re-read from Shopify
 */
export function checkPlanBeforeRetry(
  plan: FulfillmentPlanData,
  current: StoredBatch[],
): "safe" | "changed" {
  const unique = dedupeById(current);
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

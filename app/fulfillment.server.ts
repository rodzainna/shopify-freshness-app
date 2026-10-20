import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type {
  DiscrepancyReason,
  FulfillmentPlan,
  Prisma,
} from "@prisma/client";
import db from "./db.server";
import { applyPlan, readProductBatches } from "./fulfillment-shopify.server";
import { withProductLock } from "./product-lock.server";
import type { ProductQuantity } from "../shared/fulfillment";
import {
  type FulfillmentPlanData,
  checkPlanBeforeRetry,
  earliestDateAfterPlan,
  planFulfillment,
} from "../shared/fulfillment-plan";

export interface FulfillmentContext {
  admin: AdminApiContext;
  shop: string;
  fulfillmentId: string;
  // The shop-local "today", read once per webhook
  today: string;
}

// Reasons that end a product's processing for that fulfillment
const STOPPING_REASONS: DiscrepancyReason[] = [
  "product_not_found",
  "too_many_batches",
  "changed_during_retry",
];

/**
 * Applies one fulfillment to each product's batches, one product lock at a
 * time. Safe to call again for the same fulfillment: finished products are
 * skipped and half-applied ones are completed from their saved plan.
 */
export async function processFulfillment(
  context: FulfillmentContext,
  products: ProductQuantity[],
): Promise<void> {
  for (const { productId, quantity } of products) {
    await withProductLock(context.shop, productId, () =>
      processProduct(context, productId, quantity),
    );
  }
}

async function processProduct(
  context: FulfillmentContext,
  productId: string,
  quantity: number,
): Promise<void> {
  const { admin, shop, fulfillmentId, today } = context;

  // Earlier fulfillments' plans go first, so plans apply in order
  await finishPendingPlans(context, productId);
  if (await alreadyHandled(shop, fulfillmentId, productId)) return;

  const read = await readProductBatches(admin, productId);
  if ("notTracked" in read) return;
  if ("problem" in read) {
    await recordStop(shop, fulfillmentId, productId, read.problem);
    return;
  }

  const { plan, shortfall } = planFulfillment(read.batches, quantity, today);
  const key = { shop, fulfillmentId, productId };
  await db.$transaction([
    db.fulfillmentPlan.create({ data: { ...key, plan: toJson(plan) } }),
    ...(shortfall
      ? [db.fulfillmentDiscrepancy.create({ data: { ...key, ...shortfall } })]
      : []),
  ]);
  if (shortfall) {
    console.warn(
      `Fulfillment ${fulfillmentId} is short ${shortfall.shortfall} of ${productId} (${shortfall.reason})`,
    );
  }

  await applyPlan(admin, productId, plan, plan.earliestExpirationDate);
  await markApplied(key);
}

async function finishPendingPlans(
  context: FulfillmentContext,
  productId: string,
): Promise<void> {
  const pending = await db.fulfillmentPlan.findMany({
    where: { shop: context.shop, productId, appliedAt: null },
    orderBy: { createdAt: "asc" },
  });
  for (const row of pending) await finishPlan(context, row);
}

async function finishPlan(
  { admin }: FulfillmentContext,
  row: FulfillmentPlan,
): Promise<void> {
  const { shop, fulfillmentId, productId } = row;
  const plan = row.plan as unknown as FulfillmentPlanData;

  const read = await readProductBatches(admin, productId);
  if ("problem" in read) {
    await dropPlan(row, read.problem);
    return;
  }
  // Emptying the last batch deletes the list metafield, so this is our own write
  const current = "notTracked" in read ? [] : read.batches;

  if (checkPlanBeforeRetry(plan, current) === "changed") {
    await dropPlan(row, "changed_during_retry");
    return;
  }
  await applyPlan(admin, productId, plan, earliestDateAfterPlan(plan, current));
  await markApplied({ shop, fulfillmentId, productId });
}

// The discrepancy replaces the plan as the record, so the fulfillment is never
// recalculated against stock that has changed since.
async function dropPlan(
  { shop, fulfillmentId, productId }: FulfillmentPlan,
  reason: DiscrepancyReason,
): Promise<void> {
  const key = { shop, fulfillmentId, productId };
  await db.$transaction([
    upsertDiscrepancy(key, reason),
    db.fulfillmentPlan.delete({ where: { shop_fulfillmentId_productId: key } }),
  ]);
  console.warn(`Dropped ${fulfillmentId}'s plan for ${productId}: ${reason}`);
}

async function recordStop(
  shop: string,
  fulfillmentId: string,
  productId: string,
  reason: DiscrepancyReason,
): Promise<void> {
  await upsertDiscrepancy({ shop, fulfillmentId, productId }, reason);
  console.warn(`Skipped ${productId} for ${fulfillmentId}: ${reason}`);
}

function upsertDiscrepancy(
  key: { shop: string; fulfillmentId: string; productId: string },
  reason: DiscrepancyReason,
) {
  return db.fulfillmentDiscrepancy.upsert({
    where: { shop_fulfillmentId_productId_reason: { ...key, reason } },
    create: { ...key, reason },
    update: {},
  });
}

async function alreadyHandled(
  shop: string,
  fulfillmentId: string,
  productId: string,
): Promise<boolean> {
  const [plan, stop] = await Promise.all([
    db.fulfillmentPlan.findUnique({
      where: {
        shop_fulfillmentId_productId: { shop, fulfillmentId, productId },
      },
    }),
    db.fulfillmentDiscrepancy.findFirst({
      where: {
        shop,
        fulfillmentId,
        productId,
        reason: { in: STOPPING_REASONS },
      },
    }),
  ]);
  return plan !== null || stop !== null;
}

async function markApplied(key: {
  shop: string;
  fulfillmentId: string;
  productId: string;
}): Promise<void> {
  await db.fulfillmentPlan.update({
    where: { shop_fulfillmentId_productId: key },
    data: { appliedAt: new Date() },
  });
}

function toJson(plan: FulfillmentPlanData): Prisma.InputJsonValue {
  return plan as unknown as Prisma.InputJsonValue;
}

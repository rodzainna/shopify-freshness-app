import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type {
  DiscrepancyReason,
  FulfillmentPlan,
  Prisma,
} from "@prisma/client";
import db from "./db.server";
import {
  PermanentShopifyError,
  applyPlan,
  readProductBatches,
} from "./fulfillment-shopify.server";
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
  // The shop-local "today", read once per job
  today: string;
  // How long to wait for a product another run is updating
  lockWaitMs?: number;
}

type PlanKey = Pick<FulfillmentPlan, "shop" | "fulfillmentId" | "productId">;

// Reasons that end a product's processing for that fulfillment
const STOPPING_REASONS: DiscrepancyReason[] = [
  "product_not_found",
  "too_many_batches",
  "changed_during_retry",
  "apply_failed",
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
    await withProductLock(
      context.shop,
      productId,
      () => processProduct(context, productId, quantity),
      { waitMs: context.lockWaitMs },
    );
  }
}

async function processProduct(
  context: FulfillmentContext,
  productId: string,
  quantity: number,
): Promise<void> {
  const key: PlanKey = {
    shop: context.shop,
    fulfillmentId: context.fulfillmentId,
    productId,
  };

  // Earlier fulfillments' plans go first, so plans apply in order
  await finishPendingPlans(context, productId);
  if (await alreadyHandled(key)) return;
  await recordIfRejected(key, () => planAndApply(context, key, quantity));
}

async function planAndApply(
  { admin, today }: FulfillmentContext,
  key: PlanKey,
  quantity: number,
): Promise<void> {
  const { fulfillmentId, productId } = key;
  const read = await readProductBatches(admin, productId);
  if ("notTracked" in read) return;
  if ("problem" in read) {
    await recordStop(key, read.problem);
    return;
  }

  const { plan, shortfall } = planFulfillment(read.batches, quantity, today);
  await db.$transaction([
    db.fulfillmentPlan.create({ data: { ...key, plan: toJson(plan) } }),
    // Upsert: an uninstall deletes plans but keeps discrepancies
    ...(shortfall
      ? [
          db.fulfillmentDiscrepancy.upsert({
            where: {
              shop_fulfillmentId_productId_reason: {
                ...key,
                reason: shortfall.reason,
              },
            },
            create: { ...key, ...shortfall },
            update: {},
          }),
        ]
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
  for (const row of pending) {
    await recordIfRejected(row, () => finishPlan(context, row));
  }
}

async function finishPlan(
  { admin }: FulfillmentContext,
  row: FulfillmentPlan,
): Promise<void> {
  const plan = row.plan as unknown as FulfillmentPlanData;

  const read = await readProductBatches(admin, row.productId);
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
  await applyPlan(
    admin,
    row.productId,
    plan,
    earliestDateAfterPlan(plan, current),
  );
  await markApplied(row);
}

// A rejection would recur on every retry and block this product's later
// fulfillments, so it's recorded and processing moves on.
async function recordIfRejected(
  key: PlanKey,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof PermanentShopifyError)) throw error;
    await dropPlan(key, "apply_failed", error.message);
  }
}

// The discrepancy replaces the plan as the record, so the fulfillment is never
// recalculated against stock that has changed since.
async function dropPlan(
  { shop, fulfillmentId, productId }: PlanKey,
  reason: DiscrepancyReason,
  detail?: string,
): Promise<void> {
  const key = { shop, fulfillmentId, productId };
  // deleteMany: a read can fail before the plan is saved
  await db.$transaction([
    upsertDiscrepancy(key, reason),
    db.fulfillmentPlan.deleteMany({ where: key }),
  ]);
  console.warn(
    `Dropped ${fulfillmentId}'s plan for ${productId}: ${reason}`,
    ...(detail ? [detail] : []),
  );
}

async function recordStop(
  key: PlanKey,
  reason: DiscrepancyReason,
): Promise<void> {
  await upsertDiscrepancy(key, reason);
  console.warn(`Skipped ${key.productId} for ${key.fulfillmentId}: ${reason}`);
}

function upsertDiscrepancy(key: PlanKey, reason: DiscrepancyReason) {
  return db.fulfillmentDiscrepancy.upsert({
    where: { shop_fulfillmentId_productId_reason: { ...key, reason } },
    create: { ...key, reason },
    update: {},
  });
}

async function alreadyHandled(key: PlanKey): Promise<boolean> {
  const [plan, stop] = await Promise.all([
    db.fulfillmentPlan.findUnique({
      where: { shop_fulfillmentId_productId: key },
    }),
    db.fulfillmentDiscrepancy.findFirst({
      where: { ...key, reason: { in: STOPPING_REASONS } },
    }),
  ]);
  return plan !== null || stop !== null;
}

// Picks the key fields, since callers may pass a whole plan row
async function markApplied({
  shop,
  fulfillmentId,
  productId,
}: PlanKey): Promise<void> {
  await db.fulfillmentPlan.update({
    where: { shop_fulfillmentId_productId: { shop, fulfillmentId, productId } },
    data: { appliedAt: new Date() },
  });
}

function toJson(plan: FulfillmentPlanData): Prisma.InputJsonValue {
  return plan as unknown as Prisma.InputJsonValue;
}

import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import type { FulfillmentJob, Prisma } from "@prisma/client";
import db from "./db.server";
import { processFulfillment } from "./fulfillment.server";
import { readShopToday } from "./fulfillment-shopify.server";
import { unauthenticated } from "./shopify.server";
import type { ProductQuantity } from "../shared/fulfillment";

type JobKey = Pick<FulfillmentJob, "shop" | "fulfillmentId">;

// Retries after the first attempt, about 4 hours in all, like Shopify's own
const RETRY_DELAYS_MS = [
  30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
];

// A run that has held a job this long is assumed to have crashed
export const STALE_RUN_MS = 5 * 60_000;

/** Saves a received fulfillment to apply later. A repeat delivery is a no-op. */
export function saveFulfillmentJob({
  shop,
  fulfillmentId,
  products,
  receivedAt,
}: JobKey & { products: ProductQuantity[]; receivedAt: Date }) {
  return db.fulfillmentJob.upsert({
    where: { shop_fulfillmentId: { shop, fulfillmentId } },
    create: {
      shop,
      fulfillmentId,
      products: products as unknown as Prisma.InputJsonValue,
      receivedAt,
      nextRunAt: receivedAt,
    },
    update: {},
  });
}

/**
 * Runs a job if it's due and no other run holds it. Done jobs are deleted,
 * temporary failures are retried later, and the rest are marked failed.
 */
export async function runFulfillmentJob(
  key: JobKey,
  now: Date = new Date(),
): Promise<void> {
  const job = await claimJob(key, now);
  if (!job) return;

  const started = Date.now();
  try {
    const { admin } = await unauthenticated.admin(job.shop);
    // The day it was received, so a retry after midnight plans the same way
    const today = await readShopToday(admin, job.receivedAt);
    await processFulfillment(
      { admin, shop: job.shop, fulfillmentId: job.fulfillmentId, today },
      job.products as unknown as ProductQuantity[],
    );
  } catch (error) {
    await recordFailure(job, error, now);
    return;
  }

  // deleteMany: an uninstall may have deleted the job during the run
  await db.fulfillmentJob.deleteMany({ where: key });
  console.log(
    `Applied ${job.fulfillmentId} for ${job.shop} in ${Date.now() - started}ms (attempt ${job.attempts})`,
  );
}

// One atomic update, so two runs can't both claim the same job
async function claimJob(
  key: JobKey,
  now: Date,
): Promise<FulfillmentJob | null> {
  const { count } = await db.fulfillmentJob.updateMany({
    where: {
      ...key,
      OR: [
        { status: "pending", nextRunAt: { lte: now } },
        {
          status: "running",
          claimedAt: { lte: new Date(now.getTime() - STALE_RUN_MS) },
        },
      ],
    },
    data: { status: "running", claimedAt: now, attempts: { increment: 1 } },
  });
  if (count === 0) return null;
  return db.fulfillmentJob.findUnique({
    where: { shop_fulfillmentId: key },
  });
}

async function recordFailure(
  job: FulfillmentJob,
  error: unknown,
  now: Date,
): Promise<void> {
  const lastError = error instanceof Error ? error.message : String(error);
  const delay = RETRY_DELAYS_MS[job.attempts - 1];
  // No session means the app was uninstalled, so a retry can't succeed
  const giveUp = error instanceof SessionNotFoundError || delay === undefined;
  const where = { shop: job.shop, fulfillmentId: job.fulfillmentId };

  if (giveUp) {
    await db.fulfillmentJob.updateMany({
      where,
      data: { status: "failed", lastError },
    });
    console.error(
      `Gave up on ${job.fulfillmentId} for ${job.shop} after ${job.attempts} attempts: ${lastError}`,
    );
    return;
  }

  await db.fulfillmentJob.updateMany({
    where,
    data: {
      status: "pending",
      nextRunAt: new Date(now.getTime() + delay),
      lastError,
    },
  });
  console.warn(
    `Retrying ${job.fulfillmentId} for ${job.shop} in ${delay / 1000}s: ${lastError}`,
  );
}

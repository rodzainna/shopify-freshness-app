import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "./db.server";

export const PRODUCT_LOCK_TTL_MS = 30_000;

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/** Returns a token to release with, or null if a live lock is held elsewhere. */
export async function acquireProductLock(
  shop: string,
  productId: string,
  now: Date = new Date(),
): Promise<string | null> {
  // One key format only: a numeric id and a GID would be two separate locks.
  if (!PRODUCT_GID.test(productId)) {
    throw new Error(`Expected a Product GID, got "${productId}"`);
  }

  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + PRODUCT_LOCK_TTL_MS);

  try {
    await db.productLock.create({
      data: { shop, productId, token, expiresAt },
    });
    return token;
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== UNIQUE_CONSTRAINT_VIOLATION
    ) {
      throw error;
    }
  }

  // A single conditional update, so two callers can't both take over.
  const { count } = await db.productLock.updateMany({
    where: { shop, productId, expiresAt: { lte: now } },
    data: { token, expiresAt },
  });
  return count === 1 ? token : null;
}

/** Returns false if the lock had already expired and been taken over. */
export async function releaseProductLock(
  shop: string,
  productId: string,
  token: string,
): Promise<boolean> {
  // Matching the token stops a holder that outlived its TTL from freeing a newer lock.
  const { count } = await db.productLock.deleteMany({
    where: { shop, productId, token },
  });
  return count === 1;
}

export class ProductLockBusyError extends Error {
  constructor(shop: string, productId: string) {
    super(`Product ${productId} on ${shop} is locked by another update`);
    this.name = "ProductLockBusyError";
  }
}

/**
 * Runs `fn` while holding the product's lock, releasing it even if `fn` throws.
 * @throws ProductLockBusyError if the lock stays busy for `waitMs`
 */
export async function withProductLock<T>(
  shop: string,
  productId: string,
  fn: () => Promise<T>,
  { waitMs = 1_500, pollMs = 250 } = {},
): Promise<T> {
  // Short wait: Shopify needs a webhook response within 5 seconds.
  const deadline = Date.now() + waitMs;
  let token = await acquireProductLock(shop, productId);
  while (token === null && Date.now() < deadline) {
    // Jitter so waiters on the same product don't all retry at once.
    const jittered = pollMs * (0.5 + Math.random());
    const delay = Math.min(jittered, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, delay));
    token = await acquireProductLock(shop, productId);
  }
  if (token === null) throw new ProductLockBusyError(shop, productId);

  try {
    return await fn();
  } finally {
    await releaseAfterWork(shop, productId, token);
  }
}

// fn's writes have already happened, so a failed release must not report them
// as failed (a redelivered webhook would apply them twice); the TTL frees it.
async function releaseAfterWork(
  shop: string,
  productId: string,
  token: string,
) {
  try {
    if (!(await releaseProductLock(shop, productId, token))) {
      console.warn(`Lock on ${productId} for ${shop} expired before release`);
    }
  } catch (error) {
    console.error(`Failed to release lock on ${productId} for ${shop}`, error);
  }
}

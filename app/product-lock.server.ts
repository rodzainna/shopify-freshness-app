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

import { describe, it, expect, afterEach } from "vitest";
import db from "./db.server";
import {
  PRODUCT_LOCK_TTL_MS,
  acquireProductLock,
  releaseProductLock,
} from "./product-lock.server";

const shop = "lock-test.myshopify.com";
const productId = "gid://shopify/Product/1";
const now = new Date("2026-10-20T00:00:00Z");
const afterTtl = new Date(now.getTime() + PRODUCT_LOCK_TTL_MS);

// Setup helper: fails loudly so a test can't pass on a lock it never held.
async function holdLock(at: Date): Promise<string> {
  const token = await acquireProductLock(shop, productId, at);
  if (token === null) throw new Error("Setup failed to acquire the lock");
  return token;
}

describe("product lock", () => {
  afterEach(async () => {
    await db.productLock.deleteMany({ where: { shop } });
  });

  it("acquires a free lock", async () => {
    expect(await acquireProductLock(shop, productId, now)).toEqual(
      expect.any(String),
    );
  });

  it("refuses a second holder while the lock is live", async () => {
    await holdLock(now);
    const justBeforeExpiry = new Date(afterTtl.getTime() - 1);
    expect(await acquireProductLock(shop, productId, justBeforeExpiry)).toBe(
      null,
    );
  });

  it("locks each product separately", async () => {
    await holdLock(now);
    expect(
      await acquireProductLock(shop, "gid://shopify/Product/2", now),
    ).not.toBe(null);
  });

  it("can be acquired again after release", async () => {
    const token = await holdLock(now);
    expect(await releaseProductLock(shop, productId, token)).toBe(true);
    expect(await acquireProductLock(shop, productId, now)).not.toBe(null);
  });

  it("takes over a lock once it has expired", async () => {
    const stale = await holdLock(now);
    const fresh = await acquireProductLock(shop, productId, afterTtl);
    expect(fresh).not.toBe(null);
    expect(fresh).not.toBe(stale);
  });

  it("ignores a release from a holder whose lock was taken over", async () => {
    const stale = await holdLock(now);
    await holdLock(afterTtl);
    expect(await releaseProductLock(shop, productId, stale)).toBe(false);
    expect(await acquireProductLock(shop, productId, afterTtl)).toBe(null);
  });

  it("gives the lock to exactly one of many simultaneous callers", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        acquireProductLock(shop, productId, now),
      ),
    );
    expect(tokens.filter((token) => token !== null)).toHaveLength(1);
  });

  it("lets exactly one of many callers take over an expired lock", async () => {
    await holdLock(now);
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        acquireProductLock(shop, productId, afterTtl),
      ),
    );
    expect(tokens.filter((token) => token !== null)).toHaveLength(1);
  });

  it("rejects a product id that isn't a GID", async () => {
    await expect(acquireProductLock(shop, "1", now)).rejects.toThrow(
      'Expected a Product GID, got "1"',
    );
  });
});

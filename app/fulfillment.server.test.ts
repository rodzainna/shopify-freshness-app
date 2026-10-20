import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "./db.server";
import { processFulfillment } from "./fulfillment.server";
import { fakeShopify } from "../test/fake-shopify";

const shop = "fulfillment-process-test.myshopify.com";
const productId = "gid://shopify/Product/1";
const otherProductId = "gid://shopify/Product/2";
const today = "2026-10-20";

const SOON = "gid://shopify/Metaobject/soon";
const LATER = "gid://shopify/Metaobject/later";
const EXPIRED = "gid://shopify/Metaobject/expired";

async function clearTestData() {
  const where = { shop };
  await db.fulfillmentPlan.deleteMany({ where });
  await db.fulfillmentDiscrepancy.deleteMany({ where });
  await db.productLock.deleteMany({ where });
}

function setup() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [SOON]: { quantity: 3, expirationDate: "2026-10-22" },
    [LATER]: { quantity: 10, expirationDate: "2026-11-05" },
  });
  const fulfill = (fulfillmentId: string, quantity: number, id = productId) =>
    processFulfillment({ admin: shopify.admin, shop, fulfillmentId, today }, [
      { productId: id, quantity },
    ]);
  return { shopify, fulfill };
}

const discrepancies = () =>
  db.fulfillmentDiscrepancy.findMany({
    where: { shop },
    select: { fulfillmentId: true, reason: true, shortfall: true },
    orderBy: { reason: "asc" },
  });

describe("processFulfillment", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await clearTestData();
  });
  afterEach(clearTestData);
  afterEach(() => vi.restoreAllMocks());

  it("takes from the soonest batches and updates the product", async () => {
    const { shopify, fulfill } = setup();

    await fulfill("gid://shopify/Fulfillment/1", 5);

    expect(shopify.batch(SOON)).toBeUndefined();
    expect(shopify.batch(LATER)?.quantity).toBe(8);
    expect(shopify.product(productId)).toStrictEqual({
      batchIds: [LATER],
      earliestExpirationDate: "2026-11-05",
    });
    expect(
      await db.fulfillmentPlan.findFirst({ where: { shop } }),
    ).toMatchObject({ appliedAt: expect.any(Date) });
  });

  it("does nothing more when the same fulfillment arrives again", async () => {
    const { shopify, fulfill } = setup();
    await fulfill("gid://shopify/Fulfillment/1", 5);
    const callsBefore = shopify.calls.length;

    await fulfill("gid://shopify/Fulfillment/1", 5);

    expect(shopify.batch(LATER)?.quantity).toBe(8);
    expect(shopify.calls.length).toBe(callsBefore);
  });

  it("finishes a half-applied fulfillment on retry without decrementing twice", async () => {
    const { shopify, fulfill } = setup();
    shopify.failNext("DeleteBatch");

    await expect(fulfill("gid://shopify/Fulfillment/1", 5)).rejects.toThrow(
      "Simulated network failure in DeleteBatch",
    );
    // Quantities and the list were already written before the failure
    expect(shopify.batch(LATER)?.quantity).toBe(8);

    await fulfill("gid://shopify/Fulfillment/1", 5);

    expect(shopify.batch(LATER)?.quantity).toBe(8);
    expect(shopify.batch(SOON)).toBeUndefined();
  });

  it("finishes a retry after the last batch was emptied", async () => {
    const { shopify, fulfill } = setup();
    shopify.failNext("DeleteBatch");

    // Takes all 13 units, so the list metafield is deleted before the failure
    await expect(fulfill("gid://shopify/Fulfillment/1", 13)).rejects.toThrow();
    expect(shopify.product(productId)?.batchIds).toBeNull();

    await fulfill("gid://shopify/Fulfillment/1", 13);

    expect(shopify.batch(SOON)).toBeUndefined();
    expect(shopify.batch(LATER)).toBeUndefined();
    expect(
      await db.fulfillmentPlan.findFirst({ where: { shop } }),
    ).toMatchObject({ appliedAt: expect.any(Date) });
  });

  it("recomputes the earliest date from the batches as they are on retry", async () => {
    const { shopify, fulfill } = setup();
    const FIRST = "gid://shopify/Metaobject/first";
    const NEXT = "gid://shopify/Metaobject/next";
    const LAST = "gid://shopify/Metaobject/last";
    shopify.addProduct(otherProductId, {
      [FIRST]: { quantity: 3, expirationDate: "2026-10-22" },
      [NEXT]: { quantity: 2, expirationDate: "2026-11-01" },
      [LAST]: { quantity: 10, expirationDate: "2026-11-05" },
    });
    // Empties "first", so the saved plan's date is "next"'s
    shopify.failNext("SaveProductFreshness");
    await expect(
      fulfill("gid://shopify/Fulfillment/1", 3, otherProductId),
    ).rejects.toThrow();
    // The merchant sells out "next", which the plan doesn't touch
    shopify.setQuantity(NEXT, 0);

    await fulfill("gid://shopify/Fulfillment/1", 3, otherProductId);

    expect(shopify.product(otherProductId)?.earliestExpirationDate).toBe(
      "2026-11-05",
    );
  });

  it("drops a plan whose batches were edited before the retry", async () => {
    const { shopify, fulfill } = setup();
    shopify.failNext("SaveProductFreshness");
    await expect(fulfill("gid://shopify/Fulfillment/1", 5)).rejects.toThrow();
    // The merchant edits a batch the plan touches
    shopify.setQuantity(LATER, 20);

    await fulfill("gid://shopify/Fulfillment/1", 5);
    await fulfill("gid://shopify/Fulfillment/1", 5);

    expect(shopify.batch(LATER)?.quantity).toBe(20);
    expect(await db.fulfillmentPlan.count({ where: { shop } })).toBe(0);
    expect(await discrepancies()).toStrictEqual([
      {
        fulfillmentId: "gid://shopify/Fulfillment/1",
        reason: "changed_during_retry",
        shortfall: null,
      },
    ]);
  });

  it("finishes an earlier fulfillment's plan before planning a new one", async () => {
    const { shopify, fulfill } = setup();
    shopify.failNext("SaveProductFreshness");
    await expect(fulfill("gid://shopify/Fulfillment/1", 5)).rejects.toThrow();

    await fulfill("gid://shopify/Fulfillment/2", 1);

    // 13 - 5 - 1, with the first fulfillment applied before the second
    expect(shopify.batch(SOON)).toBeUndefined();
    expect(shopify.batch(LATER)?.quantity).toBe(7);
  });

  it("records a shortfall alongside the plan", async () => {
    const { shopify, fulfill } = setup();

    await fulfill("gid://shopify/Fulfillment/1", 15);

    expect(shopify.product(productId)?.batchIds).toBeNull();
    expect(await discrepancies()).toStrictEqual([
      {
        fulfillmentId: "gid://shopify/Fulfillment/1",
        reason: "oversell",
        shortfall: 2,
      },
    ]);
  });

  it("keeps both a shortfall and a later retry conflict", async () => {
    const { shopify, fulfill } = setup();
    const FRESH = "gid://shopify/Metaobject/fresh";
    shopify.addProduct(otherProductId, {
      [EXPIRED]: { quantity: 4, expirationDate: "2026-10-19" },
      [FRESH]: { quantity: 3, expirationDate: "2026-10-22" },
    });
    // Takes all 3 fresh units, 2 short; the emptied batch's delete fails
    shopify.failNext("DeleteBatch");
    await expect(
      fulfill("gid://shopify/Fulfillment/1", 5, otherProductId),
    ).rejects.toThrow();
    // The merchant re-links the emptied batch with new stock
    shopify.product(otherProductId)!.batchIds = [EXPIRED, FRESH];
    shopify.setQuantity(FRESH, 9);

    await fulfill("gid://shopify/Fulfillment/1", 5, otherProductId);

    expect(shopify.batch(FRESH)?.quantity).toBe(9);
    expect((await discrepancies()).map(({ reason }) => reason)).toStrictEqual([
      "changed_during_retry",
      "expired_stock_only",
    ]);
  });

  it("skips a product the app doesn't track", async () => {
    const { shopify, fulfill } = setup();
    shopify.addProduct(otherProductId, null);

    await fulfill("gid://shopify/Fulfillment/1", 2, otherProductId);

    expect(shopify.calls).toStrictEqual(["GetProductBatches"]);
    expect(await discrepancies()).toStrictEqual([]);
  });

  it("records a deleted product once, however often it's retried", async () => {
    const { fulfill } = setup();

    await fulfill("gid://shopify/Fulfillment/1", 2, otherProductId);
    await fulfill("gid://shopify/Fulfillment/1", 2, otherProductId);

    expect(await discrepancies()).toStrictEqual([
      {
        fulfillmentId: "gid://shopify/Fulfillment/1",
        reason: "product_not_found",
        shortfall: null,
      },
    ]);
  });

  it("releases each product's lock when it's done", async () => {
    const { fulfill } = setup();

    await fulfill("gid://shopify/Fulfillment/1", 1);

    expect(await db.productLock.count({ where: { shop } })).toBe(0);
  });
});

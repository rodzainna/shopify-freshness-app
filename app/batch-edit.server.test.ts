import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "./db.server";
import { editBatches, loadBatches } from "./batch-edit.server";
import { fakeShopify } from "../test/fake-shopify";

const shop = "batch-edit-test.myshopify.com";
const productId = "gid://shopify/Product/1";
const SOON = "gid://shopify/Metaobject/soon";
const LATER = "gid://shopify/Metaobject/later";

const opened = [
  { id: SOON, quantity: 6, expirationDate: "2026-10-23" },
  { id: LATER, quantity: 12, expirationDate: "2026-10-28" },
];

function setup() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [SOON]: { quantity: 6, expirationDate: "2026-10-23" },
    [LATER]: { quantity: 12, expirationDate: "2026-10-28" },
  });
  const edit = (edited: typeof opened, lockWaitMs?: number) =>
    editBatches({
      admin: shopify.admin,
      shop,
      productId,
      opened,
      edited,
      lockWaitMs,
    });
  return { shopify, edit };
}

const writes = (calls: string[]) =>
  calls.filter((call) => call !== "GetProductBatches");

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.productLock.deleteMany({ where: { shop } });
});
afterEach(async () => {
  await db.productLock.deleteMany({ where: { shop } });
  vi.restoreAllMocks();
});

describe("editBatches", () => {
  it("writes the changed batch and the new earliest date", async () => {
    const { shopify, edit } = setup();

    const result = await edit([
      { id: SOON, quantity: 4, expirationDate: "2026-11-30" },
      opened[1],
    ]);

    expect(result).toStrictEqual({
      kind: "saved",
      batches: [
        { id: SOON, quantity: 4, expirationDate: "2026-11-30" },
        opened[1],
      ],
      failed: [],
      dateFailed: false,
    });
    expect(shopify.batch(SOON)).toEqual({
      quantity: 4,
      expirationDate: "2026-11-30",
    });
    expect(shopify.product(productId)).toEqual({
      batchIds: [SOON, LATER],
      earliestExpirationDate: "2026-10-28",
    });
    expect(writes(shopify.calls)).toStrictEqual([
      "SetBatchValues",
      "SaveProductFreshness",
    ]);
  });

  it("writes nothing when nothing was edited", async () => {
    const { shopify, edit } = setup();

    expect(await edit(opened)).toMatchObject({ kind: "unchanged" });
    expect(writes(shopify.calls)).toStrictEqual([]);
  });

  it("writes nothing and returns the current values when they changed", async () => {
    const { shopify, edit } = setup();
    // A fulfillment took 2 units after the editor opened
    shopify.setQuantity(SOON, 4);

    const result = await edit([
      { id: SOON, quantity: 10, expirationDate: "2026-10-23" },
      opened[1],
    ]);

    expect(result).toStrictEqual({
      kind: "changed",
      batches: [
        { id: SOON, quantity: 4, expirationDate: "2026-10-23" },
        opened[1],
      ],
    });
    expect(writes(shopify.calls)).toStrictEqual([]);
    expect(shopify.batch(SOON)?.quantity).toBe(4);
  });

  it("writes nothing when a value is invalid", async () => {
    const { shopify, edit } = setup();

    const result = await edit([
      { id: SOON, quantity: 0, expirationDate: "2026-10-23" },
      opened[1],
    ]);

    expect(result).toMatchObject({
      kind: "invalid",
      errors: {
        [SOON]: { quantity: expect.stringContaining("product panel") },
      },
    });
    expect(writes(shopify.calls)).toStrictEqual([]);
  });

  it("reports a batch Shopify rejects and keeps its current value", async () => {
    const { shopify, edit } = setup();
    shopify.rejectNext("SetBatchValues");

    const result = await edit([
      { id: SOON, quantity: 4, expirationDate: "2026-11-30" },
      { id: LATER, quantity: 11, expirationDate: "2026-10-28" },
    ]);

    // Writes run together, so either one can be the rejected one
    expect(result).toMatchObject({ kind: "saved", dateFailed: false });
    const { failed, batches } = result as {
      failed: string[];
      batches: typeof opened;
    };
    expect(failed).toHaveLength(1);
    const kept = opened.find(({ id }) => id === failed[0]);
    expect(batches).toContainEqual(kept);
    expect(shopify.product(productId)?.earliestExpirationDate).toBe(
      failed[0] === SOON ? "2026-10-23" : "2026-10-28",
    );
  });

  it("reports an earliest date it couldn't save", async () => {
    const { shopify, edit } = setup();
    shopify.rejectNext("SaveProductFreshness");

    const result = await edit([
      { id: SOON, quantity: 4, expirationDate: "2026-10-23" },
      opened[1],
    ]);

    expect(result).toMatchObject({
      kind: "saved",
      failed: [],
      dateFailed: true,
    });
    expect(shopify.batch(SOON)?.quantity).toBe(4);
  });

  it("gives up when another update holds the product", async () => {
    const { shopify, edit } = setup();
    await db.productLock.create({
      data: {
        shop,
        productId,
        token: "fulfillment",
        expiresAt: new Date(Date.now() + 30_000),
      },
    });

    expect(await edit(opened, 0)).toStrictEqual({
      kind: "unavailable",
      message: "This product is being updated. Try again in a moment.",
    });
    expect(shopify.calls).toStrictEqual([]);
  });

  it("releases the lock when it's done", async () => {
    const { edit } = setup();

    await edit(opened);

    expect(await db.productLock.count({ where: { shop } })).toBe(0);
  });

  it("throws when the edits don't match the opened batches", async () => {
    const { edit } = setup();

    await expect(edit([opened[0]])).rejects.toThrow(
      "The edits don't match the batches that were opened",
    );
  });
});

describe("loadBatches", () => {
  it("reads the product's batches", async () => {
    const { shopify } = setup();

    expect(await loadBatches(shopify.admin, productId)).toStrictEqual({
      batches: opened,
    });
  });

  it.each([
    ["a missing product", "gid://shopify/Product/404", "Product not found."],
  ])("explains %s", async (_case, id, message) => {
    const { shopify } = setup();

    expect(await loadBatches(shopify.admin, id)).toStrictEqual({ message });
  });

  it("explains a batch list it can't read", async () => {
    const { shopify } = setup();
    shopify.product(productId)!.batchIds = [
      SOON,
      "gid://shopify/Metaobject/gone",
    ];

    expect(await loadBatches(shopify.admin, productId)).toStrictEqual({
      message: "Some batches couldn't be read.",
    });
  });

  it("explains a product without batches", async () => {
    const { shopify } = setup();
    shopify.addProduct("gid://shopify/Product/2", null);

    expect(
      await loadBatches(shopify.admin, "gid://shopify/Product/2"),
    ).toStrictEqual({ message: "This product has no batches." });
  });
});

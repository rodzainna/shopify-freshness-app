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
  // As the panel would have stored it
  shopify.product(productId)!.earliestExpirationDate = "2026-10-23";
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
      failedNew: [],
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
      "SetBatchFields",
      "SaveProductFreshness",
    ]);
  });

  it("treats a product without a batch list as empty", async () => {
    const { shopify } = setup();
    const emptyProduct = "gid://shopify/Product/2";
    shopify.addProduct(emptyProduct, null);

    const result = await editBatches({
      admin: shopify.admin,
      shop,
      productId: emptyProduct,
      opened: [],
      edited: [],
    });

    expect(result).toStrictEqual({ kind: "unchanged", batches: [] });
    expect(writes(shopify.calls)).toStrictEqual([]);
  });

  it("doesn't rewrite an earliest date that's still right", async () => {
    const { shopify, edit } = setup();

    await edit([{ ...opened[0], quantity: 2 }, opened[1]]);

    expect(writes(shopify.calls)).toStrictEqual(["SetBatchFields"]);
  });

  it("repairs a stale earliest date even when nothing was edited", async () => {
    const { shopify, edit } = setup();
    shopify.product(productId)!.earliestExpirationDate = null;

    expect(await edit(opened)).toMatchObject({ kind: "saved", failed: [] });
    expect(writes(shopify.calls)).toStrictEqual(["SaveProductFreshness"]);
    expect(shopify.product(productId)?.earliestExpirationDate).toBe(
      "2026-10-23",
    );
  });

  it("leaves a batch the panel adds during the save linked", async () => {
    const { shopify, edit } = setup();
    const ADDED = "gid://shopify/Metaobject/added";
    // The panel doesn't take the app's lock, so it can add a batch mid-save
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = ((query: string, options?: object) => {
      if (query.includes("SetBatchFields")) {
        shopify.product(productId)!.batchIds!.push(ADDED);
      }
      return graphql(query, options);
    }) as typeof graphql;

    await edit([{ ...opened[0], expirationDate: "2026-11-30" }, opened[1]]);

    expect(shopify.product(productId)).toEqual({
      batchIds: [SOON, LATER, ADDED],
      earliestExpirationDate: "2026-10-28",
    });
  });

  it("counts a write whose response was lost as saved when it landed", async () => {
    const { shopify, edit } = setup();
    shopify.loseResponseNext("SetBatchFields");

    const result = await edit([{ ...opened[0], quantity: 4 }, opened[1]]);

    expect(result).toMatchObject({
      kind: "saved",
      failed: [],
      batches: [{ ...opened[0], quantity: 4 }, opened[1]],
    });
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
    shopify.rejectNext("SetBatchFields");

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

    // Moving the soonest date changes the earliest date, so it needs writing
    const result = await edit([
      { id: SOON, quantity: 4, expirationDate: "2026-11-30" },
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

describe("editBatches adding batches", () => {
  const HANDLE = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";
  const OTHER_HANDLE = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
  const fresh = (handle = HANDLE, quantity = 3) => ({
    handle,
    quantity,
    expirationDate: "2026-10-20",
  });

  const add = (
    shopify: ReturnType<typeof fakeShopify>,
    added: ReturnType<typeof fresh>[],
    edited = opened,
  ) =>
    editBatches({
      admin: shopify.admin,
      shop,
      productId,
      opened,
      edited,
      added,
    });

  // Runs `effect` just before the named operation reaches Shopify
  function before(
    shopify: ReturnType<typeof fakeShopify>,
    operation: string,
    effect: () => void,
  ) {
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = ((query: string, options?: object) => {
      if (query.includes(`${operation}(`)) effect();
      return graphql(query, options);
    }) as typeof graphql;
  }

  it("adds a batch to a product that has none", async () => {
    const { shopify } = setup();
    const empty = "gid://shopify/Product/2";
    shopify.addProduct(empty, null);

    const result = await editBatches({
      admin: shopify.admin,
      shop,
      productId: empty,
      opened: [],
      edited: [],
      added: [fresh()],
    });

    const id = shopify.batchIdByHandle(HANDLE)!;
    expect(result).toStrictEqual({
      kind: "saved",
      batches: [{ id, quantity: 3, expirationDate: "2026-10-20" }],
      failed: [],
      failedNew: [],
      dateFailed: false,
    });
    expect(shopify.product(empty)).toEqual({
      batchIds: [id],
      earliestExpirationDate: "2026-10-20",
    });
  });

  it("links new batches before writing edits, then the date", async () => {
    const { shopify } = setup();

    await add(shopify, [fresh()], [{ ...opened[0], quantity: 5 }, opened[1]]);

    expect(writes(shopify.calls)).toStrictEqual([
      "FindBatchByHandle",
      "UpsertBatch",
      "SaveBatchList",
      "SetBatchFields",
      "SaveProductFreshness",
    ]);
    expect(shopify.product(productId)).toEqual({
      batchIds: [SOON, LATER, shopify.batchIdByHandle(HANDLE)],
      earliestExpirationDate: "2026-10-20",
    });
    expect(shopify.batch(SOON)?.quantity).toBe(5);
  });

  it("removes the new batch and writes nothing else when the list changed meanwhile", async () => {
    const { shopify } = setup();
    const PANEL = "gid://shopify/Metaobject/panel";
    shopify.addProduct("gid://shopify/Product/9", {
      [PANEL]: { quantity: 1, expirationDate: "2026-12-01" },
    });
    // The panel doesn't take the app's lock, so it can save mid-request
    before(shopify, "metafieldsSet", () => {
      shopify.product(productId)!.batchIds!.push(PANEL);
    });

    const result = await add(
      shopify,
      [fresh()],
      [{ ...opened[0], quantity: 5 }, opened[1]],
    );

    expect(result).toStrictEqual({
      kind: "changed",
      batches: [
        ...opened,
        { id: PANEL, quantity: 1, expirationDate: "2026-12-01" },
      ],
    });
    expect(shopify.batch(shopify.batchIdByHandle(HANDLE)!)).toBeUndefined();
    expect(shopify.batch(SOON)?.quantity).toBe(6);
    expect(writes(shopify.calls)).not.toContain("SetBatchFields");
  });

  it("refuses a handle that a listed batch already uses, writing nothing", async () => {
    const { shopify } = setup();
    shopify.setHandle(SOON, HANDLE);

    await expect(add(shopify, [fresh()])).rejects.toThrow(
      "A new batch's handle is already used by another batch",
    );
    expect(writes(shopify.calls)).toStrictEqual(["FindBatchByHandle"]);
    expect(shopify.batch(SOON)?.quantity).toBe(6);
  });

  it("reuses a new batch left unlinked by a failed save", async () => {
    const { shopify } = setup();
    shopify.failNext("SaveBatchList");

    await expect(add(shopify, [fresh()])).rejects.toThrow(
      "Simulated network failure",
    );
    const leftover = shopify.batchIdByHandle(HANDLE);
    const retry = await add(shopify, [fresh()]);

    expect(retry).toMatchObject({ kind: "saved", failedNew: [] });
    expect(shopify.product(productId)?.batchIds).toStrictEqual([
      SOON,
      LATER,
      leftover,
    ]);
  });

  it("links the new batches that were created and reports the rest", async () => {
    const { shopify } = setup();
    shopify.rejectNext("UpsertBatch");

    const result = await add(shopify, [fresh(), fresh(OTHER_HANDLE, 4)]);

    // Upserts run together, so either one can be the rejected one
    const { failedNew } = result as { failedNew: string[] };
    expect(failedNew).toHaveLength(1);
    const createdHandle = failedNew[0] === HANDLE ? OTHER_HANDLE : HANDLE;
    expect(shopify.product(productId)?.batchIds).toStrictEqual([
      SOON,
      LATER,
      shopify.batchIdByHandle(createdHandle),
    ]);
  });

  it("writes no list when no new batch could be created", async () => {
    const { shopify } = setup();
    shopify.rejectNext("UpsertBatch");

    const result = await add(shopify, [fresh()]);

    expect(result).toMatchObject({ kind: "saved", failedNew: [HANDLE] });
    expect(writes(shopify.calls)).not.toContain("SaveBatchList");
    expect(shopify.product(productId)?.batchIds).toStrictEqual([SOON, LATER]);
  });

  it("refuses to go over the batch limit, writing nothing", async () => {
    const shopify = fakeShopify();
    const many = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [
        `gid://shopify/Metaobject/${index}`,
        { quantity: 1, expirationDate: "2026-11-01" },
      ]),
    );
    shopify.addProduct(productId, many);
    const full = Object.entries(many).map(([id, batch]) => ({ id, ...batch }));

    const result = await editBatches({
      admin: shopify.admin,
      shop,
      productId,
      opened: full,
      edited: full,
      added: [fresh()],
    });

    expect(result).toStrictEqual({
      kind: "unavailable",
      message: "A product can have at most 250 batches.",
    });
    expect(writes(shopify.calls)).toStrictEqual([]);
  });
});

describe("loadBatches", () => {
  it("reads the product's batches", async () => {
    const { shopify } = setup();

    expect(await loadBatches(shopify.admin, productId)).toStrictEqual({
      batches: opened,
      earliestExpirationDate: "2026-10-23",
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

  it("opens a product without a batch list as empty, so batches can be added", async () => {
    const { shopify } = setup();
    shopify.addProduct("gid://shopify/Product/2", null);

    expect(
      await loadBatches(shopify.admin, "gid://shopify/Product/2"),
    ).toStrictEqual({ batches: [], earliestExpirationDate: null });
  });
});

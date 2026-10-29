import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import db from "../db.server";
import { acquireProductLock } from "../product-lock.server";
import { reseedProduct } from "./demo-seed.server";
import { fakeShopify } from "../../test/fake-shopify";

const shop = "demo-seed-test.myshopify.com";
const productId = "gid://shopify/Product/1";
const OLD = "gid://shopify/Metaobject/old";
// The fake's handle for every product
const HANDLE = "demo-product";

const planned = [
  {
    handle: "6b1c1b9e-3c7a-4d55-9a57-0f3d7c1e2a01",
    quantity: 4,
    expirationDate: "2026-11-05",
  },
  {
    handle: "6b1c1b9e-3c7a-4d55-9a57-0f3d7c1e2a02",
    quantity: 9,
    expirationDate: "2026-10-30",
  },
];

function setup() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [OLD]: { quantity: 3, expirationDate: "2026-10-01" },
  });
  shopify.product(productId)!.earliestExpirationDate = "2026-10-01";
  const reseed = (batches = planned) =>
    reseedProduct({
      admin: shopify.admin,
      shop,
      productId,
      handle: HANDLE,
      planned: batches,
    });
  const newIds = () =>
    planned.map(({ handle }) => shopify.batchIdByHandle(handle));
  return { shopify, reseed, newIds };
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.productLock.deleteMany({ where: { shop } });
});
afterEach(async () => {
  await db.productLock.deleteMany({ where: { shop } });
  vi.restoreAllMocks();
});

describe("reseedProduct", () => {
  it("swaps in the new batches, deletes the old ones and saves the earliest date", async () => {
    const { shopify, reseed, newIds } = setup();

    expect(await reseed()).toStrictEqual({
      kind: "seeded",
      added: 2,
      removed: 1,
    });
    expect(shopify.product(productId)).toEqual({
      batchIds: newIds(),
      earliestExpirationDate: "2026-10-30",
    });
    expect(shopify.batch(OLD)).toBeUndefined();
    expect(
      shopify.calls.filter((call) => call !== "UpsertBatch"),
    ).toStrictEqual([
      "GetBatchListIds",
      "SaveBatchList",
      "DeleteBatch",
      "SaveProductFreshness",
    ]);
  });

  it("empties the list and clears the date when nothing is planned", async () => {
    const { shopify, reseed } = setup();

    expect(await reseed([])).toStrictEqual({
      kind: "seeded",
      added: 0,
      removed: 1,
    });
    expect(shopify.product(productId)).toEqual({
      batchIds: null,
      earliestExpirationDate: null,
    });
    expect(shopify.batch(OLD)).toBeUndefined();
  });

  it("seeds a product that has no batch list yet", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.addProduct(productId, null);

    expect(await reseed()).toMatchObject({ kind: "seeded", removed: 0 });
    expect(shopify.product(productId)?.batchIds).toEqual(newIds());
  });

  it("deletes the new batches and keeps the old ones when one can't be created", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.rejectNext("UpsertBatch");

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "1 new batch couldn't be created.",
    });
    expect(newIds().filter((id) => id && shopify.batch(id))).toEqual([]);
    expect(shopify.product(productId)?.batchIds).toEqual([OLD]);
  });

  it("deletes the new batches when the list changed meanwhile", async () => {
    const { shopify, reseed, newIds } = setup();
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = ((query: string, options?: object) => {
      // The panel doesn't take the app's lock, so it can save mid-reseed
      if (query.includes("SaveBatchList")) {
        shopify
          .product(productId)!
          .batchIds!.push("gid://shopify/Metaobject/panel");
      }
      return graphql(query, options);
    }) as typeof graphql;

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "The batches changed during the reseed. Try again.",
    });
    expect(newIds().every((id) => !shopify.batch(id!))).toBe(true);
    expect(shopify.batch(OLD)).toBeDefined();
  });

  it("deletes the new batches when the list write fails", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.failNext("SaveBatchList");

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "The new batches couldn't be linked. Try again.",
    });
    expect(newIds().every((id) => !shopify.batch(id!))).toBe(true);
    expect(shopify.product(productId)?.batchIds).toEqual([OLD]);
  });

  it("finishes the swap when the list write landed but its response was lost", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.loseResponseNext("SaveBatchList");

    expect(await reseed()).toStrictEqual({
      kind: "seeded",
      added: 2,
      removed: 1,
    });
    expect(shopify.product(productId)).toEqual({
      batchIds: newIds(),
      earliestExpirationDate: "2026-10-30",
    });
    expect(shopify.batch(OLD)).toBeUndefined();
  });

  it("keeps everything when it can't tell if the list write landed", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.failNext("SaveBatchList");
    // The read after the failed write fails too
    const graphql = shopify.admin.graphql;
    let reads = 0;
    shopify.admin.graphql = ((query: string, options?: object) => {
      if (query.includes("GetBatchListIds") && ++reads === 2) {
        return Promise.reject(new Error("Simulated network failure"));
      }
      return graphql(query, options);
    }) as typeof graphql;

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "Couldn't tell if the new batches were linked.",
    });
    expect(newIds().every((id) => shopify.batch(id!))).toBe(true);
    expect(shopify.batch(OLD)).toBeDefined();
  });

  it("reports a replaced product whose earliest date didn't save", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.failNext("SaveProductFreshness");

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "Batches replaced, but the earliest date didn't save.",
    });
    expect(shopify.product(productId)?.batchIds).toEqual(newIds());
  });

  it("replaces a list that points at a deleted batch", async () => {
    const { shopify, reseed, newIds } = setup();
    shopify.product(productId)!.batchIds!.push("gid://shopify/Metaobject/gone");

    expect(await reseed()).toMatchObject({ kind: "seeded", removed: 2 });
    expect(shopify.product(productId)?.batchIds).toEqual(newIds());
    expect(shopify.batch(OLD)).toBeUndefined();
  });

  it("deletes an empty list saved as [] when nothing is planned", async () => {
    const { shopify, reseed } = setup();
    shopify.product(productId)!.batchIds = [];

    expect(await reseed([])).toStrictEqual({
      kind: "seeded",
      added: 0,
      removed: 0,
    });
    expect(shopify.product(productId)?.batchIds).toBeNull();
  });

  it("treats a landed list write as linked even if the panel added a batch", async () => {
    const { shopify, reseed, newIds } = setup();
    const PANEL = "gid://shopify/Metaobject/panel";
    shopify.addProduct("gid://shopify/Product/9", {
      [PANEL]: { quantity: 1, expirationDate: "2026-12-01" },
    });
    shopify.loseResponseNext("SaveBatchList");
    const graphql = shopify.admin.graphql;
    let reads = 0;
    shopify.admin.graphql = ((query: string, options?: object) => {
      // The panel saves between the lost write and the re-read
      if (query.includes("GetBatchListIds") && ++reads === 2) {
        shopify.product(productId)!.batchIds!.push(PANEL);
      }
      return graphql(query, options);
    }) as typeof graphql;

    expect(await reseed()).toMatchObject({ kind: "seeded" });
    expect(shopify.product(productId)?.batchIds).toEqual([...newIds(), PANEL]);
    expect(newIds().every((id) => shopify.batch(id!))).toBe(true);
  });

  it("passes on a sign-in response instead of reporting a failed write", async () => {
    const { shopify, reseed } = setup();
    const signIn = new Response(null, { status: 401 });
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = ((query: string, options?: object) =>
      query.includes("SaveBatchList")
        ? Promise.reject(signIn)
        : graphql(query, options)) as typeof graphql;

    await expect(reseed()).rejects.toBe(signIn);
  });

  it("cleans up after a Shopify HTTP error that isn't a sign-in", async () => {
    const { shopify, reseed, newIds } = setup();
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = ((query: string, options?: object) =>
      query.includes("SaveBatchList")
        ? Promise.reject(new Response(null, { status: 503 }))
        : graphql(query, options)) as typeof graphql;

    expect(await reseed()).toStrictEqual({
      kind: "failed",
      message: "The new batches couldn't be linked. Try again.",
    });
    expect(newIds().every((id) => !shopify.batch(id!))).toBe(true);
    expect(shopify.product(productId)?.batchIds).toEqual([OLD]);
  });

  it("replaces a list value that isn't a list of ids", async () => {
    const { shopify, reseed, newIds } = setup();
    const graphql = shopify.admin.graphql;
    shopify.admin.graphql = (async (query: string, options?: object) => {
      const response = await graphql(query, options);
      if (!query.includes("GetBatchListIds")) return response;
      const body = await response.json();
      body.data.product.list.value = "not json";
      return Response.json(body);
    }) as typeof graphql;

    expect(await reseed()).toMatchObject({ kind: "seeded", removed: 0 });
    expect(shopify.product(productId)?.batchIds).toEqual(newIds());
  });

  it("refuses a product whose handle isn't the demo product's", async () => {
    const { shopify } = setup();

    expect(
      await reseedProduct({
        admin: shopify.admin,
        shop,
        productId,
        handle: "whole-milk-1l",
        planned,
      }),
    ).toStrictEqual({
      kind: "failed",
      message: "This product isn't whole-milk-1l.",
    });
    expect(shopify.calls).toStrictEqual(["GetBatchListIds"]);
  });

  it("reports a missing product", async () => {
    const empty = fakeShopify();

    expect(
      await reseedProduct({
        admin: empty.admin,
        shop,
        productId,
        handle: HANDLE,
        planned,
      }),
    ).toStrictEqual({ kind: "failed", message: "Product not found." });
  });

  it("writes nothing while another update holds the product's lock", async () => {
    const { shopify } = setup();
    await acquireProductLock(shop, productId);

    expect(
      await reseedProduct({
        admin: shopify.admin,
        shop,
        productId,
        handle: HANDLE,
        planned,
        lockWaitMs: 0,
      }),
    ).toMatchObject({ kind: "failed" });
    expect(shopify.calls).toStrictEqual([]);
  });
});

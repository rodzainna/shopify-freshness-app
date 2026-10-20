import { describe, it, expect } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  applyPlan,
  readProductBatches,
  readShopToday,
} from "./fulfillment-shopify.server";
import type { FulfillmentPlanData } from "../shared/fulfillment-plan";

const productId = "gid://shopify/Product/1";

type Call = { operation: string; variables: Record<string, unknown> };

// Answers each operation by name and records the calls in order.
function fakeAdmin(responses: Record<string, (variables: never) => unknown>) {
  const calls: Call[] = [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
      const variables = options?.variables ?? {};
      calls.push({ operation, variables });
      const respond = responses[operation];
      if (!respond) throw new Error(`Unexpected operation ${operation}`);
      return Response.json({ data: respond(variables as never) });
    },
  } as unknown as AdminApiContext;
  return { admin, calls };
}

const noUserErrors = { userErrors: [] };
const writesSucceed = {
  SetBatchQuantity: () => ({ metaobjectUpdate: noUserErrors }),
  SaveProductFreshness: () => ({
    metafieldsSet: noUserErrors,
    metafieldsDelete: null,
  }),
  DeleteBatch: () => ({ metaobjectDelete: noUserErrors }),
};

const plan: FulfillmentPlanData = {
  updates: [{ id: "gid://shopify/Metaobject/2", before: 10, after: 8 }],
  deletes: [{ id: "gid://shopify/Metaobject/1", before: 3 }],
  beforeBatchIds: ["gid://shopify/Metaobject/1", "gid://shopify/Metaobject/2"],
  batchIds: ["gid://shopify/Metaobject/2"],
  earliestExpirationDate: "2026-11-05",
};

describe("readShopToday", () => {
  it("returns today in the shop's timezone", async () => {
    const { admin } = fakeAdmin({
      GetShopTimezone: () => ({ shop: { ianaTimezone: "Asia/Manila" } }),
    });

    // 20:00 UTC is already the next day in Manila (UTC+8)
    expect(await readShopToday(admin, new Date("2026-10-20T20:00:00Z"))).toBe(
      "2026-10-21",
    );
  });
});

describe("readProductBatches", () => {
  const batchesResponse = (nodes: unknown[], hasNextPage = false) => ({
    product: {
      freshnessBatches: { references: { nodes, pageInfo: { hasNextPage } } },
    },
  });

  it("reads each batch's id, quantity and date", async () => {
    const { admin, calls } = fakeAdmin({
      GetProductBatches: () =>
        batchesResponse([
          {
            id: "gid://shopify/Metaobject/1",
            quantity: { value: "3" },
            expirationDate: { value: "2026-10-22" },
          },
        ]),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      batches: [
        {
          id: "gid://shopify/Metaobject/1",
          quantity: 3,
          expirationDate: "2026-10-22",
        },
      ],
    });
    expect(calls[0].variables).toStrictEqual({ productId, maxBatches: 250 });
  });

  it("treats a missing quantity as not in stock", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () =>
        batchesResponse([{ id: "gid://shopify/Metaobject/1", quantity: null }]),
    });

    const result = await readProductBatches(admin, productId);

    expect(result).toStrictEqual({
      batches: [
        { id: "gid://shopify/Metaobject/1", quantity: NaN, expirationDate: "" },
      ],
    });
  });

  it("returns no batches when the product has none", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({ product: { freshnessBatches: null } }),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      batches: [],
    });
  });

  it("reports a deleted product", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({ product: null }),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      problem: "product_not_found",
    });
  });

  it("reports more batches than one page holds", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => batchesResponse([], true),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      problem: "too_many_batches",
    });
  });
});

describe("applyPlan", () => {
  it("sets quantities, then the list and date, then deletes", async () => {
    const { admin, calls } = fakeAdmin(writesSucceed);

    await applyPlan(admin, productId, plan, "2026-11-05");

    expect(calls).toStrictEqual([
      {
        operation: "SetBatchQuantity",
        variables: { id: "gid://shopify/Metaobject/2", quantity: "8" },
      },
      {
        operation: "SaveProductFreshness",
        variables: expect.objectContaining({
          set: [
            {
              ownerId: productId,
              key: "freshness_batches",
              value: JSON.stringify(["gid://shopify/Metaobject/2"]),
            },
            {
              ownerId: productId,
              key: "earliest_expiration_date",
              value: "2026-11-05",
            },
          ],
        }),
      },
      {
        operation: "DeleteBatch",
        variables: { id: "gid://shopify/Metaobject/1" },
      },
    ]);
  });

  it("writes the date it's given, not the plan's", async () => {
    const { admin, calls } = fakeAdmin(writesSucceed);

    await applyPlan(admin, productId, plan, null);

    expect(calls[1].variables).toMatchObject({
      delete: [
        {
          ownerId: productId,
          namespace: "$app",
          key: "earliest_expiration_date",
        },
      ],
    });
  });

  it("stops before later writes when a quantity is rejected", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      SetBatchQuantity: () => ({
        metaobjectUpdate: {
          userErrors: [
            { message: "Record not found", code: "RECORD_NOT_FOUND" },
          ],
        },
      }),
    });

    await expect(applyPlan(admin, productId, plan, null)).rejects.toThrow(
      "Setting batch gid://shopify/Metaobject/2 quantity failed: Record not found",
    );
    expect(calls).toHaveLength(1);
  });

  it("throws when the list or date write is rejected", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      SaveProductFreshness: () => ({
        metafieldsSet: { userErrors: [{ message: "Invalid value" }] },
      }),
    });

    await expect(applyPlan(admin, productId, plan, null)).rejects.toThrow(
      `Saving product ${productId} freshness failed: Invalid value`,
    );
  });

  it("treats a batch that's already deleted as done", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      DeleteBatch: () => ({
        metaobjectDelete: {
          userErrors: [
            { message: "Record not found", code: "RECORD_NOT_FOUND" },
          ],
        },
      }),
    });

    await expect(
      applyPlan(admin, productId, plan, null),
    ).resolves.toBeUndefined();
  });

  it("throws on any other delete error", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      DeleteBatch: () => ({
        metaobjectDelete: {
          userErrors: [{ message: "Not authorized", code: "NOT_AUTHORIZED" }],
        },
      }),
    });

    await expect(applyPlan(admin, productId, plan, null)).rejects.toThrow(
      "Deleting batch gid://shopify/Metaobject/1 failed: Not authorized",
    );
  });
});

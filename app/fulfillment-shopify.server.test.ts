import { describe, it, expect } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  PermanentShopifyError,
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
  SetBatchFields: () => ({ metaobjectUpdate: noUserErrors }),
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
      earliestExpirationDate: null,
    });
    expect(calls[0].variables).toStrictEqual({ productId, maxBatches: 250 });
  });

  it("reads a missing quantity as 0, like the panel", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () =>
        batchesResponse([{ id: "gid://shopify/Metaobject/1", quantity: null }]),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      batches: [
        { id: "gid://shopify/Metaobject/1", quantity: 0, expirationDate: "" },
      ],
      earliestExpirationDate: null,
    });
  });

  it("reports a product the app doesn't track", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({ product: { freshnessBatches: null } }),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      notTracked: true,
    });
  });

  it("returns no batches for a tracked product with an empty list", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => batchesResponse([]),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      batches: [],
      earliestExpirationDate: null,
    });
  });

  it("reads the stored earliest date", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({
        product: {
          earliestExpiration: { value: "2026-10-22" },
          freshnessBatches: {
            references: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    });

    expect(await readProductBatches(admin, productId)).toMatchObject({
      earliestExpirationDate: "2026-10-22",
    });
  });

  // null is what Shopify returns for a batch that no longer resolves
  it.each([
    ["no longer resolves", null],
    ["has no id", {}],
  ])("refuses a list with a batch that %s", async (_case, node) => {
    const { admin } = fakeAdmin({
      GetProductBatches: () =>
        batchesResponse([
          { id: "gid://shopify/Metaobject/1", quantity: { value: "3" } },
          node,
        ]),
    });

    await expect(readProductBatches(admin, productId)).rejects.toThrow(
      new PermanentShopifyError(
        `Product ${productId} has a batch list the app can't read`,
      ),
    );
  });

  it("refuses a batch list metafield with no references", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({
        product: { freshnessBatches: { references: null } },
      }),
    });

    await expect(readProductBatches(admin, productId)).rejects.toThrow(
      new PermanentShopifyError(
        `Product ${productId} has a batch list the app can't read`,
      ),
    );
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
        operation: "SetBatchFields",
        variables: {
          id: "gid://shopify/Metaobject/2",
          metaobject: { fields: [{ key: "quantity", value: "8" }] },
        },
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

  it("writes every quantity before the list, and the list before deletes", async () => {
    const { admin, calls } = fakeAdmin(writesSucceed);
    const wider: FulfillmentPlanData = {
      ...plan,
      updates: [
        { id: "gid://shopify/Metaobject/2", before: 10, after: 8 },
        { id: "gid://shopify/Metaobject/3", before: 4, after: 1 },
      ],
      deletes: [
        { id: "gid://shopify/Metaobject/1", before: 3 },
        { id: "gid://shopify/Metaobject/4", before: 2 },
      ],
    };

    await applyPlan(admin, productId, wider, null);

    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "SetBatchFields",
      "SetBatchFields",
      "SaveProductFreshness",
      "DeleteBatch",
      "DeleteBatch",
    ]);
  });

  // Each write takes a few ms, so overlapping writes are counted as in flight
  function slowAdmin(failIds: string[] = []) {
    const state = { inFlight: 0, mostInFlight: 0, finished: 0 };
    const admin = {
      graphql: async (
        query: string,
        options?: { variables?: { id?: string } },
      ) => {
        state.inFlight += 1;
        state.mostInFlight = Math.max(state.mostInFlight, state.inFlight);
        const id = options?.variables?.id ?? "";
        // Failures come back first, so a waiting caller is observable
        await new Promise((resolve) =>
          setTimeout(resolve, failIds.includes(id) ? 1 : 10),
        );
        state.inFlight -= 1;
        state.finished += 1;
        const userErrors = failIds.includes(id)
          ? [{ message: `Rejected ${id}`, code: "INVALID" }]
          : [];
        const data = query.includes("SetBatchFields")
          ? { metaobjectUpdate: { userErrors } }
          : { metafieldsSet: noUserErrors };
        return Response.json({ data });
      },
    } as unknown as AdminApiContext;
    return { admin, state };
  }

  const updatesFor = (count: number): FulfillmentPlanData => ({
    ...plan,
    updates: Array.from({ length: count }, (_, index) => ({
      id: `gid://shopify/Metaobject/${index + 10}`,
      before: 5,
      after: 4,
    })),
    deletes: [],
  });

  it("sends a step's writes together, not one after another", async () => {
    const { admin, state } = slowAdmin();

    await applyPlan(admin, productId, updatesFor(2), null);

    expect(state.mostInFlight).toBe(2);
  });

  it("keeps at most 10 writes in flight", async () => {
    const { admin, state } = slowAdmin();

    await applyPlan(admin, productId, updatesFor(25), null);

    expect(state.mostInFlight).toBe(10);
    // 25 quantity writes, then the list write
    expect(state.finished).toBe(26);
  });

  it("waits for every write and reports every failure", async () => {
    const failIds = [
      "gid://shopify/Metaobject/10",
      "gid://shopify/Metaobject/12",
    ];
    const { admin, state } = slowAdmin(failIds);

    await expect(
      applyPlan(admin, productId, updatesFor(3), null),
    ).rejects.toThrow(
      "Setting batch gid://shopify/Metaobject/10 quantity failed: Rejected gid://shopify/Metaobject/10; " +
        "Setting batch gid://shopify/Metaobject/12 quantity failed: Rejected gid://shopify/Metaobject/12",
    );
    // The slower, successful write had finished before applyPlan threw
    expect(state.finished).toBe(3);
  });

  it("doesn't write the list when any quantity is rejected", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      SetBatchFields: ({ id }: { id: string }) => ({
        metaobjectUpdate: {
          userErrors:
            id === "gid://shopify/Metaobject/3"
              ? [{ message: "Invalid value", code: "INVALID" }]
              : [],
        },
      }),
    });
    const twoUpdates: FulfillmentPlanData = {
      ...plan,
      updates: [
        { id: "gid://shopify/Metaobject/2", before: 10, after: 8 },
        { id: "gid://shopify/Metaobject/3", before: 4, after: 1 },
      ],
    };

    await expect(applyPlan(admin, productId, twoUpdates, null)).rejects.toThrow(
      "Setting batch gid://shopify/Metaobject/3 quantity failed: Invalid value",
    );
    expect(calls.map(({ operation }) => operation)).not.toContain(
      "SaveProductFreshness",
    );
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
      SetBatchFields: () => ({
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
      new PermanentShopifyError(
        `Saving product ${productId} freshness failed: Invalid value`,
      ),
    );
  });

  it("keeps a network failure retryable alongside a rejection", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      SetBatchFields: ({ id }: { id: string }) => {
        if (id === "gid://shopify/Metaobject/2") throw new Error("Timed out");
        return {
          metaobjectUpdate: { userErrors: [{ message: "Invalid value" }] },
        };
      },
    });
    const twoUpdates: FulfillmentPlanData = {
      ...plan,
      updates: [
        { id: "gid://shopify/Metaobject/2", before: 10, after: 8 },
        { id: "gid://shopify/Metaobject/3", before: 4, after: 1 },
      ],
    };

    const error = await applyPlan(admin, productId, twoUpdates, null).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentShopifyError);
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

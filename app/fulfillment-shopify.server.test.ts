import { describe, it, expect, afterEach, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  BatchListChangedError,
  BatchesChangedError,
  PermanentShopifyError,
  applyPlan,
  deleteBatches,
  findListedHandles,
  readProductBatches,
  readShopToday,
  saveBatchList,
  upsertBatches,
} from "./fulfillment-shopify.server";
import type { FulfillmentPlanData } from "../shared/fulfillment-plan";
import { fakeShopify, listDigest } from "../test/fake-shopify";

const productId = "gid://shopify/Product/1";

afterEach(() => vi.restoreAllMocks());

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

const batchNode = (id: number, quantity: number, date: string) => ({
  id: `gid://shopify/Metaobject/${id}`,
  quantity: { value: String(quantity) },
  expirationDate: { value: date },
});
const listResponse = (nodes: unknown[]) => ({
  product: {
    freshnessBatches: {
      compareDigest: "digest-1",
      references: { nodes, pageInfo: { hasNextPage: false } },
    },
  },
});
const plan: FulfillmentPlanData = {
  updates: [{ id: "gid://shopify/Metaobject/2", before: 10, after: 8 }],
  deletes: [{ id: "gid://shopify/Metaobject/1", before: 3 }],
};

// A plan's batches as applyPlan rereads them, after its quantity writes
function listAfter({ updates, deletes }: FulfillmentPlanData) {
  return listResponse(
    [
      ...deletes.map(({ id, before }) => ({ id, quantity: before })),
      ...updates.map(({ id, after }) => ({ id, quantity: after })),
    ].map(({ id, quantity }) => ({
      id,
      quantity: { value: String(quantity) },
      expirationDate: { value: "2026-11-05" },
    })),
  );
}

const writesSucceed = {
  GetProductBatches: () =>
    listResponse([
      batchNode(1, 3, "2026-10-22"),
      batchNode(2, 8, "2026-11-05"),
    ]),
  SetBatchFields: () => ({ metaobjectUpdate: noUserErrors }),
  SaveBatchList: () => ({ metafieldsSet: noUserErrors }),
  SaveProductFreshness: () => ({
    metafieldsSet: noUserErrors,
    metafieldsDelete: null,
  }),
  DeleteBatch: () => ({ metaobjectDelete: noUserErrors }),
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
      freshnessBatches: {
        compareDigest: "digest-1",
        references: { nodes, pageInfo: { hasNextPage } },
      },
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
      listDigest: "digest-1",
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
      listDigest: "digest-1",
    });
  });

  it("reports a product the app doesn't track", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => ({ product: { freshnessBatches: null } }),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      notTracked: true,
      earliestExpirationDate: null,
    });
  });

  it("returns no batches for a tracked product with an empty list", async () => {
    const { admin } = fakeAdmin({
      GetProductBatches: () => batchesResponse([]),
    });

    expect(await readProductBatches(admin, productId)).toStrictEqual({
      batches: [],
      earliestExpirationDate: null,
      listDigest: "digest-1",
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
  it("sets quantities, then the list and date together, then deletes", async () => {
    const { admin, calls } = fakeAdmin(writesSucceed);

    await applyPlan(admin, productId, plan);

    expect(calls).toStrictEqual([
      {
        operation: "SetBatchFields",
        variables: {
          id: "gid://shopify/Metaobject/2",
          metaobject: { fields: [{ key: "quantity", value: "8" }] },
        },
      },
      { operation: "GetProductBatches", variables: expect.anything() },
      {
        operation: "SaveProductFreshness",
        variables: expect.objectContaining({
          set: [
            {
              ownerId: productId,
              key: "freshness_batches",
              value: JSON.stringify(["gid://shopify/Metaobject/2"]),
              compareDigest: "digest-1",
            },
            {
              ownerId: productId,
              key: "earliest_expiration_date",
              value: "2026-11-05",
            },
          ],
          delete: [],
        }),
      },
      {
        operation: "DeleteBatch",
        variables: { id: "gid://shopify/Metaobject/1" },
      },
    ]);
  });

  it("writes every quantity, then the list and date, then every delete", async () => {
    const wider: FulfillmentPlanData = {
      updates: [
        { id: "gid://shopify/Metaobject/2", before: 10, after: 8 },
        { id: "gid://shopify/Metaobject/3", before: 4, after: 1 },
      ],
      deletes: [
        { id: "gid://shopify/Metaobject/1", before: 3 },
        { id: "gid://shopify/Metaobject/4", before: 2 },
      ],
    };
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      GetProductBatches: () => listAfter(wider),
    });

    await applyPlan(admin, productId, wider);

    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "SetBatchFields",
      "SetBatchFields",
      "GetProductBatches",
      "SaveProductFreshness",
      "DeleteBatch",
      "DeleteBatch",
    ]);
  });

  // Each write takes a few ms, so overlapping writes are counted as in flight
  function slowAdmin(forPlan: FulfillmentPlanData, failIds: string[] = []) {
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
          : query.includes("GetProductBatches")
            ? listAfter(forPlan)
            : { metafieldsSet: noUserErrors };
        return Response.json({ data });
      },
    } as unknown as AdminApiContext;
    return { admin, state };
  }

  const updatesFor = (count: number): FulfillmentPlanData => ({
    updates: Array.from({ length: count }, (_, index) => ({
      id: `gid://shopify/Metaobject/${index + 10}`,
      before: 5,
      after: 4,
    })),
    deletes: [],
  });

  it("sends a step's writes together, not one after another", async () => {
    const twoUpdates = updatesFor(2);
    const { admin, state } = slowAdmin(twoUpdates);

    await applyPlan(admin, productId, twoUpdates);

    expect(state.mostInFlight).toBe(2);
  });

  it("keeps at most 10 writes in flight", async () => {
    const manyUpdates = updatesFor(25);
    const { admin, state } = slowAdmin(manyUpdates);

    await applyPlan(admin, productId, manyUpdates);

    expect(state.mostInFlight).toBe(10);
    // 25 quantity writes, the reread, then the list and date
    expect(state.finished).toBe(27);
  });

  it("waits for every write and reports every failure", async () => {
    const failIds = [
      "gid://shopify/Metaobject/10",
      "gid://shopify/Metaobject/12",
    ];
    const threeUpdates = updatesFor(3);
    const { admin, state } = slowAdmin(threeUpdates, failIds);

    await expect(applyPlan(admin, productId, threeUpdates)).rejects.toThrow(
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

    await expect(applyPlan(admin, productId, twoUpdates)).rejects.toThrow(
      "Setting batch gid://shopify/Metaobject/3 quantity failed: Invalid value",
    );
    expect(calls.map(({ operation }) => operation)).not.toContain(
      "SaveBatchList",
    );
  });

  it("writes the list and date from the batches it rereads", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      // Another client added batch 3 after the plan was made
      GetProductBatches: () =>
        listResponse([
          batchNode(1, 3, "2026-10-22"),
          batchNode(2, 8, "2026-11-05"),
          batchNode(3, 4, "2026-10-30"),
        ]),
    });

    await applyPlan(admin, productId, plan);

    expect(calls[2].variables).toMatchObject({
      set: [
        {
          key: "freshness_batches",
          value: JSON.stringify([
            "gid://shopify/Metaobject/2",
            "gid://shopify/Metaobject/3",
          ]),
        },
        { key: "earliest_expiration_date", value: "2026-10-30" },
      ],
    });
  });

  it("stops without writing the list when a batch it touches changed", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      // The batch it empties was restocked meanwhile
      GetProductBatches: () =>
        listResponse([
          batchNode(1, 20, "2026-10-22"),
          batchNode(2, 8, "2026-11-05"),
        ]),
    });

    const error = await applyPlan(admin, productId, plan).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BatchesChangedError);
    expect(error).not.toBeInstanceOf(PermanentShopifyError);
    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "SetBatchFields",
      "GetProductBatches",
    ]);
  });

  const stale = {
    metafieldsSet: {
      userErrors: [{ message: "Modified", code: "STALE_OBJECT" }],
    },
    metafieldsDelete: null,
  };

  it("rereads and writes again when the list changed meanwhile", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let saves = 0;
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      SaveProductFreshness: () =>
        ++saves === 1 ? stale : writesSucceed.SaveProductFreshness(),
    });

    await applyPlan(admin, productId, plan);

    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "SetBatchFields",
      "GetProductBatches",
      "SaveProductFreshness",
      "GetProductBatches",
      "SaveProductFreshness",
      "DeleteBatch",
    ]);
  });

  it("leaves it to the job's retries after three changed lists", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      SaveProductFreshness: () => stale,
    });

    const error = await applyPlan(admin, productId, plan).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BatchListChangedError);
    expect(error).not.toBeInstanceOf(PermanentShopifyError);
    const operations = calls.map(({ operation }) => operation);
    expect(
      operations.filter((name) => name === "SaveProductFreshness"),
    ).toHaveLength(3);
    expect(operations).not.toContain("DeleteBatch");
  });

  it("fails for good when the product is gone on reread", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      GetProductBatches: () => ({ product: null }),
    });

    await expect(applyPlan(admin, productId, plan)).rejects.toThrow(
      new PermanentShopifyError(
        `Rereading product ${productId} failed: product_not_found`,
      ),
    );
  });

  it("deletes the list, unchecked, when it empties every batch", async () => {
    const emptiesAll: FulfillmentPlanData = {
      updates: [],
      deletes: [{ id: "gid://shopify/Metaobject/1", before: 3 }],
    };
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      GetProductBatches: () => listAfter(emptiesAll),
    });

    await applyPlan(admin, productId, emptiesAll);

    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "GetProductBatches",
      "SaveProductFreshness",
      "DeleteBatch",
    ]);
    expect(calls[1].variables).toMatchObject({
      set: [],
      delete: [
        { key: "freshness_batches" },
        { key: "earliest_expiration_date" },
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

    await expect(applyPlan(admin, productId, plan)).rejects.toThrow(
      "Setting batch gid://shopify/Metaobject/2 quantity failed: Record not found",
    );
    expect(calls).toHaveLength(1);
  });

  it("throws when the list and date write is rejected", async () => {
    const { admin } = fakeAdmin({
      ...writesSucceed,
      SaveProductFreshness: () => ({
        metafieldsSet: { userErrors: [{ message: "Invalid value" }] },
      }),
    });

    await expect(applyPlan(admin, productId, plan)).rejects.toThrow(
      new PermanentShopifyError(
        `Saving product ${productId} freshness failed: Invalid value`,
      ),
    );
  });

  // Batch 2 is left, but it has no readable date
  const undatedList = () =>
    listResponse([batchNode(1, 3, "2026-10-22"), batchNode(2, 8, "")]);

  it("clears the date right after the list when no batch left has one", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      GetProductBatches: undatedList,
    });

    await applyPlan(admin, productId, plan);

    expect(calls.map(({ operation }) => operation)).toStrictEqual([
      "SetBatchFields",
      "GetProductBatches",
      "SaveBatchList",
      "SaveProductFreshness",
      "DeleteBatch",
    ]);
    expect(calls[2].variables).toMatchObject({ compareDigest: "digest-1" });
    expect(calls[3].variables).toMatchObject({
      set: [],
      delete: [{ key: "earliest_expiration_date" }],
    });
  });

  it("stops before the deletes when the date clear is rejected", async () => {
    const { admin, calls } = fakeAdmin({
      ...writesSucceed,
      GetProductBatches: undatedList,
      SaveProductFreshness: () => ({
        metafieldsSet: null,
        metafieldsDelete: { userErrors: [{ message: "Invalid value" }] },
      }),
    });

    await expect(applyPlan(admin, productId, plan)).rejects.toThrow(
      PermanentShopifyError,
    );
    expect(calls.map(({ operation }) => operation)).not.toContain(
      "DeleteBatch",
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

    const error = await applyPlan(admin, productId, twoUpdates).catch(
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

    await expect(applyPlan(admin, productId, plan)).resolves.toBeUndefined();
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

    await expect(applyPlan(admin, productId, plan)).rejects.toThrow(
      "Deleting batch gid://shopify/Metaobject/1 failed: Not authorized",
    );
  });
});

describe("adding batches", () => {
  const HANDLE = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";
  const OTHER_HANDLE = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
  const LISTED = "gid://shopify/Metaobject/1";

  function setup() {
    const shopify = fakeShopify();
    shopify.addProduct(productId, {
      [LISTED]: { quantity: 6, expirationDate: "2026-10-23" },
    });
    return shopify;
  }

  describe("findListedHandles", () => {
    it("returns only the handles of batches a product lists", async () => {
      const shopify = setup();
      shopify.setHandle(LISTED, OTHER_HANDLE);
      const { ids } = await upsertBatches(shopify.admin, [
        { handle: HANDLE, quantity: 1, expirationDate: "2026-11-01" },
      ]);
      const NEW = "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d";

      expect(ids.get(HANDLE)).toBeDefined();
      // HANDLE exists but no product lists it, like a failed save's leftover
      expect(
        await findListedHandles(shopify.admin, [HANDLE, OTHER_HANDLE, NEW]),
      ).toStrictEqual(new Set([OTHER_HANDLE]));
    });
  });

  describe("upsertBatches", () => {
    it("creates each batch and returns its id by handle", async () => {
      const shopify = setup();

      const { ids, failed } = await upsertBatches(shopify.admin, [
        { handle: HANDLE, quantity: 3, expirationDate: "2026-11-01" },
      ]);

      expect(failed).toStrictEqual([]);
      expect(shopify.batch(ids.get(HANDLE)!)).toEqual({
        quantity: 3,
        expirationDate: "2026-11-01",
      });
    });

    it("reuses the batch with the same handle instead of duplicating it", async () => {
      const shopify = setup();
      const first = await upsertBatches(shopify.admin, [
        { handle: HANDLE, quantity: 3, expirationDate: "2026-11-01" },
      ]);

      const retry = await upsertBatches(shopify.admin, [
        { handle: HANDLE, quantity: 4, expirationDate: "2026-11-02" },
      ]);

      expect(retry.ids.get(HANDLE)).toBe(first.ids.get(HANDLE));
      expect(shopify.batch(retry.ids.get(HANDLE)!)).toEqual({
        quantity: 4,
        expirationDate: "2026-11-02",
      });
    });

    it("lists the batches Shopify rejects and still creates the rest", async () => {
      const shopify = setup();
      shopify.rejectNext("UpsertBatch");
      const rejected = {
        handle: HANDLE,
        quantity: 3,
        expirationDate: "2026-11-01",
      };

      const { ids, failed } = await upsertBatches(shopify.admin, [
        rejected,
        { handle: OTHER_HANDLE, quantity: 5, expirationDate: "2026-11-03" },
      ]);

      expect(failed.map(({ batch }) => batch)).toStrictEqual([rejected]);
      expect(failed[0].error).toBeInstanceOf(PermanentShopifyError);
      expect((failed[0].error as Error).message).toBe(
        `Saving new batch ${HANDLE} failed: Invalid value`,
      );
      expect([...ids.keys()]).toStrictEqual([OTHER_HANDLE]);
    });
  });

  describe("saveBatchList", () => {
    const NEW_ID = "gid://shopify/Metaobject/2";

    it("writes the list when it's still the one read", async () => {
      const shopify = setup();

      await saveBatchList(
        shopify.admin,
        productId,
        [LISTED, NEW_ID],
        listDigest([LISTED]),
      );

      expect(shopify.product(productId)?.batchIds).toStrictEqual([
        LISTED,
        NEW_ID,
      ]);
    });

    it("creates the list for a product that had none", async () => {
      const shopify = setup();
      shopify.addProduct("gid://shopify/Product/2", null);

      await saveBatchList(
        shopify.admin,
        "gid://shopify/Product/2",
        [NEW_ID],
        null,
      );

      expect(
        shopify.product("gid://shopify/Product/2")?.batchIds,
      ).toStrictEqual([NEW_ID]);
    });

    it.each([
      ["the list changed since it was read", listDigest([])],
      ["a list appeared where there was none", null],
    ])("refuses when %s", async (_case, digest) => {
      const shopify = setup();

      await expect(
        saveBatchList(shopify.admin, productId, [NEW_ID], digest),
      ).rejects.toThrow(BatchListChangedError);
      expect(shopify.product(productId)?.batchIds).toStrictEqual([LISTED]);
    });

    it("sends a null digest explicitly, so Shopify still checks it", async () => {
      const { admin, calls } = fakeAdmin({
        SaveBatchList: () => ({ metafieldsSet: noUserErrors }),
      });

      await saveBatchList(admin, productId, [NEW_ID], null);

      expect(calls[0].variables).toHaveProperty("compareDigest", null);
    });

    it("throws a permanent error for any other rejection", async () => {
      const shopify = setup();
      shopify.rejectNext("SaveBatchList");

      await expect(
        saveBatchList(shopify.admin, productId, [NEW_ID], listDigest([LISTED])),
      ).rejects.toThrow(PermanentShopifyError);
    });
  });

  describe("deleteBatches", () => {
    it("deletes each batch and returns the ones that failed", async () => {
      const shopify = setup();
      shopify.failNext("DeleteBatch");
      const { ids } = await upsertBatches(shopify.admin, [
        { handle: HANDLE, quantity: 1, expirationDate: "2026-11-01" },
        { handle: OTHER_HANDLE, quantity: 2, expirationDate: "2026-11-02" },
      ]);
      const [first, second] = [ids.get(HANDLE)!, ids.get(OTHER_HANDLE)!];

      expect(await deleteBatches(shopify.admin, [first, second])).toStrictEqual(
        [first],
      );
      expect(shopify.batch(first)).toBeDefined();
      expect(shopify.batch(second)).toBeUndefined();
    });
  });
});

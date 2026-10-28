import { describe, it, expect } from "vitest";

import {
  deleteBatchErrors,
  isReadableBatch,
  planProductMetafieldWrites,
  saveProductFreshnessVariables,
} from "./product-metafields";

describe("isReadableBatch", () => {
  it("accepts a batch with an id", () => {
    expect(isReadableBatch({ id: "gid://shopify/Metaobject/1" })).toBe(true);
  });

  it.each([null, {}, { id: "" }])("rejects %j", (node) => {
    expect(isReadableBatch(node)).toBe(false);
  });
});

describe("planProductMetafieldWrites", () => {
  const productId = "gid://shopify/Product/1";
  const batchIds = ["gid://shopify/Metaobject/1", "gid://shopify/Metaobject/2"];

  it("sets the batch list and earliest date when a batch is in stock", () => {
    expect(
      planProductMetafieldWrites(productId, batchIds, "2026-10-22"),
    ).toStrictEqual({
      set: [
        {
          ownerId: productId,
          key: "freshness_batches",
          value: JSON.stringify(batchIds),
        },
        {
          ownerId: productId,
          key: "earliest_expiration_date",
          value: "2026-10-22",
        },
      ],
      delete: [],
    });
  });

  it("deletes the earliest date when nothing is in stock", () => {
    expect(planProductMetafieldWrites(productId, batchIds, null)).toStrictEqual(
      {
        set: [
          {
            ownerId: productId,
            key: "freshness_batches",
            value: JSON.stringify(batchIds),
          },
        ],
        delete: [
          {
            ownerId: productId,
            namespace: "$app",
            key: "earliest_expiration_date",
          },
        ],
      },
    );
  });

  it("deletes both metafields when the product has no batches left", () => {
    expect(planProductMetafieldWrites(productId, [], null)).toStrictEqual({
      set: [],
      delete: [
        { ownerId: productId, namespace: "$app", key: "freshness_batches" },
        {
          ownerId: productId,
          namespace: "$app",
          key: "earliest_expiration_date",
        },
      ],
    });
  });
});

describe("saveProductFreshnessVariables", () => {
  const productId = "gid://shopify/Product/1";

  it("includes only the mutations that have writes", () => {
    expect(saveProductFreshnessVariables(productId, [], null)).toMatchObject({
      set: [],
      hasSet: false,
      hasDelete: true,
    });
    expect(
      saveProductFreshnessVariables(
        productId,
        ["gid://shopify/Metaobject/1"],
        "2026-10-22",
      ),
    ).toMatchObject({ delete: [], hasSet: true, hasDelete: false });
  });
});

describe("deleteBatchErrors", () => {
  const error = (code: string) => ({ field: ["id"], message: code, code });
  const payload = (...codes: string[]) => ({
    deletedId: null,
    userErrors: codes.map(error),
  });

  it("treats a batch that's already gone as deleted", () => {
    expect(deleteBatchErrors(payload("RECORD_NOT_FOUND"))).toEqual([]);
  });

  it("keeps any other error", () => {
    expect(
      deleteBatchErrors(payload("RECORD_NOT_FOUND", "NOT_AUTHORIZED")),
    ).toEqual([error("NOT_AUTHORIZED")]);
  });

  it("is empty when there's no payload, leaving that to the caller", () => {
    expect(deleteBatchErrors(null)).toEqual([]);
    expect(deleteBatchErrors(undefined)).toEqual([]);
  });
});

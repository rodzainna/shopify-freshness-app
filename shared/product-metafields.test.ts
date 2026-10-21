import { describe, it, expect } from "vitest";

import {
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

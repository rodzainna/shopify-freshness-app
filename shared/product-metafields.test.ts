import { describe, it, expect } from "vitest";

import { planProductMetafieldWrites } from "./product-metafields";

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

import { describe, it, expect } from "vitest";

import {
  type DashboardProductNode,
  UNREADABLE,
  toDashboardRows,
} from "./dashboard";

const TODAY = "2026-10-19";

function product(
  overrides: Partial<DashboardProductNode> = {},
): DashboardProductNode {
  return {
    id: "gid://shopify/Product/1",
    legacyResourceId: "1",
    title: "Sourdough loaf",
    featuredMedia: null,
    earliestExpiration: null,
    freshnessBatches: null,
    ...overrides,
  };
}

function batch(id: string, quantity: string, expirationDate: string) {
  return {
    id,
    quantity: { value: quantity },
    expirationDate: { value: expirationDate },
  };
}

describe("toDashboardRows", () => {
  it("shapes each batch with its own live status", () => {
    const [row] = toDashboardRows(
      [
        product({
          earliestExpiration: { value: "2026-10-10" },
          freshnessBatches: {
            references: {
              nodes: [
                batch("gid://shopify/Metaobject/1", "3", "2026-10-10"),
                batch("gid://shopify/Metaobject/2", "10", "2026-11-20"),
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row).toStrictEqual({
      id: "gid://shopify/Product/1",
      title: "Sourdough loaf",
      adminUrl: "shopify://admin/products/1",
      imageUrl: null,
      earliestExpirationDate: "2026-10-10",
      status: "Expired",
      batches: [
        {
          id: "gid://shopify/Metaobject/1",
          quantity: 3,
          expirationDate: "2026-10-10",
          freshness: { status: "Expired", daysRemaining: -9 },
        },
        {
          id: "gid://shopify/Metaobject/2",
          quantity: 10,
          expirationDate: "2026-11-20",
          freshness: { status: "Fresh", daysRemaining: 32 },
        },
      ],
      hasMoreBatches: false,
    });
  });

  it("gives a product with no batch metafield an empty batch list", () => {
    expect(toDashboardRows([product()], TODAY)).toStrictEqual([
      {
        id: "gid://shopify/Product/1",
        title: "Sourdough loaf",
        adminUrl: "shopify://admin/products/1",
        imageUrl: null,
        earliestExpirationDate: null,
        status: "Not set",
        batches: [],
        hasMoreBatches: false,
      },
    ]);
  });

  it("flags products with more batches than were loaded", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [batch("gid://shopify/Metaobject/1", "1", "2026-11-01")],
              pageInfo: { hasNextPage: true },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.hasMoreBatches).toBe(true);
  });

  // null is what Shopify returns for a batch that no longer resolves
  it.each([
    ["no longer resolves", null],
    ["has no id", {}],
  ])("can't show a status when a batch %s", (_case, node) => {
    const rows = toDashboardRows(
      [
        product({
          earliestExpiration: { value: "2026-10-10" },
          freshnessBatches: {
            references: {
              nodes: [
                batch("gid://shopify/Metaobject/1", "3", "2026-11-01"),
                node,
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
        product({ id: "gid://shopify/Product/2" }),
      ],
      TODAY,
    );

    expect(rows).toStrictEqual([
      {
        id: "gid://shopify/Product/1",
        title: "Sourdough loaf",
        adminUrl: "shopify://admin/products/1",
        imageUrl: null,
        earliestExpirationDate: "2026-10-10",
        status: UNREADABLE,
        batches: [],
        hasMoreBatches: false,
      },
      expect.objectContaining({
        id: "gid://shopify/Product/2",
        status: "Not set",
      }),
    ]);
  });

  it("leaves the status empty when a stored date isn't a calendar date", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [{ id: "gid://shopify/Metaobject/1" }],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.batches).toStrictEqual([
      {
        id: "gid://shopify/Metaobject/1",
        quantity: 0,
        expirationDate: "",
        freshness: null,
      },
    ]);
  });

  it("leaves the status empty for a date that doesn't exist", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [batch("gid://shopify/Metaobject/1", "2", "2026-02-30")],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.batches[0].freshness).toBeNull();
  });

  it("ignores sold-out batches in the product status", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [
                batch("gid://shopify/Metaobject/1", "0", "2026-10-10"),
                batch("gid://shopify/Metaobject/2", "5", "2026-11-20"),
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.status).toBe("Fresh");
  });

  it("is Not set when every batch is sold out", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [batch("gid://shopify/Metaobject/1", "0", "2026-10-10")],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.status).toBe("Not set");
  });

  it("doesn't fail on an unreadable stored date", () => {
    const [row] = toDashboardRows(
      [
        product({
          freshnessBatches: {
            references: {
              nodes: [
                batch("gid://shopify/Metaobject/1", "2", "2026-02-30"),
                batch("gid://shopify/Metaobject/2", "5", "2026-10-21"),
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      ],
      TODAY,
    );

    expect(row.status).toBe("Use Soon");
  });

  it("recomputes status from today rather than storing it", () => {
    const stored = [
      product({
        freshnessBatches: {
          references: {
            nodes: [batch("gid://shopify/Metaobject/1", "6", "2026-10-25")],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    ];

    // Same stored data on each day either side of the thresholds
    const statusOn = (today: string) => {
      const [row] = toDashboardRows(stored, today);
      return [row.status, row.batches[0].freshness?.status];
    };

    expect(statusOn("2026-10-21")).toStrictEqual(["Fresh", "Fresh"]); // 4 days
    expect(statusOn("2026-10-22")).toStrictEqual(["Use Soon", "Use Soon"]); // 3 days
    expect(statusOn("2026-10-25")).toStrictEqual(["Use Soon", "Use Soon"]); // expiry day
    expect(statusOn("2026-10-26")).toStrictEqual(["Expired", "Expired"]); // 1 day past
  });

  it("links to the product's admin page and passes on its image", () => {
    const image = { url: "https://cdn.shopify.com/loaf.jpg", altText: null };
    const [withImage, withoutImage] = toDashboardRows(
      [
        product({
          legacyResourceId: "9658528694493",
          featuredMedia: { preview: { image } },
        }),
        product({ id: "gid://shopify/Product/2" }),
      ],
      TODAY,
    );

    expect(withImage).toMatchObject({
      adminUrl: "shopify://admin/products/9658528694493",
      imageUrl: "https://cdn.shopify.com/loaf.jpg",
    });
    expect(withoutImage.imageUrl).toBeNull();
  });

  it("returns no rows for a store with no products", () => {
    expect(toDashboardRows([], TODAY)).toStrictEqual([]);
  });

  it("keeps products in the order the query returned them", () => {
    const rows = toDashboardRows(
      [
        product({ id: "gid://shopify/Product/2", title: "Bagels" }),
        product({ id: "gid://shopify/Product/1", title: "Croissants" }),
      ],
      TODAY,
    );

    expect(rows.map((row) => row.title)).toStrictEqual([
      "Bagels",
      "Croissants",
    ]);
  });
});

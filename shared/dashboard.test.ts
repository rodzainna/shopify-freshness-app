import { describe, it, expect } from "vitest";

import { type DashboardProductNode, toDashboardRows } from "./dashboard";

const TODAY = "2026-10-19";

function product(
  overrides: Partial<DashboardProductNode> = {},
): DashboardProductNode {
  return {
    id: "gid://shopify/Product/1",
    title: "Sourdough loaf",
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

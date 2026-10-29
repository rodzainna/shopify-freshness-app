import { describe, it, expect, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  EXPORT_LIMIT,
  ExportChangedError,
  loadExportProducts,
} from "./export.server";
import { parseDashboardFilters } from "../shared/dashboard-filters";

// 2026-10-29 in UTC, already 2026-10-30 in Auckland
const NOW = new Date("2026-10-29T12:00:00Z");

const batch = (n: number) => ({
  id: `gid://shopify/Metaobject/${n}`,
  quantity: { value: "1" },
  expirationDate: { value: "2026-11-01" },
});

const product = (n: number, batchCount = 1) => ({
  id: `gid://shopify/Product/${n}`,
  legacyResourceId: String(n),
  title: `Product ${n}`,
  vendor: "Vendor",
  productType: "Type",
  tracksInventory: true,
  totalInventory: batchCount,
  batches: Array.from({ length: batchCount }, (_, i) => batch(n * 1000 + i)),
});

type FakeProduct = ReturnType<typeof product>;

interface ShopOptions {
  timezone?: string;
  // What productsCount reports, when a test needs it to differ from the list
  count?: number;
  // A change another client makes just before each later batch read
  beforeMoreBatches?: () => void;
}

// A fake Admin API paging products and batches by `first`, with numeric cursors
function fakeShop(
  products: FakeProduct[],
  { timezone = "UTC", count, beforeMoreBatches }: ShopOptions = {},
) {
  // Changes whenever the batch list does, like Shopify's compareDigest
  const digest = (batches: FakeProduct["batches"]) =>
    batches.map(({ id }) => id).join();
  const page = <T>(items: T[], after: unknown, first: unknown) => {
    const start = Number(after ?? 0);
    const end = start + Number(first);
    return {
      nodes: items.slice(start, end),
      pageInfo: { hasNextPage: end < items.length, endCursor: String(end) },
    };
  };
  const graphql = vi.fn(
    async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      const variables = options?.variables ?? {};
      let data: unknown;
      if (query.includes("ExportMoreBatches")) {
        beforeMoreBatches?.();
        const found = products.find(({ id }) => id === variables.id);
        data = {
          product: found && {
            freshnessBatches: {
              compareDigest: digest(found.batches),
              references: page(
                found.batches,
                variables.after,
                variables.batchLimit,
              ),
            },
          },
        };
      } else {
        const { nodes, pageInfo } = page(
          products,
          variables.after,
          variables.first,
        );
        data = {
          productsCount: variables.withCount
            ? {
                count: Math.min(
                  count ?? products.length,
                  Number(variables.countLimit),
                ),
              }
            : undefined,
          shop: { ianaTimezone: timezone },
          products: {
            nodes: nodes.map(({ batches, ...fields }) => ({
              ...fields,
              freshnessBatches: batches.length
                ? {
                    compareDigest: digest(batches),
                    references: page(batches, null, variables.batchLimit),
                  }
                : null,
            })),
            pageInfo,
          },
        };
      }
      return { json: async () => ({ data }) };
    },
  );
  return { admin: { graphql } as unknown as AdminApiContext, graphql };
}

const products = (count: number) =>
  Array.from({ length: count }, (_, i) => product(i + 1));
const filters = (search = "") =>
  parseDashboardFilters(new URLSearchParams(search));
const queriesNamed = (
  graphql: ReturnType<typeof fakeShop>["graphql"],
  name: string,
) => graphql.mock.calls.filter(([query]) => query.includes(name));

describe("loadExportProducts", () => {
  it("reads products 250 at a time until there are no more", async () => {
    const { admin, graphql } = fakeShop(products(600));

    const result = await loadExportProducts(admin, filters(), NOW);

    expect(result.kind === "ready" && result.products).toHaveLength(600);
    expect(
      queriesNamed(graphql, "ExportProducts").map(
        ([, options]) => options?.variables?.after,
      ),
    ).toStrictEqual([null, "250", "500"]);
  });

  it("exports exactly 1,000 products", async () => {
    const { admin } = fakeShop(products(EXPORT_LIMIT));

    const result = await loadExportProducts(admin, filters(), NOW);

    expect(result.kind === "ready" && result.products).toHaveLength(
      EXPORT_LIMIT,
    );
  });

  it("refuses more than 1,000 products after one request", async () => {
    const { admin, graphql } = fakeShop(products(EXPORT_LIMIT + 1));

    const result = await loadExportProducts(admin, filters(), NOW);

    expect(result).toStrictEqual({ kind: "tooMany" });
    expect(queriesNamed(graphql, "ExportProducts")).toHaveLength(1);
  });

  it("counts only up to one past the limit", async () => {
    const { admin, graphql } = fakeShop(products(1));

    await loadExportProducts(admin, filters(), NOW);

    expect(graphql.mock.calls[0][1]?.variables?.countLimit).toBe(
      EXPORT_LIMIT + 1,
    );
  });

  it("fails instead of rereading from the start when there's no cursor", async () => {
    const { admin, graphql } = fakeShop(products(300));
    const read = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, options) => {
      const response = await read(query, options);
      const { data } = (await response.json()) as {
        data: { products: { pageInfo: { endCursor: string | null } } };
      };
      data.products.pageInfo.endCursor = null;
      return { json: async () => ({ data }) };
    });

    await expect(loadExportProducts(admin, filters(), NOW)).rejects.toThrow(
      "Shopify gave no cursor for the next page",
    );
    expect(queriesNamed(graphql, "ExportProducts")).toHaveLength(1);
  });

  it("still stops at 1,000 when products are added during the read", async () => {
    const { admin, graphql } = fakeShop(products(EXPORT_LIMIT + 1), {
      count: EXPORT_LIMIT,
    });

    const result = await loadExportProducts(admin, filters(), NOW);

    expect(result).toStrictEqual({ kind: "tooMany" });
    expect(queriesNamed(graphql, "ExportProducts")).toHaveLength(4);
    expect(
      queriesNamed(graphql, "ExportProducts").map(
        ([, options]) => options?.variables?.withCount,
      ),
    ).toStrictEqual([true, false, false, false]);
  });

  it("passes the dashboard's search and sort to Shopify", async () => {
    const { admin, graphql } = fakeShop(products(1));

    await loadExportProducts(admin, filters("q=milk&sort=vendor-desc"), NOW);

    expect(graphql.mock.calls[0][1]?.variables).toMatchObject({
      query: expect.stringContaining("milk"),
      sortKey: "VENDOR",
      reverse: true,
    });
  });

  it("reads every batch of a product with more than 250", async () => {
    const { admin, graphql } = fakeShop([product(1, 600), product(2, 3)]);

    const result = await loadExportProducts(admin, filters(), NOW);

    if (result.kind !== "ready") throw new Error("expected a file");
    const references = result.products[0].freshnessBatches?.references;
    expect(references?.nodes).toHaveLength(600);
    expect(references?.pageInfo.hasNextPage).toBe(false);
    expect(new Set(references?.nodes.map((node) => node?.id)).size).toBe(600);
    expect(result.products[1].freshnessBatches?.references.nodes).toHaveLength(
      3,
    );
    // Only the long list needs more reads: batches 251-500, then 501-600
    expect(queriesNamed(graphql, "ExportMoreBatches")).toHaveLength(2);
  });

  it("fails when a batch is removed between reads, which would skip one", async () => {
    const long = product(1, 300);
    const { admin } = fakeShop([long], {
      beforeMoreBatches: () => long.batches.splice(9, 1),
    });

    const read = loadExportProducts(admin, filters(), NOW);

    await expect(read).rejects.toThrow(ExportChangedError);
    await expect(read).rejects.toThrow(
      "Batches of product Product 1 changed during the export",
    );
  });

  it("leaves a list partial instead of looping when Shopify gives no cursor", async () => {
    const { admin, graphql } = fakeShop([product(1, 300)]);
    const read = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, options) => {
      const response = await read(query, options);
      const { data } = (await response.json()) as {
        data: {
          products: {
            nodes: {
              freshnessBatches: {
                references: { pageInfo: { endCursor: string | null } };
              };
            }[];
          };
        };
      };
      const references = data.products.nodes[0].freshnessBatches.references;
      references.pageInfo.endCursor = null;
      return { json: async () => ({ data }) };
    });

    const result = await loadExportProducts(admin, filters(), NOW);

    expect(queriesNamed(graphql, "ExportMoreBatches")).toHaveLength(0);
    expect(
      result.kind === "ready" &&
        result.products[0].freshnessBatches?.references.pageInfo.hasNextPage,
    ).toBe(true);
  });

  it("fails when the product is deleted between reads", async () => {
    const shop = [product(1, 300)];
    const { admin } = fakeShop(shop, {
      beforeMoreBatches: () => shop.splice(0, 1),
    });

    await expect(loadExportProducts(admin, filters(), NOW)).rejects.toThrow(
      ExportChangedError,
    );
  });

  it("dates the file by the shop's own day", async () => {
    const utc = await loadExportProducts(fakeShop([]).admin, filters(), NOW);
    const auckland = await loadExportProducts(
      fakeShop([], { timezone: "Pacific/Auckland" }).admin,
      filters(),
      NOW,
    );

    expect(utc.kind === "ready" && utc.today).toBe("2026-10-29");
    expect(auckland.kind === "ready" && auckland.today).toBe("2026-10-30");
  });
});

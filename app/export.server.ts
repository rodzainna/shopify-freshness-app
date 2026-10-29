import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { type ProductView, resolveProductView } from "./dashboard.server";
import { query } from "./fulfillment-shopify.server";
import type { ExportProduct } from "../shared/csv-export";
import { earliestDateOf, toDashboardRows } from "../shared/dashboard";
import {
  type DashboardFilters,
  filterRows,
  hasRowFilters,
  isAppSort,
  sortByExpiry,
} from "../shared/dashboard-filters";
import { getShopToday } from "../shared/freshness";
import { type BatchNode, MAX_BATCHES } from "../shared/product-metafields";

// 250 products with 250 batches each: measured at 420 of 1,000 points
const PRODUCT_PAGE = 250;

/** The most products one file holds; narrower filters are needed past it. */
export const EXPORT_LIMIT = 1_000;

interface BatchPage {
  // null for a batch that no longer resolves
  nodes: (BatchNode | null)[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface BatchList {
  // Changes whenever the list does, so a read across pages can check it
  compareDigest: string;
  references: BatchPage;
}

interface ExportNode extends Omit<ExportProduct, "freshnessBatches"> {
  id: string;
  earliestExpiration: { value: string } | null;
  freshnessBatches: BatchList | null;
}

interface ExportPageData {
  // Only on the first read
  productsCount?: { count: number };
  shop: { ianaTimezone: string };
  products: {
    nodes: ExportNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface MoreBatchesData {
  product: { freshnessBatches: BatchList | null } | null;
}

/** Products or batches changed between page reads; trying again reads them fresh. */
export class ExportChangedError extends Error {
  name = "ExportChangedError";
}

export type ExportData =
  | { kind: "ready"; products: ExportProduct[]; today: string }
  | { kind: "tooMany" };

/** Every product the dashboard's filters match, in its order, with all its batches. */
export async function loadExportProducts(
  admin: AdminApiContext,
  filters: DashboardFilters,
  now = new Date(),
): Promise<ExportData> {
  const { view, presetToday } = await resolveProductView(admin, filters, now);
  const products = new Map<string, ExportNode>();
  let timezone = "";
  let after: string | null = null;
  for (;;) {
    const data = await fetchExportPage(admin, { ...view, after });
    // Counted with the first read, so a big shop is refused after one request
    if ((data.productsCount?.count ?? 0) > EXPORT_LIMIT) {
      return { kind: "tooMany" };
    }
    timezone = data.shop.ianaTimezone;
    for (const node of data.products.nodes) {
      // Its sort value changed between reads, which can also skip a product
      if (products.has(node.id)) {
        throw new ExportChangedError(
          `Product ${node.title} moved during the export`,
        );
      }
      products.set(node.id, node);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    if (products.size >= EXPORT_LIMIT) return { kind: "tooMany" };
    after = data.products.pageInfo.endCursor;
    // Reading on from the start would repeat products
    if (after === null) {
      throw new Error("Shopify gave no cursor for the next page");
    }
  }

  const complete: ExportNode[] = [];
  // One at a time: few products pass 250 batches, and each read is small
  for (const product of products.values()) {
    complete.push(await withEveryBatch(admin, product));
  }
  const today = presetToday ?? getShopToday(timezone, now);
  const matching = hasRowFilters(filters)
    ? withRowFilters(complete, filters, today)
    : complete;
  return {
    kind: "ready",
    products: isAppSort(filters.sort) ? byEarliestExpiry(matching) : matching,
    today,
  };
}

// Status, stock and tracked need the batches, so they're applied here, as on
// the dashboard; the 1,000 limit counts the products checked
function withRowFilters(
  products: ExportNode[],
  filters: DashboardFilters,
  today: string,
): ExportNode[] {
  const rows = toDashboardRows(
    products.map((product) => ({ ...product, featuredMedia: null })),
    today,
  );
  const kept = new Set(filterRows(rows, filters).map(({ id }) => id));
  return products.filter(({ id }) => kept.has(id));
}

// Shopify can't sort by a metafield, so the expiry sort happens here
function byEarliestExpiry(products: ExportNode[]): ExportNode[] {
  const dated = products.map((product) => ({
    product,
    earliestExpirationDate: earliestDateOf(product),
  }));
  return sortByExpiry(dated).map(({ product }) => product);
}

// Reads the batches past the first page, so the file can't leave one out
async function withEveryBatch(
  admin: AdminApiContext,
  product: ExportNode,
): Promise<ExportNode> {
  const list = product.freshnessBatches;
  if (!list?.references.pageInfo.hasNextPage) return product;
  const nodes = [...list.references.nodes];
  let references = list.references;
  while (references.pageInfo.hasNextPage) {
    // Reading on from the start would repeat batches
    if (references.pageInfo.endCursor === null) {
      throw new Error(`Shopify gave no cursor for ${product.title}'s batches`);
    }
    const next = await fetchMoreBatches(
      admin,
      product.id,
      references.pageInfo.endCursor,
    );
    // An edit between reads shifts the cursor, which skips or repeats a batch
    if (next?.compareDigest !== list.compareDigest) {
      throw new ExportChangedError(
        `Batches of product ${product.title} changed during the export`,
      );
    }
    references = next.references;
    nodes.push(...references.nodes);
  }
  return {
    ...product,
    freshnessBatches: {
      ...list,
      references: { nodes, pageInfo: references.pageInfo },
    },
  };
}

const BATCH_PAGE_FIELDS = `#graphql
  fragment ExportBatchPage on MetafieldReferenceConnection {
    nodes {
      ... on Metaobject {
        id
        quantity: field(key: "quantity") {
          value
        }
        expirationDate: field(key: "expiration_date") {
          value
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

function fetchExportPage(
  admin: AdminApiContext,
  variables: ProductView & { after: string | null },
): Promise<ExportPageData> {
  return query<ExportPageData>(
    admin,
    `
      #graphql
      query ExportProducts(
        $first: Int!
        $batchLimit: Int!
        $query: String
        $after: String
        $sortKey: ProductSortKeys!
        $reverse: Boolean!
        $withCount: Boolean!
        $countLimit: Int!
      ) {
        productsCount(query: $query, limit: $countLimit)
          @include(if: $withCount) {
          count
        }
        shop {
          ianaTimezone
        }
        products(
          first: $first
          after: $after
          sortKey: $sortKey
          reverse: $reverse
          query: $query
        ) {
          nodes {
            id
            legacyResourceId
            title
            vendor
            productType
            tracksInventory
            totalInventory
            earliestExpiration: metafield(key: "earliest_expiration_date") {
              value
            }
            freshnessBatches: metafield(key: "freshness_batches") {
              compareDigest
              references(first: $batchLimit) {
                ...ExportBatchPage
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      ${BATCH_PAGE_FIELDS}
    `,
    {
      first: PRODUCT_PAGE,
      batchLimit: MAX_BATCHES,
      withCount: variables.after === null,
      // Counting one past the limit is enough to know it's over
      countLimit: EXPORT_LIMIT + 1,
      ...variables,
    },
  );
}

async function fetchMoreBatches(
  admin: AdminApiContext,
  productId: string,
  after: string | null,
): Promise<BatchList | null> {
  const data = await query<MoreBatchesData>(
    admin,
    `
      #graphql
      query ExportMoreBatches($id: ID!, $batchLimit: Int!, $after: String) {
        product(id: $id) {
          freshnessBatches: metafield(key: "freshness_batches") {
            compareDigest
            references(first: $batchLimit, after: $after) {
              ...ExportBatchPage
            }
          }
        }
      }
      ${BATCH_PAGE_FIELDS}
    `,
    { id: productId, batchLimit: MAX_BATCHES, after },
  );
  // null when the product or its list was deleted since the first read
  return data.product?.freshnessBatches ?? null;
}

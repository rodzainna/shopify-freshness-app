import {
  type BatchFreshness,
  type FreshnessStatus,
  computeAggregateFreshness,
  computeBatchFreshness,
  isCalendarDate,
} from "./freshness";
import { type ProductInventory, compareStock } from "./inventory";
import { type BatchNode, isReadableBatch } from "./product-metafields";

// The dashboard query's product shape (see app/routes/app._index.tsx)
export interface DashboardProductNode extends ProductInventory {
  id: string;
  // The numeric id admin URLs take
  legacyResourceId: string;
  title: string;
  featuredMedia: {
    preview: { image: { url: string; altText: string | null } | null } | null;
  } | null;
  earliestExpiration: { value: string } | null;
  freshnessBatches: {
    references: {
      // null for a batch that no longer resolves
      nodes: (BatchNode | null)[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

export interface DashboardBatch {
  id: string;
  quantity: number;
  expirationDate: string;
  // null when the stored date can't be read as a calendar date
  freshness: BatchFreshness | null;
}

export const ADMIN_PRODUCTS = "shopify://admin/products";

// Batches listed per row; totals and status still use every loaded batch
export const SHOWN_BATCHES = 10;

// A batch in the list didn't resolve, so the row can't show a status
export const UNREADABLE = "Can't read batches";

export interface DashboardRow {
  id: string;
  title: string;
  adminUrl: string;
  // null when the product has no image, so the thumbnail shows a placeholder
  imageUrl: string | null;
  earliestExpirationDate: string | null;
  // Has a batch list with at least one batch, readable or not
  tracked: boolean;
  // Worst status among in-stock batches (computeAggregateFreshness)
  status: FreshnessStatus | "Not set" | typeof UNREADABLE;
  // The first SHOWN_BATCHES; hiddenBatches counts the rest that loaded
  batches: DashboardBatch[];
  hiddenBatches: number;
  // The query loads a limited number of batches per product
  hasMoreBatches: boolean;
  // null when Shopify doesn't track the product's inventory
  stock: number | null;
  // From compareStock; batchTotal is null when the batches can't be read
  batchTotal: number | null;
  uncountedBatches: number;
  overStock: number | null;
  unbatchedStock: number | null;
}

export function toDashboardRows(
  products: DashboardProductNode[],
  today: string,
): DashboardRow[] {
  return products.map((product): DashboardRow => {
    const references = product.freshnessBatches?.references;
    const nodes = references?.nodes ?? [];
    const row = {
      id: product.id,
      title: product.title,
      adminUrl: `${ADMIN_PRODUCTS}/${product.legacyResourceId}`,
      imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
      earliestExpirationDate: product.earliestExpiration?.value ?? null,
      stock: product.tracksInventory ? product.totalInventory : null,
      tracked: nodes.length > 0,
    };
    if (!nodes.every(isReadableBatch)) {
      return {
        ...row,
        status: UNREADABLE,
        batches: [],
        hiddenBatches: 0,
        hasMoreBatches: false,
        batchTotal: null,
        uncountedBatches: 0,
        overStock: null,
        unbatchedStock: null,
      };
    }

    const batches = nodes.map((node) => {
      const expirationDate = node.expirationDate?.value ?? "";
      return {
        id: node.id,
        quantity: Number(node.quantity?.value ?? 0),
        expirationDate,
        freshness: isCalendarDate(expirationDate)
          ? computeBatchFreshness(expirationDate, today)
          : null,
      };
    });

    const hasMoreBatches = references?.pageInfo.hasNextPage ?? false;
    return {
      ...row,
      status: computeAggregateFreshness(batches, today),
      batches: batches.slice(0, SHOWN_BATCHES),
      hiddenBatches: Math.max(0, batches.length - SHOWN_BATCHES),
      hasMoreBatches,
      ...compareStock(batches, product, { complete: !hasMoreBatches }),
    };
  });
}

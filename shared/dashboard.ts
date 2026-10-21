import {
  type BatchFreshness,
  type FreshnessStatus,
  computeAggregateFreshness,
  computeBatchFreshness,
  isCalendarDate,
} from "./freshness";
import {
  type ProductInventory,
  exceedsStock,
  getUnbatchedStock,
  totalBatchQuantity,
} from "./inventory";
import { type BatchNode, isReadableBatch } from "./product-metafields";
import { validateBatch } from "./validation";

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
  // Worst status among in-stock batches (computeAggregateFreshness)
  status: FreshnessStatus | "Not set" | typeof UNREADABLE;
  // The first SHOWN_BATCHES; hiddenBatches counts the rest that loaded
  batches: DashboardBatch[];
  hiddenBatches: number;
  // The query loads a limited number of batches per product
  hasMoreBatches: boolean;
  // null when Shopify doesn't track the product's inventory
  stock: number | null;
  // Units across loaded batches; null when the batches can't be read
  batchTotal: number | null;
  // Batches with an invalid quantity, left out of batchTotal
  uncountedBatches: number;
  // Units over the stock shown, when exceedsStock; a lower bound if some didn't load
  overStock: number | null;
  // Stock not in any batch; only for products with batches, and all of them loaded
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

    // Loaded batches are a lower bound, so a total already over stock is certain
    const batchTotal = totalBatchQuantity(batches);
    const hasMoreBatches = references?.pageInfo.hasNextPage ?? false;
    return {
      ...row,
      status: computeAggregateFreshness(batches, today),
      batches: batches.slice(0, SHOWN_BATCHES),
      hiddenBatches: Math.max(0, batches.length - SHOWN_BATCHES),
      hasMoreBatches,
      batchTotal,
      uncountedBatches: batches.filter((batch) => validateBatch(batch).quantity)
        .length,
      overStock: exceedsStock(batchTotal, product)
        ? batchTotal - product.totalInventory
        : null,
      unbatchedStock:
        batches.length > 0 && !hasMoreBatches
          ? getUnbatchedStock(batchTotal, product)
          : null,
    };
  });
}

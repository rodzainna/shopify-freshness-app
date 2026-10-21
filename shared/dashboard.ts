import {
  type BatchFreshness,
  type FreshnessStatus,
  computeAggregateFreshness,
  computeBatchFreshness,
  isCalendarDate,
} from "./freshness";
import { type BatchNode, isReadableBatch } from "./product-metafields";

// The dashboard query's product shape (see app/routes/app._index.tsx)
export interface DashboardProductNode {
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
  batches: DashboardBatch[];
  // The query loads a limited number of batches per product
  hasMoreBatches: boolean;
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
    };
    if (!nodes.every(isReadableBatch)) {
      return { ...row, status: UNREADABLE, batches: [], hasMoreBatches: false };
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

    return {
      ...row,
      status: computeAggregateFreshness(batches, today),
      batches,
      hasMoreBatches: references?.pageInfo.hasNextPage ?? false,
    };
  });
}

import {
  type BatchFreshness,
  type FreshnessStatus,
  computeAggregateFreshness,
  computeBatchFreshness,
  isCalendarDate,
} from "./freshness";

interface BatchNode {
  id?: string;
  quantity?: { value: string } | null;
  expirationDate?: { value: string } | null;
}

// The dashboard query's product shape (see app/routes/app._index.tsx)
export interface DashboardProductNode {
  id: string;
  title: string;
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

// A batch in the list didn't resolve, so the row can't show a status
export const UNREADABLE = "Can't read batches";

export interface DashboardRow {
  id: string;
  title: string;
  earliestExpirationDate: string | null;
  // Worst status among in-stock batches (computeAggregateFreshness)
  status: FreshnessStatus | "Not set" | typeof UNREADABLE;
  batches: DashboardBatch[];
  // The query loads a limited number of batches per product
  hasMoreBatches: boolean;
}

function isReadable(
  node: BatchNode | null,
): node is BatchNode & { id: string } {
  return Boolean(node?.id);
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
      earliestExpirationDate: product.earliestExpiration?.value ?? null,
    };
    if (!nodes.every(isReadable)) {
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

import {
  type BatchFreshness,
  computeBatchFreshness,
  isCalendarDate,
} from "./freshness";

// The dashboard query's product shape (see app/routes/app._index.tsx)
export interface DashboardProductNode {
  id: string;
  title: string;
  earliestExpiration: { value: string } | null;
  freshnessBatches: {
    references: {
      nodes: {
        id?: string;
        quantity?: { value: string } | null;
        expirationDate?: { value: string } | null;
      }[];
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

export interface DashboardRow {
  id: string;
  title: string;
  earliestExpirationDate: string | null;
  batches: DashboardBatch[];
  // The query loads a limited number of batches per product
  hasMoreBatches: boolean;
}

export function toDashboardRows(
  products: DashboardProductNode[],
  today: string,
): DashboardRow[] {
  return products.map((product) => {
    const references = product.freshnessBatches?.references;

    return {
      id: product.id,
      title: product.title,
      earliestExpirationDate: product.earliestExpiration?.value ?? null,
      batches: (references?.nodes ?? []).map((node) => {
        const expirationDate = node.expirationDate?.value ?? "";
        return {
          id: node.id ?? "",
          quantity: Number(node.quantity?.value ?? 0),
          expirationDate,
          freshness: isCalendarDate(expirationDate)
            ? computeBatchFreshness(expirationDate, today)
            : null,
        };
      }),
      hasMoreBatches: references?.pageInfo.hasNextPage ?? false,
    };
  });
}

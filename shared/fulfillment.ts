import { toProductGid } from "./product-gid";

export type ProductQuantity = { productId: string; quantity: number };

export type SkippedLineItem = {
  lineItemId: unknown;
  reason:
    | "not a line item"
    | "no product"
    | "invalid product id"
    | "invalid quantity";
};

/**
 * Totals a fulfillments/create payload's line items per product, since
 * batches belong to the product, not the variant.
 *
 * `quantity` is the units in this fulfillment (verified against a partial
 * fulfillment); `fulfillable_quantity` is what's left and isn't used.
 */
export function groupLineItemsByProduct(lineItems: unknown[]): {
  products: ProductQuantity[];
  skipped: SkippedLineItem[];
} {
  const totals = new Map<string, number>();
  const skipped: SkippedLineItem[] = [];

  for (const item of lineItems) {
    if (typeof item !== "object" || item === null) {
      skipped.push({ lineItemId: undefined, reason: "not a line item" });
      continue;
    }
    const {
      id,
      product_id: productId,
      quantity,
    } = item as Record<string, unknown>;

    if (productId === null || productId === undefined) {
      skipped.push({ lineItemId: id, reason: "no product" });
    } else if (!Number.isSafeInteger(productId) || (productId as number) <= 0) {
      skipped.push({ lineItemId: id, reason: "invalid product id" });
    } else if (!Number.isInteger(quantity) || (quantity as number) <= 0) {
      skipped.push({ lineItemId: id, reason: "invalid quantity" });
    } else {
      const gid = toProductGid(productId as number);
      totals.set(gid, (totals.get(gid) ?? 0) + (quantity as number));
    }
  }

  return {
    products: [...totals].map(([productId, quantity]) => ({
      productId,
      quantity,
    })),
    skipped,
  };
}

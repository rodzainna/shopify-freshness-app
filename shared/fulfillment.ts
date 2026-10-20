import { isPositiveWholeNumber } from "./freshness";
import { toProductGid } from "./product-gid";
import { MAX_QUANTITY } from "./validation";

export type ProductQuantity = { productId: string; quantity: number };

export type SkippedLineItem = {
  index: number;
  lineItemId: unknown;
  reason:
    | "not a line item list"
    | "not a line item"
    | "no product"
    | "invalid product id"
    | "zero quantity"
    | "invalid quantity";
};

// Totals per product, since batches belong to the product, not the variant.
// `quantity` is the units in this fulfillment; `fulfillable_quantity` isn't used.
export function groupLineItemsByProduct(lineItems: unknown): {
  products: ProductQuantity[];
  skipped: SkippedLineItem[];
} {
  if (!Array.isArray(lineItems)) {
    return {
      products: [],
      skipped: [
        { index: -1, lineItemId: undefined, reason: "not a line item list" },
      ],
    };
  }

  const totals = new Map<string, number>();
  const skipped: SkippedLineItem[] = [];

  lineItems.forEach((item: unknown, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skipped.push({ index, lineItemId: undefined, reason: "not a line item" });
      return;
    }
    const {
      id,
      product_id: productId,
      quantity,
    } = item as Record<string, unknown>;
    const skip = (reason: SkippedLineItem["reason"]) =>
      skipped.push({ index, lineItemId: id, reason });

    if (productId === null || productId === undefined) {
      skip("no product");
    } else if (
      typeof productId !== "number" ||
      !Number.isSafeInteger(productId) ||
      productId <= 0
    ) {
      skip("invalid product id");
    } else if (quantity === 0) {
      skip("zero quantity");
    } else if (!isPositiveWholeNumber(quantity) || quantity > MAX_QUANTITY) {
      skip("invalid quantity");
    } else {
      const gid = toProductGid(productId);
      // Lines are capped at MAX_QUANTITY, so the sum stays an exact integer.
      totals.set(gid, (totals.get(gid) ?? 0) + quantity);
    }
  });

  return {
    products: [...totals].map(([productId, quantity]) => ({
      productId,
      quantity,
    })),
    skipped,
  };
}

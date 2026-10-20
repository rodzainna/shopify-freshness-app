import { describe, it, expect } from "vitest";
import { groupLineItemsByProduct } from "./fulfillment";

// Shaped like a real fulfillments/create line item (extra fields omitted).
const line = (id: number, productId: unknown, quantity: unknown) => ({
  id,
  product_id: productId,
  quantity,
});

describe("groupLineItemsByProduct", () => {
  it("converts product ids to GIDs", () => {
    expect(groupLineItemsByProduct([line(1, 9658528694493, 1)])).toEqual({
      products: [
        { productId: "gid://shopify/Product/9658528694493", quantity: 1 },
      ],
      skipped: [],
    });
  });

  it("sums variants of the same product, in first-seen order", () => {
    const { products } = groupLineItemsByProduct([
      line(1, 200, 2),
      line(2, 100, 1),
      line(3, 200, 3),
    ]);
    expect(products).toEqual([
      { productId: "gid://shopify/Product/200", quantity: 5 },
      { productId: "gid://shopify/Product/100", quantity: 1 },
    ]);
  });

  it("skips lines without a product, such as custom items", () => {
    expect(groupLineItemsByProduct([line(7, null, 1)])).toEqual({
      products: [],
      skipped: [{ lineItemId: 7, reason: "no product" }],
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-numeric", "2"],
  ])("skips a %s quantity", (_, quantity) => {
    expect(groupLineItemsByProduct([line(8, 100, quantity)])).toEqual({
      products: [],
      skipped: [{ lineItemId: 8, reason: "invalid quantity" }],
    });
  });

  it("skips product ids too large to read exactly", () => {
    // Above Number.MAX_SAFE_INTEGER, JSON.parse may already have changed the digits.
    const unsafeId = Number.MAX_SAFE_INTEGER + 2;
    expect(groupLineItemsByProduct([line(9, unsafeId, 1)])).toEqual({
      products: [],
      skipped: [{ lineItemId: 9, reason: "invalid product id" }],
    });
  });

  it("skips entries that aren't objects", () => {
    expect(groupLineItemsByProduct([null, "x"]).skipped).toEqual([
      { lineItemId: undefined, reason: "not a line item" },
      { lineItemId: undefined, reason: "not a line item" },
    ]);
  });

  it("keeps valid lines when others are skipped", () => {
    const { products, skipped } = groupLineItemsByProduct([
      line(1, 100, 1),
      line(2, null, 1),
    ]);
    expect(products).toEqual([
      { productId: "gid://shopify/Product/100", quantity: 1 },
    ]);
    expect(skipped).toHaveLength(1);
  });
});

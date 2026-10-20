import { describe, it, expect } from "vitest";
import { groupLineItemsByProduct } from "./fulfillment";
import { MAX_QUANTITY } from "./validation";

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
      skipped: [{ index: 0, lineItemId: 7, reason: "no product" }],
    });
  });

  it("reports a zero quantity separately from invalid ones", () => {
    expect(groupLineItemsByProduct([line(8, 100, 0)]).skipped).toEqual([
      { index: 0, lineItemId: 8, reason: "zero quantity" },
    ]);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-numeric", "2"],
    ["above MAX_QUANTITY", MAX_QUANTITY + 1],
  ])("skips a %s quantity", (_, quantity) => {
    expect(groupLineItemsByProduct([line(8, 100, quantity)])).toEqual({
      products: [],
      skipped: [{ index: 0, lineItemId: 8, reason: "invalid quantity" }],
    });
  });

  it.each([
    // Above Number.MAX_SAFE_INTEGER, JSON.parse may already have changed the digits.
    ["too large to read exactly", Number.MAX_SAFE_INTEGER + 2],
    ["zero", 0],
    ["a string", "100"],
  ])("skips a product id that is %s", (_, productId) => {
    expect(groupLineItemsByProduct([line(9, productId, 1)]).skipped).toEqual([
      { index: 0, lineItemId: 9, reason: "invalid product id" },
    ]);
  });

  it("skips entries that aren't objects, recording their position", () => {
    expect(groupLineItemsByProduct([null, "x", [1, 2]]).skipped).toEqual([
      { index: 0, lineItemId: undefined, reason: "not a line item" },
      { index: 1, lineItemId: undefined, reason: "not a line item" },
      { index: 2, lineItemId: undefined, reason: "not a line item" },
    ]);
  });

  it.each([undefined, null, {}])(
    "reports a missing line item list (%s) instead of throwing",
    (lineItems) => {
      expect(groupLineItemsByProduct(lineItems)).toEqual({
        products: [],
        skipped: [
          { index: -1, lineItemId: undefined, reason: "not a line item list" },
        ],
      });
    },
  );

  it("keeps valid lines when others are skipped", () => {
    const { products, skipped } = groupLineItemsByProduct([
      line(1, 100, 1),
      line(2, null, 1),
    ]);
    expect(products).toEqual([
      { productId: "gid://shopify/Product/100", quantity: 1 },
    ]);
    expect(skipped).toEqual([
      { index: 1, lineItemId: 2, reason: "no product" },
    ]);
  });
});

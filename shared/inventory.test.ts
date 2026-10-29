import { describe, it, expect } from "vitest";

import {
  compareStock,
  formatInventoryMismatch,
  formatUnbatchedStock,
  getInventoryMismatch,
  matchesStock,
  type ProductInventory,
  productStock,
} from "./inventory";
import type { Batch } from "./freshness";
import { MAX_QUANTITY } from "./validation";

const tracked = (totalInventory: number) => ({
  tracksInventory: true,
  totalInventory,
});

describe("getInventoryMismatch", () => {
  it("is null when the batches fit within stock", () => {
    expect(
      getInventoryMismatch(
        [
          { quantity: 20, expirationDate: "2026-11-01" },
          { quantity: 30, expirationDate: "2026-11-20" },
        ],
        tracked(50),
      ),
    ).toBeNull();
  });

  it("reports both totals when the batches exceed stock", () => {
    expect(
      getInventoryMismatch(
        [
          { quantity: 40, expirationDate: "2026-11-01" },
          { quantity: 50, expirationDate: "2026-11-20" },
        ],
        tracked(50),
      ),
    ).toStrictEqual({ batchTotal: 90, inStock: 50 });
  });

  it("is null when inventory isn't tracked", () => {
    expect(
      getInventoryMismatch([{ quantity: 90, expirationDate: "2026-11-01" }], {
        tracksInventory: false,
        totalInventory: 0,
      }),
    ).toBeNull();
  });

  it("ignores invalid quantities", () => {
    expect(
      getInventoryMismatch(
        [
          { quantity: 10, expirationDate: "2026-11-01" },
          { quantity: Number.NaN, expirationDate: "2026-11-01" },
          { quantity: -5, expirationDate: "2026-11-01" },
          { quantity: 2.5, expirationDate: "2026-11-01" },
          { quantity: MAX_QUANTITY + 1, expirationDate: "2026-11-01" },
        ],
        tracked(5),
      ),
    ).toStrictEqual({ batchTotal: 10, inStock: 5 });
  });

  it("treats oversold (negative) stock as none in stock", () => {
    expect(
      getInventoryMismatch(
        [{ quantity: 1, expirationDate: "2026-11-01" }],
        tracked(-3),
      ),
    ).toStrictEqual({ batchTotal: 1, inStock: 0 });
  });

  it("is null when there are no batches", () => {
    expect(getInventoryMismatch([], tracked(0))).toBeNull();
  });
});

describe("compareStock", () => {
  const batches = (...quantities: number[]) =>
    quantities.map((quantity) => ({ quantity, expirationDate: "2026-11-02" }));

  it("counts units over stock", () => {
    expect(compareStock(batches(10, 20), tracked(25))).toStrictEqual({
      batchTotal: 30,
      uncountedBatches: 0,
      overStock: 5,
      unbatchedStock: null,
    });
  });

  it("counts stock that isn't in a batch", () => {
    expect(compareStock(batches(8), tracked(10))).toMatchObject({
      overStock: null,
      unbatchedStock: 2,
    });
  });

  it("finds nothing to flag when they match", () => {
    expect(compareStock(batches(10), tracked(10))).toMatchObject({
      overStock: null,
      unbatchedStock: null,
    });
  });

  // Oversold stock counts as none, so the excess never exceeds the batches
  it.each([
    [batches(3), 3],
    [[], null],
  ])("treats oversold stock as none (%j)", (list, overStock) => {
    expect(compareStock(list, tracked(-5)).overStock).toBe(overStock);
  });

  it("counts invalid quantities separately and doesn't call stock unbatched", () => {
    expect(compareStock(batches(10, 1.5, 0), tracked(12))).toStrictEqual({
      batchTotal: 10,
      uncountedBatches: 2,
      overStock: null,
      unbatchedStock: null,
    });
  });

  it("still flags over stock when not every batch loaded", () => {
    expect(
      compareStock(batches(30), tracked(25), { complete: false }),
    ).toMatchObject({
      overStock: 5,
      unbatchedStock: null,
    });
  });

  it("doesn't call stock unbatched when not every batch loaded", () => {
    expect(
      compareStock(batches(8), tracked(10), { complete: false }).unbatchedStock,
    ).toBeNull();
  });

  it("doesn't call stock unbatched when the product has no batches", () => {
    expect(compareStock([], tracked(50)).unbatchedStock).toBeNull();
  });

  it("calls all stock unbatched for a form adding the first batches", () => {
    expect(
      compareStock([], tracked(50), { emptyIsUnbatched: true }).unbatchedStock,
    ).toBe(50);
  });

  it("flags nothing when inventory isn't tracked", () => {
    expect(
      compareStock(batches(30), { tracksInventory: false, totalInventory: 5 }),
    ).toStrictEqual({
      batchTotal: 30,
      uncountedBatches: 0,
      overStock: null,
      unbatchedStock: null,
    });
  });
});

describe("matchesStock", () => {
  const batches = (...quantities: number[]) =>
    quantities.map((quantity) => ({ quantity, expirationDate: "2026-11-02" }));

  const matches = (list: Batch[], inventory: ProductInventory) =>
    matchesStock(compareStock(list, inventory), inventory, list.length);

  it("matches when the batches add up to the stock", () => {
    expect(matches(batches(10, 15), tracked(25))).toBe(true);
  });

  it.each([
    ["over stock", batches(10, 20), tracked(25)],
    ["under stock", batches(10), tracked(25)],
    ["with an uncounted batch", [...batches(25), ...batches(0)], tracked(25)],
    ["with no batches", batches(), tracked(0)],
    [
      "when stock isn't tracked",
      batches(25),
      { tracksInventory: false, totalInventory: 25 },
    ],
  ])("doesn't match %s", (_case, list, inventory) => {
    expect(matches(list, inventory)).toBe(false);
  });
});

describe("formatInventoryMismatch", () => {
  it.each([
    [
      { batchTotal: 90, inStock: 50 },
      "Batches total 90, but only 50 are in stock.",
    ],
    [{ batchTotal: 3, inStock: 1 }, "Batches total 3, but only 1 is in stock."],
    [{ batchTotal: 5, inStock: 0 }, "Batches total 5, but none are in stock."],
  ])("describes %o", (mismatch, message) => {
    expect(formatInventoryMismatch(mismatch)).toBe(message);
  });
});

describe("formatUnbatchedStock", () => {
  it.each([
    [1, "1 unit in stock isn't in a batch yet."],
    [2, "2 units in stock aren't in a batch yet."],
  ])("describes %i", (units, message) => {
    expect(formatUnbatchedStock(units)).toBe(message);
  });
});

describe("productStock", () => {
  it("is Shopify's stock when tracked, null when not", () => {
    expect(productStock({ tracksInventory: true, totalInventory: 7 })).toBe(7);
    expect(productStock({ tracksInventory: true, totalInventory: 0 })).toBe(0);
    expect(
      productStock({ tracksInventory: false, totalInventory: 7 }),
    ).toBeNull();
  });
});

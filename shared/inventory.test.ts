import { describe, it, expect } from "vitest";

import {
  exceedsStock,
  formatInventoryMismatch,
  formatUnbatchedStock,
  getInventoryMismatch,
  getUnbatchedStock,
} from "./inventory";
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

describe("exceedsStock", () => {
  const tracked = (totalInventory: number) => ({
    tracksInventory: true,
    totalInventory,
  });

  it.each([
    [31, tracked(30), true],
    [30, tracked(30), false],
    [1, tracked(-5), true],
    // Oversold stock counts as none, so no batches isn't over it
    [0, tracked(-5), false],
    [99, { tracksInventory: false, totalInventory: 0 }, false],
  ])("%i units against %o is %s", (batchTotal, inventory, expected) => {
    expect(exceedsStock(batchTotal, inventory)).toBe(expected);
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

describe("getUnbatchedStock", () => {
  const tracked = (totalInventory: number) => ({
    tracksInventory: true,
    totalInventory,
  });

  it.each([
    [8, tracked(10), 2],
    [10, tracked(10), null],
    [12, tracked(10), null],
    [0, tracked(-5), null],
    [8, { tracksInventory: false, totalInventory: 10 }, null],
  ])("%i in batches against %o is %s", (batchTotal, inventory, expected) => {
    expect(getUnbatchedStock(batchTotal, inventory)).toBe(expected);
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

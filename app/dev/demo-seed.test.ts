import { describe, it, expect } from "vitest";

import {
  MAX_NEW_BATCHES_PER_SAVE,
  validateNewBatches,
} from "../../shared/batch-edit";
import { compareStock } from "../../shared/inventory";
import { type DemoProduct, demoStockCsv, planDemoBatches } from "./demo-seed";
import { DEMO_PRODUCTS } from "./demo-seed.data";

const counter = () => {
  let n = 0;
  return () => `handle-${++n}`;
};

const milk: DemoProduct = {
  handle: "whole-milk-1l",
  title: "Whole milk 1L",
  stock: 25,
  batches: [
    [10, -8],
    [20, 6],
  ],
};

describe("planDemoBatches", () => {
  it("dates each batch from the given day", () => {
    expect(planDemoBatches(milk, "2026-10-27", counter())).toEqual([
      { handle: "handle-1", quantity: 10, expirationDate: "2026-10-19" },
      { handle: "handle-2", quantity: 20, expirationDate: "2026-11-02" },
    ]);
  });

  it("crosses month and year ends", () => {
    const [batch] = planDemoBatches(
      { ...milk, batches: [[5, 3]] },
      "2026-12-30",
      counter(),
    );
    expect(batch.expirationDate).toBe("2027-01-02");
  });

  it("gives an empty plan to a product without batches", () => {
    expect(
      planDemoBatches({ ...milk, batches: [] }, "2026-10-27", counter()),
    ).toEqual([]);
  });
});

describe("DEMO_PRODUCTS", () => {
  it("lists each product once", () => {
    const handles = DEMO_PRODUCTS.map(({ handle }) => handle);
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("passes the editor's rules and fits one save per product", () => {
    for (const product of DEMO_PRODUCTS) {
      const planned = planDemoBatches(product, "2026-10-27", () =>
        crypto.randomUUID(),
      );
      expect(validateNewBatches(planned), product.handle).toEqual({});
      expect(planned.length).toBeLessThanOrEqual(MAX_NEW_BATCHES_PER_SAVE);
    }
  });

  it("keeps the planned Stock check mismatches", () => {
    // The dashboard's rule, so the list matches the badges it shows
    const flagged = DEMO_PRODUCTS.filter((product) => {
      const { stock } = product;
      const { overStock, unbatchedStock } = compareStock(
        planDemoBatches(product, "2026-10-27", counter()),
        { tracksInventory: stock !== null, totalInventory: stock ?? 0 },
      );
      return overStock !== null || unbatchedStock !== null;
    }).map(({ handle }) => handle);
    expect(flagged).toEqual([
      "whole-milk-1l",
      "aged-cheddar",
      "brie-200g",
      "salmon-fillet-300g",
      "orange-juice-1l",
      "kombucha-330ml",
    ]);
  });
});

describe("demoStockCsv", () => {
  it("writes Shopify's inventory import columns for tracked products", () => {
    const eggs = { ...milk, handle: "free-range-eggs-12", stock: null };
    expect(demoStockCsv([milk, eggs], "Shop location")).toBe(
      "Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value," +
        "Option3 Name,Option3 Value,Location,On hand (new)\n" +
        "whole-milk-1l,Whole milk 1L,Title,Default Title,,,,,Shop location,25\n",
    );
  });

  it("quotes a location name with a comma", () => {
    expect(demoStockCsv([milk], 'Store, "North"')).toContain(
      ',"Store, ""North""",25\n',
    );
  });

  it("quotes a value with a carriage return", () => {
    expect(demoStockCsv([milk], "Shop\rlocation")).toContain(
      ',"Shop\rlocation",25\n',
    );
  });
});

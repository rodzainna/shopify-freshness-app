import { describe, it, expect } from "vitest";

import {
  type ExportProduct,
  type ExportRow,
  EXPORT_COLUMNS,
  toCsv,
  toExportRows,
} from "./csv-export";
import type { BatchNode } from "./product-metafields";

const TODAY = "2026-10-19";
const SHOP = "test-shop.myshopify.com";

function product(
  nodes: (BatchNode | null)[] | null,
  overrides: Partial<ExportProduct> = {},
): ExportProduct {
  return {
    legacyResourceId: "1",
    title: "Sourdough loaf",
    vendor: "Hearth Bakery",
    productType: "Bread",
    tracksInventory: true,
    totalInventory: 13,
    freshnessBatches: nodes && {
      references: { nodes, pageInfo: { hasNextPage: false } },
    },
    ...overrides,
  };
}

function batch(id: string, quantity: string, expirationDate: string) {
  return {
    id,
    quantity: { value: quantity },
    expirationDate: { value: expirationDate },
  };
}

describe("toExportRows", () => {
  it("writes one row per batch, repeating the product and marking Multiple", () => {
    const rows = toExportRows(
      [
        product([
          batch("gid://shopify/Metaobject/1", "3", "2026-10-21"),
          batch("gid://shopify/Metaobject/2", "10", "2026-11-20"),
        ]),
      ],
      TODAY,
      SHOP,
    );

    const productCells = {
      Product: "Sourdough loaf",
      Vendor: "Hearth Bakery",
      Type: "Bread",
      Batches: "Multiple",
      "Product status": "Use Soon",
      "Product stock": 13,
      "Admin link": "https://test-shop.myshopify.com/admin/products/1",
    };
    expect(rows).toStrictEqual([
      {
        ...productCells,
        Quantity: "3",
        "Expiry date": "2026-10-21",
        "Days left": 2,
        "Batch status": "Use Soon",
      },
      {
        ...productCells,
        Quantity: "10",
        "Expiry date": "2026-11-20",
        "Days left": 32,
        "Batch status": "Fresh",
      },
    ]);
  });

  it("marks a product with one batch as Single", () => {
    const [row] = toExportRows(
      [product([batch("gid://shopify/Metaobject/1", "5", "2026-10-10")])],
      TODAY,
      SHOP,
    );

    expect(row).toMatchObject({
      Batches: "Single",
      "Days left": -9,
      "Batch status": "Expired",
      "Product status": "Expired",
    });
  });

  it("gives a product without batches one row with empty batch cells", () => {
    for (const nodes of [null, []]) {
      expect(toExportRows([product(nodes)], TODAY, SHOP)).toStrictEqual([
        expect.objectContaining({
          Product: "Sourdough loaf",
          Batches: "None",
          Quantity: null,
          "Expiry date": null,
          "Days left": null,
          "Batch status": null,
          "Product status": "Not set",
        }),
      ]);
    }
  });

  it("gives a product with unreadable batches one row saying so", () => {
    const rows = toExportRows(
      [product([batch("gid://shopify/Metaobject/1", "5", "2026-11-01"), null])],
      TODAY,
      SHOP,
    );

    expect(rows).toStrictEqual([
      expect.objectContaining({
        Batches: "Multiple",
        Quantity: null,
        "Expiry date": null,
        "Product status": "Can't read batches",
      }),
    ]);
  });

  it("refuses a partial batch list rather than writing an incomplete file", () => {
    const partial = product(null, {
      freshnessBatches: {
        references: {
          nodes: [batch("gid://shopify/Metaobject/1", "5", "2026-11-01")],
          pageInfo: { hasNextPage: true },
        },
      },
    });

    expect(() => toExportRows([partial], TODAY, SHOP)).toThrow(
      "Export needs every batch of product Sourdough loaf",
    );
  });

  it("gives each row exactly the export's columns", () => {
    const rows = toExportRows(
      [
        product(null),
        product([batch("gid://shopify/Metaobject/1", "5", "2026-11-01")]),
      ],
      TODAY,
      SHOP,
    );

    for (const row of rows) {
      expect(Object.keys(row).sort()).toStrictEqual([...EXPORT_COLUMNS].sort());
    }
  });

  it("marks a batch with no stock Sold out, as the dashboard does", () => {
    const [row] = toExportRows(
      [
        product([
          batch("gid://shopify/Metaobject/1", "0", "2026-10-10"),
          batch("gid://shopify/Metaobject/2", "4", "2026-11-20"),
        ]),
      ],
      TODAY,
      SHOP,
    );

    expect(row).toMatchObject({
      Quantity: "0",
      "Days left": -9,
      "Batch status": "Sold out",
      "Product status": "Fresh",
    });
  });

  it("writes an unreadable date as stored, with no days left or status", () => {
    const [row] = toExportRows(
      [product([batch("gid://shopify/Metaobject/1", "4", "2026-13-01")])],
      TODAY,
      SHOP,
    );

    expect(row).toMatchObject({
      Quantity: "4",
      "Expiry date": "2026-13-01",
      "Days left": null,
      "Batch status": null,
    });
  });

  it("writes the quantity as stored, even when the dashboard can't use it", () => {
    const quantity = (value: string) =>
      toExportRows(
        [product([batch("gid://shopify/Metaobject/1", value, "2026-11-01")])],
        TODAY,
        SHOP,
      )[0].Quantity;

    expect(quantity("lots")).toBe("lots");
    expect(quantity("-2")).toBe("-2");
    expect(quantity("2.5")).toBe("2.5");
    expect(quantity("1e3")).toBe("1e3");
    expect(quantity("007")).toBe("007");
    expect(quantity("99999999999999999999")).toBe("99999999999999999999");
    expect(quantity("0")).toBe("0");
  });

  it("leaves a missing quantity or date blank instead of 0", () => {
    const [row] = toExportRows(
      [product([{ id: "gid://shopify/Metaobject/1" }])],
      TODAY,
      SHOP,
    );

    expect(row).toMatchObject({
      Quantity: null,
      "Expiry date": null,
      "Batch status": "Sold out",
    });
  });

  it("leaves stock blank when Shopify doesn't track the product's inventory", () => {
    const [row] = toExportRows(
      [product(null, { tracksInventory: false, totalInventory: 0 })],
      TODAY,
      SHOP,
    );

    expect(row["Product stock"]).toBeNull();
  });
});

describe("toCsv", () => {
  const row = (overrides: Partial<ExportRow>): ExportRow => ({
    Product: "Sourdough loaf",
    Vendor: "Hearth Bakery",
    Type: "Bread",
    Batches: "Single",
    Quantity: "3",
    "Expiry date": "2026-10-21",
    "Days left": 2,
    "Batch status": "Use Soon",
    "Product status": "Use Soon",
    "Product stock": null,
    "Admin link": "https://test-shop.myshopify.com/admin/products/1",
    ...overrides,
  });

  it("starts with a BOM and the header, with a \\r\\n after every line", () => {
    const csv = toCsv([row({})]);

    expect(csv).toBe(
      `\uFEFF${EXPORT_COLUMNS.join(",")}\r\n` +
        "Sourdough loaf,Hearth Bakery,Bread,Single,3,2026-10-21,2,Use Soon,Use Soon,," +
        "https://test-shop.myshopify.com/admin/products/1\r\n",
    );
  });

  it("writes just the header when there are no rows", () => {
    expect(toCsv([])).toBe(`\uFEFF${EXPORT_COLUMNS.join(",")}\r\n`);
  });

  it("quotes cells with commas, quotes or line breaks, doubling inner quotes", () => {
    const line = (product: string) =>
      toCsv([row({ Product: product })]).split("\r\n")[1];

    expect(line("Eggs, free-range")).toMatch(/^"Eggs, free-range",/);
    expect(line('The "best" milk')).toMatch(/^"The ""best"" milk",/);
    expect(line("Two\nlines")).toMatch(/^"Two\nlines",/);
  });

  it("stops text that starts like a formula from running in a spreadsheet", () => {
    const first = (product: string) =>
      toCsv([row({ Product: product })])
        .split("\r\n")[1]
        .split(",")[0];

    expect(first("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(first("+1 free")).toBe("'+1 free");
    expect(first("-5% off")).toBe("'-5% off");
    expect(first("@home")).toBe("'@home");
    expect(first("\tTabbed")).toBe("'\tTabbed");
    expect(first(" =HYPERLINK(1)")).toBe("' =HYPERLINK(1)");
    expect(first("Fresh = good")).toBe("Fresh = good");
  });

  it("guards a formula after a leading line break", () => {
    expect(toCsv([row({ Product: "\n=1+1" })]).split("\r\n")[1]).toMatch(
      /^"'\n=1\+1",/,
    );
  });

  it("guards a stored quantity that starts with a minus, since it's text", () => {
    const cells = toCsv([row({ Quantity: "-2" })])
      .split("\r\n")[1]
      .split(",");

    expect(cells[EXPORT_COLUMNS.indexOf("Quantity")]).toBe("'-2");
  });

  it("writes negative numbers as numbers, not escaped text", () => {
    const cells = toCsv([row({ "Days left": -9 })])
      .split("\r\n")[1]
      .split(",");

    expect(cells[EXPORT_COLUMNS.indexOf("Days left")]).toBe("-9");
  });
});

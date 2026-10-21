import { describe, it, expect } from "vitest";

import type { DashboardRow } from "./dashboard";
import {
  type DashboardFilters,
  filterRows,
  hasActiveFilters,
  hasRowFilters,
  parseDashboardFilters,
  toProductQuery,
} from "./dashboard-filters";

const none: DashboardFilters = {
  search: "",
  types: [],
  vendors: [],
  statuses: [],
  stock: [],
  tracked: false,
};

describe("parseDashboardFilters", () => {
  it("reads the search, types and vendors, keeping the app's other params out", () => {
    const params = new URLSearchParams(
      "shop=x.myshopify.com&q=+milk+&type=Dairy&type=Cheese&vendor=Acme",
    );

    expect(parseDashboardFilters(params)).toMatchObject({
      search: "milk",
      types: ["Dairy", "Cheese"],
      vendors: ["Acme"],
    });
  });

  it("drops blank and repeated values", () => {
    const params = new URLSearchParams("type=Dairy&type=&type=Dairy&type=+");

    expect(parseDashboardFilters(params).types).toStrictEqual(["Dairy"]);
  });

  it("has no filters for an empty URL", () => {
    const filters = parseDashboardFilters(new URLSearchParams());

    expect(filters).toStrictEqual(none);
    expect(hasActiveFilters(filters)).toBe(false);
  });
});

describe("toProductQuery", () => {
  it("is null without filters", () => {
    expect(toProductQuery(none)).toBeNull();
  });

  it("matches any chosen type and any chosen vendor", () => {
    expect(
      toProductQuery({
        ...none,
        types: ["Dairy", "Cheese"],
        vendors: ["Freshness Demo"],
      }),
    ).toBe(
      '(product_type:"Dairy" OR product_type:"Cheese") AND (vendor:"Freshness Demo")',
    );
  });

  it("combines the search with the filters", () => {
    expect(toProductQuery({ ...none, search: "milk", types: ["Dairy"] })).toBe(
      'milk AND (product_type:"Dairy")',
    );
  });

  it("escapes quotes and backslashes inside a value", () => {
    expect(toProductQuery({ ...none, vendors: ['Joe "J" \\ Co'] })).toBe(
      '(vendor:"Joe \\"J\\" \\\\ Co")',
    );
  });

  // Each of these would otherwise change what Shopify searches for
  it.each([
    ["vendor:Acme", "vendor\\:Acme"],
    ["(milk)", "\\(milk\\)"],
    ["-milk", "\\-milk"],
    ["mi*", "mi\\*"],
    ['say "hi"', 'say \\"hi\\"'],
    ["milk AND bread", "milk and bread"],
    ["NOT milk", "not milk"],
  ])("searches %j as words", (search, query) => {
    expect(toProductQuery({ ...none, search })).toBe(query);
  });

  it("keeps a hyphen inside a word", () => {
    expect(toProductQuery({ ...none, search: "free-range" })).toBe(
      "free-range",
    );
  });
});

describe("row filters", () => {
  it("reads status, stock and tracked, ignoring unknown values", () => {
    const filters = parseDashboardFilters(
      new URLSearchParams(
        "status=expired&status=bogus&status=use-soon&stock=over&stock=x&tracked=1",
      ),
    );

    expect(filters).toMatchObject({
      statuses: ["expired", "use-soon"],
      stock: ["over"],
      tracked: true,
    });
    expect(hasRowFilters(filters)).toBe(true);
    expect(hasActiveFilters(filters)).toBe(true);
    // Shopify's search can't see these, so they stay out of its query
    expect(toProductQuery(filters)).toBeNull();
  });

  it("isn't tracked-only unless the param is 1", () => {
    expect(
      parseDashboardFilters(new URLSearchParams("tracked=yes")).tracked,
    ).toBe(false);
  });

  const row = (overrides: Partial<DashboardRow>): DashboardRow => ({
    id: "gid://shopify/Product/1",
    title: "Product",
    adminUrl: "shopify://admin/products/1",
    imageUrl: null,
    earliestExpirationDate: null,
    status: "Not set",
    batches: [],
    hiddenBatches: 0,
    hasMoreBatches: false,
    stock: null,
    batchTotal: 0,
    uncountedBatches: 0,
    overStock: null,
    unbatchedStock: null,
    ...overrides,
  });
  const batch = {
    id: "gid://shopify/Metaobject/1",
    quantity: 1,
    expirationDate: "2026-11-02",
    freshness: null,
  };
  const milk = row({
    id: "milk",
    status: "Expired",
    batches: [batch],
    overStock: 5,
  });
  const cheddar = row({
    id: "cheddar",
    status: "Fresh",
    batches: [batch],
    unbatchedStock: 2,
  });
  const eggs = row({ id: "eggs", status: "Fresh", batches: [batch] });
  const loaf = row({ id: "loaf", status: "Use Soon", batches: [batch] });
  const liquid = row({
    id: "liquid",
    status: "Can't read batches",
    batchTotal: null,
  });
  const snowboard = row({ id: "snowboard" });
  const rows = [milk, cheddar, eggs, loaf, liquid, snowboard];
  const ids = (filters: Partial<DashboardFilters>) =>
    filterRows(rows, { ...none, ...filters }).map(({ id }) => id);

  it("keeps every row without row filters", () => {
    expect(ids({})).toHaveLength(rows.length);
  });

  it("keeps rows with any chosen status", () => {
    expect(ids({ statuses: ["expired", "use-soon"] })).toStrictEqual([
      "milk",
      "loaf",
    ]);
  });

  it.each([
    [["not-set"], ["snowboard"]],
    [["unreadable"], ["liquid"]],
  ] as const)("matches the %j status", (statuses, expected) => {
    expect(ids({ statuses: [...statuses] })).toStrictEqual(expected);
  });

  it("keeps rows with any chosen stock issue", () => {
    expect(ids({ stock: ["over"] })).toStrictEqual(["milk"]);
    expect(ids({ stock: ["over", "unbatched"] })).toStrictEqual([
      "milk",
      "cheddar",
    ]);
  });

  it("keeps only products with batches, readable or not", () => {
    expect(ids({ tracked: true })).toStrictEqual([
      "milk",
      "cheddar",
      "eggs",
      "loaf",
      "liquid",
    ]);
  });

  it("needs every filter to match", () => {
    expect(ids({ statuses: ["fresh"], stock: ["unbatched"] })).toStrictEqual([
      "cheddar",
    ]);
  });
});

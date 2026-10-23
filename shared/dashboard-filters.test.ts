import { describe, it, expect } from "vitest";

import type { DashboardRow } from "./dashboard";
import {
  type DashboardFilters,
  filterRows,
  hasActiveFilters,
  hasRowFilters,
  parseDashboardFilters,
  toProductQuery,
  toProductSort,
  DEFAULT_SORT,
  applySort,
  applyExpiry,
  clearFilters,
  presetRange,
} from "./dashboard-filters";

const none: DashboardFilters = {
  search: "",
  types: [],
  vendors: [],
  statuses: [],
  stock: [],
  tracked: false,
  expiry: null,
  sort: DEFAULT_SORT,
};

describe("parseDashboardFilters", () => {
  it("reads the search, types and vendors, keeping the app's other params out", () => {
    const params = new URLSearchParams(
      "shop=x.myshopify.com&q=+milk+&type=Dairy&type=Cheese&vendor=Acme",
    );

    expect(parseDashboardFilters(params)).toStrictEqual({
      ...none,
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
  it("reads the sort, and falls back to Product A–Z for an unknown one", () => {
    const sortOf = (search: string) =>
      parseDashboardFilters(new URLSearchParams(search)).sort;

    expect(sortOf("sort=stock-desc")).toBe("stock-desc");
    expect(sortOf("sort=price")).toBe("title");
    expect(sortOf("")).toBe("title");
  });

  it("doesn't count the sort as a filter", () => {
    expect(
      hasActiveFilters(
        parseDashboardFilters(new URLSearchParams("sort=vendor")),
      ),
    ).toBe(false);
  });
});

describe("applySort and clearFilters", () => {
  it("leaves the default sort out of the URL", () => {
    const params = new URLSearchParams("sort=stock&q=milk");

    applySort(params, "vendor");
    expect(params.get("sort")).toBe("vendor");
    applySort(params, DEFAULT_SORT);
    expect(params.toString()).toBe("q=milk");
  });

  it("keeps the sort and the app's params when the filters are cleared", () => {
    const params = new URLSearchParams(
      "shop=x.myshopify.com&q=milk&type=Dairy&vendor=Acme&status=expired&stock=over&tracked=1&expiry=7d&expiry_from=2026-10-01&expiry_to=2026-10-31&sort=stock-desc",
    );

    clearFilters(params);
    expect(params.toString()).toBe("shop=x.myshopify.com&sort=stock-desc");
  });
});

describe("toProductSort", () => {
  it.each([
    ["title", "TITLE", false],
    ["title-desc", "TITLE", true],
    ["stock", "INVENTORY_TOTAL", false],
    ["stock-desc", "INVENTORY_TOTAL", true],
    ["type", "PRODUCT_TYPE", false],
    ["type-desc", "PRODUCT_TYPE", true],
    ["vendor", "VENDOR", false],
    ["vendor-desc", "VENDOR", true],
  ] as const)("sorts %s by %s, reversed: %s", (sort, sortKey, reverse) => {
    expect(toProductSort(sort)).toStrictEqual({ sortKey, reverse });
  });
});

describe("expiry filter", () => {
  const expiryOf = (search: string) =>
    parseDashboardFilters(new URLSearchParams(search)).expiry;

  it("reads a preset, which wins over a custom range", () => {
    expect(expiryOf("expiry=7d")).toStrictEqual({ preset: "7d" });
    expect(expiryOf("expiry=today&expiry_from=2026-10-01")).toStrictEqual({
      preset: "today",
    });
  });

  it("reads a custom range, either end optional, and flips a backwards one", () => {
    expect(
      expiryOf("expiry_from=2026-10-01&expiry_to=2026-10-31"),
    ).toStrictEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(expiryOf("expiry_to=2026-10-31")).toStrictEqual({
      from: null,
      to: "2026-10-31",
    });
    expect(
      expiryOf("expiry_from=2026-10-31&expiry_to=2026-10-01"),
    ).toStrictEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("ignores unknown presets and invalid dates", () => {
    expect(expiryOf("expiry=next-year")).toBeNull();
    expect(expiryOf("expiry_from=2026-02-30&expiry_to=soon")).toBeNull();
  });

  it("counts as a filter", () => {
    expect(hasActiveFilters({ ...none, expiry: { preset: "30d" } })).toBe(true);
  });

  it.each([
    ["expired", { from: null, to: "2026-10-22" }],
    ["today", { from: "2026-10-23", to: "2026-10-23" }],
    ["7d", { from: "2026-10-23", to: "2026-10-30" }],
    ["30d", { from: "2026-10-23", to: "2026-11-22" }],
  ] as const)(
    "turns %s into a range from the shop's today",
    (preset, range) => {
      expect(presetRange(preset, "2026-10-23")).toStrictEqual(range);
    },
  );

  it("writes a preset or a range to the URL, replacing the other", () => {
    const params = new URLSearchParams("expiry_from=2026-10-01&q=milk");

    applyExpiry(params, { preset: "today" });
    expect(params.toString()).toBe("q=milk&expiry=today");
    applyExpiry(params, { from: null, to: "2026-11-01" });
    expect(params.toString()).toBe("q=milk&expiry_to=2026-11-01");
    applyExpiry(params, null);
    expect(params.toString()).toBe("q=milk");
  });
});

describe("toProductQuery", () => {
  it("is null without filters", () => {
    expect(toProductQuery(none)).toBeNull();
  });

  it("searches the earliest expiry metafield by range", () => {
    expect(toProductQuery(none, { from: "2026-10-23", to: "2026-10-30" })).toBe(
      "metafields.$app.earliest_expiration_date:>=2026-10-23 AND metafields.$app.earliest_expiration_date:<=2026-10-30",
    );
    expect(toProductQuery(none, { from: null, to: "2026-11-01" })).toBe(
      "metafields.$app.earliest_expiration_date:<=2026-11-01",
    );
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
    tracked: false,
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
    tracked: true,
    status: "Expired",
    batches: [batch],
    overStock: 5,
  });
  const cheddar = row({
    id: "cheddar",
    tracked: true,
    status: "Fresh",
    batches: [batch],
    unbatchedStock: 2,
  });
  const eggs = row({
    id: "eggs",
    tracked: true,
    status: "Fresh",
    batches: [batch],
  });
  const loaf = row({
    id: "loaf",
    tracked: true,
    status: "Use Soon",
    batches: [batch],
  });
  const liquid = row({
    id: "liquid",
    tracked: true,
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

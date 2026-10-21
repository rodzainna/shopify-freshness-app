import { describe, it, expect } from "vitest";

import {
  type DashboardFilters,
  hasActiveFilters,
  parseDashboardFilters,
  toProductQuery,
} from "./dashboard-filters";

const none: DashboardFilters = { search: "", types: [], vendors: [] };

describe("parseDashboardFilters", () => {
  it("reads the search, types and vendors, keeping the app's other params out", () => {
    const params = new URLSearchParams(
      "shop=x.myshopify.com&q=+milk+&type=Dairy&type=Cheese&vendor=Acme",
    );

    expect(parseDashboardFilters(params)).toStrictEqual({
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
        search: "",
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

import { describe, it, expect, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { loader, shouldRevalidate } from "./app._index";

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));

type Args = Parameters<typeof shouldRevalidate>[0];
const revalidates = (args: Partial<Args>) =>
  shouldRevalidate({ defaultShouldRevalidate: true, ...args } as Args);

describe("dashboard revalidation", () => {
  // Saved, or changed by someone else: either way the rows are out of date
  it.each(["saved", "changed"])("reloads after a %s result", (kind) => {
    expect(
      revalidates({ formAction: "/app/batches", actionResult: { kind } }),
    ).toBe(true);
  });

  it.each(["invalid", "unchanged", "unavailable"])(
    "doesn't reload after a %s result",
    (kind) => {
      expect(
        revalidates({ formAction: "/app/batches", actionResult: { kind } }),
      ).toBe(false);
    },
  );

  it("doesn't reload after an error message", () => {
    expect(
      revalidates({
        formAction: "/app/batches",
        actionResult: { message: "Couldn't reach Shopify. Try again." },
      }),
    ).toBe(false);
  });

  it("leaves other navigations to React Router", () => {
    expect(revalidates({ defaultShouldRevalidate: false })).toBe(false);
    expect(revalidates({})).toBe(true);
  });
});

describe("dashboard loader, earliest expiry sort", () => {
  const product = (id: string, date: string | null) => ({
    id,
    legacyResourceId: id,
    title: id,
    tracksInventory: false,
    totalInventory: 0,
    featuredMedia: null,
    earliestExpiration: date === null ? null : { value: date },
    freshnessBatches: null,
  });

  // A fake Admin API: dates in title order, 250 per request, and rows by id
  function fakeShop(dates: [string, string | null][], deleted: string[] = []) {
    const byId = new Map(dates.map(([id, date]) => [id, product(id, date)]));
    const graphql = vi.fn(
      async (
        query: string,
        options?: { variables?: Record<string, unknown> },
      ) => {
        const variables = options?.variables ?? {};
        let data: unknown;
        if (query.includes("DashboardExpiryDates")) {
          const start = Number(variables.after ?? 0);
          const end = start + Number(variables.first);
          data = {
            products: {
              nodes: dates.slice(start, end).map(([id, date]) => ({
                id,
                earliestExpiration: date === null ? null : { value: date },
              })),
              pageInfo: {
                hasNextPage: end < dates.length,
                endCursor: String(end),
              },
            },
          };
        } else if (query.includes("DashboardRowsById")) {
          data = {
            shop: { ianaTimezone: "UTC" },
            nodes: (variables.ids as string[]).map((id) =>
              deleted.includes(id) ? null : byId.get(id),
            ),
          };
        } else {
          data = {
            shop: { ianaTimezone: "UTC" },
            products: {
              nodes: dates.map(([id, date]) => product(id, date)),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        return { json: async () => ({ data }) };
      },
    );
    vi.mocked(authenticate.admin).mockResolvedValue({
      admin: { graphql },
    } as never);
    return graphql;
  }

  const load = (search: string) =>
    loader({
      request: new Request(`https://shop.test/app?${search}`),
    } as LoaderFunctionArgs);
  const queriesNamed = (graphql: ReturnType<typeof fakeShop>, name: string) =>
    graphql.mock.calls.filter(([query]) => query.includes(name));

  it("sorts by the dates alone, then loads just the page's rows by id", async () => {
    const graphql = fakeShop([
      ["apple", "2026-11-15"],
      ["bread", "2026-10-19"],
      ["cheese", "2027-03-01"],
    ]);

    const page = await load("sort=expiry");

    expect(page.rows.map(({ title }) => title)).toStrictEqual([
      "bread",
      "apple",
      "cheese",
    ]);
    expect(queriesNamed(graphql, "DashboardRowsById")[0][1]).toMatchObject({
      variables: { ids: ["bread", "apple", "cheese"] },
    });
    // Never the full product query, which reads every product's batches
    expect(queriesNamed(graphql, "FreshnessDashboard")).toHaveLength(0);
  });

  it("reads up to 1,000 dates and says when there are more", async () => {
    const dates = Array.from({ length: 1100 }, (_, index): [string, string] => [
      `p${index}`,
      "2026-11-01",
    ]);
    const graphql = fakeShop(dates);

    const page = await load("sort=expiry&page=20");

    expect(queriesNamed(graphql, "DashboardExpiryDates")).toHaveLength(4);
    expect(page.checked).toStrictEqual({ products: 1000, more: true });
    expect(page.totalPages).toBe(20);
    expect(page.rows[0].title).toBe("p950");
  });

  it("leaves out a product deleted since its date was read", async () => {
    fakeShop(
      [
        ["apple", "2026-11-15"],
        ["bread", "2026-10-19"],
      ],
      ["bread"],
    );

    const page = await load("sort=expiry");

    expect(page.rows.map(({ title }) => title)).toStrictEqual(["apple"]);
  });

  it("reads every product's batches when a status filter is on too", async () => {
    const graphql = fakeShop([["apple", "2026-11-15"]]);

    await load("sort=expiry&status=fresh");

    expect(queriesNamed(graphql, "DashboardExpiryDates")).toHaveLength(0);
    expect(queriesNamed(graphql, "FreshnessDashboard")).toHaveLength(1);
  });
});

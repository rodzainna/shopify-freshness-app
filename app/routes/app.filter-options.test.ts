import { afterEach, describe, it, expect, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { loader } from "./app.filter-options";

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));

function withGraphql(graphql: () => Promise<unknown>) {
  vi.mocked(authenticate.admin).mockResolvedValue({
    admin: { graphql },
  } as never);
}

const load = () =>
  loader({
    request: new Request("https://shop.test/app/filter-options"),
  } as LoaderFunctionArgs);

describe("filter options loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(authenticate.admin).mockReset();
  });

  it("lists the store's product types and vendors", async () => {
    withGraphql(async () => ({
      json: async () => ({
        data: {
          productTypes: { nodes: ["Dairy", "Bakery"] },
          productVendors: { nodes: ["Local Farm"] },
        },
      }),
    }));

    await expect(load()).resolves.toStrictEqual({
      types: ["Dairy", "Bakery"],
      vendors: ["Local Farm"],
      failed: false,
    });
  });

  it("reports a failed Shopify request instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withGraphql(async () => {
      throw new Error("Throttled");
    });

    // A throw would replace the whole dashboard with its error page
    await expect(load()).resolves.toStrictEqual({
      types: [],
      vendors: [],
      failed: true,
    });
  });

  it("reports a failed session lookup instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authenticate.admin).mockRejectedValue(new Error("Database"));

    await expect(load()).resolves.toMatchObject({ failed: true });
  });

  it("reports Shopify's HTTP errors, which arrive as responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withGraphql(async () => {
      throw new Response("{}", { status: 503 });
    });

    await expect(load()).resolves.toMatchObject({ failed: true });
  });

  it("passes on Shopify's sign-in responses, such as an expired session", async () => {
    const expired = new Response(null, { status: 401 });
    withGraphql(async () => {
      throw expired;
    });

    await expect(load()).rejects.toBe(expired);
  });

  it("passes on a sign-in redirect", async () => {
    const bounce = new Response(null, { status: 302 });
    vi.mocked(authenticate.admin).mockRejectedValue(bounce);

    await expect(load()).rejects.toBe(bounce);
  });
});

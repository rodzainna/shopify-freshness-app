import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { fakeShopify } from "../../test/fake-shopify";
import { action, loader } from "./app.batches";

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));

const shop = "batch-route-test.myshopify.com";
const productId = "gid://shopify/Product/1";
const BATCH = "gid://shopify/Metaobject/1";
const opened = [{ id: BATCH, quantity: 6, expirationDate: "2026-10-23" }];

function setup() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [BATCH]: { quantity: 6, expirationDate: "2026-10-23" },
  });
  vi.mocked(authenticate.admin).mockResolvedValue({
    admin: shopify.admin,
    session: { shop },
  } as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
  return shopify;
}

const post = (body: unknown) =>
  action({
    request: new Request("http://localhost/app/batches", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as Parameters<typeof action>[0]);

const get = (query: string) =>
  loader({
    request: new Request(`http://localhost/app/batches?${query}`),
  } as Parameters<typeof loader>[0]);

beforeEach(() => db.productLock.deleteMany({ where: { shop } }));
afterEach(() => vi.clearAllMocks());

describe("app/batches", () => {
  it("saves an edit", async () => {
    const shopify = setup();
    const edited = [{ ...opened[0], quantity: 5 }];

    expect(await post({ productId, opened, edited })).toMatchObject({
      kind: "saved",
      batches: edited,
    });
    expect(shopify.batch(BATCH)?.quantity).toBe(5);
  });

  it.each([
    ["a body that isn't JSON", "not json", "Invalid request."],
    ["a malformed body", { productId, opened }, "Invalid request."],
    [
      "edits that don't match what was opened",
      { productId, opened, edited: [] },
      "The edits don't match the batches that were opened",
    ],
  ])("refuses %s", async (_case, body, message) => {
    setup();

    const response = (await post(body)) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ message });
  });

  it("reads a product's batches", async () => {
    setup();

    expect(
      await get(`productId=${encodeURIComponent(productId)}`),
    ).toStrictEqual({ batches: opened });
  });

  it("refuses a product id that isn't a GID", async () => {
    setup();

    const response = (await get("productId=1")) as Response;

    expect(response.status).toBe(400);
  });
});

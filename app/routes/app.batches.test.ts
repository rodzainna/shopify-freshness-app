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
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(authenticate.admin).mockReset();
});

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

  it("adds a new batch", async () => {
    const shopify = setup();
    const handle = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";

    expect(
      await post({
        productId,
        opened,
        edited: opened,
        added: [{ handle, quantity: 2, expirationDate: "2026-11-01" }],
      }),
    ).toMatchObject({ kind: "saved", failedNew: [] });
    expect(shopify.product(productId)?.batchIds).toStrictEqual([
      BATCH,
      shopify.batchIdByHandle(handle),
    ]);
  });

  it("refuses a new batch whose handle a listed batch already uses", async () => {
    const shopify = setup();
    const handle = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";
    shopify.setHandle(BATCH, handle);

    const response = (await post({
      productId,
      opened,
      edited: opened,
      added: [{ handle, quantity: 2, expirationDate: "2026-11-01" }],
    })) as Response;

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      message: "A new batch's handle is already used by another batch",
    });
  });

  it.each([
    ["a body that isn't JSON", "not json", "Invalid request."],
    ["a malformed body", { productId, opened }, "Invalid request."],
    [
      "a new batch with a bad handle",
      {
        productId,
        opened,
        edited: opened,
        added: [{ handle: "1", quantity: 1, expirationDate: "2026-11-01" }],
      },
      "Invalid request.",
    ],
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

  it("turns a Shopify failure into a message for the editor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const shopify = setup();
    shopify.failNext("GetProductBatches");

    const response = (await post({
      productId,
      opened,
      edited: opened,
    })) as Response;

    expect(response.status).toBe(502);
    expect(await response.json()).toStrictEqual({
      message: "Couldn't reach Shopify. Try again.",
    });
  });

  it("turns Shopify's HTTP errors, which arrive as responses, into a message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authenticate.admin).mockRejectedValue(
      new Response("{}", { status: 503 }),
    );

    const response = (await post({
      productId,
      opened,
      edited: opened,
    })) as Response;

    expect(response.status).toBe(502);
  });

  it("passes on Shopify's sign-in responses", async () => {
    const bounce = new Response(null, { status: 302 });
    vi.mocked(authenticate.admin).mockRejectedValue(bounce);

    await expect(
      get(`productId=${encodeURIComponent(productId)}`),
    ).rejects.toBe(bounce);
  });

  it("reads a product's batches", async () => {
    setup();

    expect(
      await get(`productId=${encodeURIComponent(productId)}`),
    ).toStrictEqual({
      batches: opened,
      earliestExpirationDate: null,
      inventory: { tracksInventory: false, totalInventory: 0 },
    });
  });

  it("refuses a product id that isn't a GID", async () => {
    setup();

    const response = (await get("productId=1")) as Response;

    expect(response.status).toBe(400);
  });
});

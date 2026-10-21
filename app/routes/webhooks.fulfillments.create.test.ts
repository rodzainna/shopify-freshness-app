import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { authenticateWebhookSafely } from "../webhooks.server";
import { action } from "./webhooks.fulfillments.create";
import { fakeShopify } from "../../test/fake-shopify";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

vi.mock("../webhooks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks.server")>()),
  authenticateWebhookSafely: vi.fn(),
}));

const shop = "fulfillment-test.myshopify.com";
const webhookId = "fulfillment-test-webhook";
const productId = "gid://shopify/Product/1";
const batchId = "gid://shopify/Metaobject/1";

// Shaped like a real fulfillments/create payload (extra fields omitted)
const payload = {
  id: 5512345678,
  line_items: [{ id: 1, product_id: 1, quantity: 2 }],
};

function deliver(admin: unknown, body: object = payload) {
  vi.mocked(authenticateWebhookSafely).mockResolvedValue({
    shop,
    topic: "FULFILLMENTS_CREATE",
    webhookId,
    payload: body,
    admin,
  } as unknown as Awaited<ReturnType<typeof authenticateWebhookSafely>>);
  return action({
    request: new Request("http://localhost/webhooks/fulfillments/create", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

function shopWithBatch() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [batchId]: { quantity: 5, expirationDate: "2999-01-01" },
  });
  return shopify;
}

const processed = () =>
  db.processedWebhook.findUnique({ where: { id: webhookId } });

async function clearTestData() {
  await db.processedWebhook.deleteMany({ where: { id: webhookId } });
  await db.fulfillmentPlan.deleteMany({ where: { shop } });
  await db.fulfillmentDiscrepancy.deleteMany({ where: { shop } });
  await db.productLock.deleteMany({ where: { shop } });
}

describe("fulfillments/create webhook", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await clearTestData();
  });
  afterEach(clearTestData);
  afterEach(() => vi.restoreAllMocks());

  it("decrements the fulfilled product's batches and records the webhook", async () => {
    const shopify = shopWithBatch();

    expect((await deliver(shopify.admin)).status).toBe(200);
    expect(shopify.batch(batchId)?.quantity).toBe(3);
    expect(await processed()).toEqual(
      expect.objectContaining({ topic: "FULFILLMENTS_CREATE" }),
    );
    expect(
      await db.fulfillmentPlan.findFirst({ where: { shop } }),
    ).toMatchObject({ fulfillmentId: "gid://shopify/Fulfillment/5512345678" });
  });

  it("skips a webhook it has already processed", async () => {
    const shopify = shopWithBatch();
    await deliver(shopify.admin);

    expect((await deliver(shopify.admin)).status).toBe(200);
    expect(shopify.batch(batchId)?.quantity).toBe(3);
  });

  it("acknowledges a webhook for a shop with no session", async () => {
    expect((await deliver(undefined)).status).toBe(200);
    expect(await processed()).not.toBeNull();
  });

  it("acknowledges a payload with no fulfillment id", async () => {
    const shopify = shopWithBatch();

    expect(
      (await deliver(shopify.admin, { line_items: payload.line_items })).status,
    ).toBe(200);
    expect(shopify.batch(batchId)?.quantity).toBe(5);
    expect(await processed()).not.toBeNull();
  });

  it("asks Shopify to retry when another delivery holds the product", async () => {
    const shopify = shopWithBatch();
    await db.productLock.create({
      data: {
        shop,
        productId,
        token: "other-delivery",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect((await deliver(shopify.admin)).status).toBe(503);
    expect(shopify.batch(batchId)?.quantity).toBe(5);
    expect(await processed()).toBeNull();
  });

  it("acknowledges a webhook whose writes Shopify rejects", async () => {
    const shopify = shopWithBatch();
    shopify.rejectNext("SetBatchQuantity");

    expect((await deliver(shopify.admin)).status).toBe(200);
    expect(shopify.batch(batchId)?.quantity).toBe(5);
    expect(await processed()).not.toBeNull();
  });

  it("leaves the webhook unprocessed when a write fails, so Shopify retries", async () => {
    const shopify = shopWithBatch();
    shopify.failNext("SetBatchQuantity");

    await expect(deliver(shopify.admin)).rejects.toThrow(
      "Simulated network failure in SetBatchQuantity",
    );
    expect(await processed()).toBeNull();

    expect((await deliver(shopify.admin)).status).toBe(200);
    expect(shopify.batch(batchId)?.quantity).toBe(3);
  });
});

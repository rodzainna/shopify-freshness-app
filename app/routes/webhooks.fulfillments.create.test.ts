import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { action } from "./webhooks.fulfillments.create";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

vi.mock("../webhooks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks.server")>()),
  authenticateWebhookSafely: vi.fn(async () => ({
    shop: "fulfillment-test.myshopify.com",
    topic: "FULFILLMENTS_CREATE",
    webhookId: "fulfillment-test-webhook",
  })),
}));

const webhookId = "fulfillment-test-webhook";

const deliver = () =>
  action({
    request: new Request("http://localhost/webhooks/fulfillments/create", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);

async function clearTestWebhook() {
  await db.processedWebhook.deleteMany({ where: { id: webhookId } });
}

describe("fulfillments/create webhook", () => {
  beforeEach(clearTestWebhook);
  afterEach(clearTestWebhook);
  afterEach(() => vi.restoreAllMocks());

  it("acknowledges the webhook and records it as processed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect((await deliver()).status).toBe(200);
    expect(
      await db.processedWebhook.findUnique({ where: { id: webhookId } }),
    ).toEqual(expect.objectContaining({ topic: "FULFILLMENTS_CREATE" }));
  });

  it("skips a webhook it has already processed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await deliver();
    expect((await deliver()).status).toBe(200);
    expect(log).toHaveBeenLastCalledWith(
      `Duplicate FULFILLMENTS_CREATE webhook ${webhookId} for fulfillment-test.myshopify.com, skipping`,
    );
  });
});

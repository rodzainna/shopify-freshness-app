import { describe, it, expect, afterEach, vi } from "vitest";
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

describe("fulfillments/create webhook", () => {
  afterEach(() => vi.restoreAllMocks());

  it("acknowledges the webhook without marking it processed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await action({
      request: new Request("http://localhost/webhooks/fulfillments/create", {
        method: "POST",
      }),
    } as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    // Redeliveries must still run once the decrement is added.
    expect(
      await db.processedWebhook.findUnique({
        where: { id: "fulfillment-test-webhook" },
      }),
    ).toBe(null);
  });
});

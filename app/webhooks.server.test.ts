import { describe, it, expect, afterEach, vi } from "vitest";
import db from "./db.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed
} from "./webhooks.server";

vi.mock("./shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  }
}))

import { authenticate } from "./shopify.server";

const testWebhookId = "test-webhook-id-1234";

describe("webhook dedup", () => {
  afterEach(async () => {
    await db.processedWebhook.deleteMany({ where: { id: testWebhookId } });
  });

  it("treats a fresh webhook ID as not a duplicate", async () => {
    expect(await isDuplicateWebhook(testWebhookId)).toBe(false);
  })

  it("treats a previously recorded webhook ID as a d duplicate", async () => {
    await markWebhookProcessed(testWebhookId, "app/uninstalled");
    expect(await isDuplicateWebhook(testWebhookId)).toBe(true);
  });
});

describe("authenticateWebhookSafely", () => {
  const fakeRequest = new Request("http://localhost/webhooks/app/uninstalled", {
    method: "POST",
  })

  it("passes through a successful authentication unchanged", async () => {
    const fakeContext = { shop: "testshop.myshopify.com", topic: "app/unistalled", webhookId: "abc" };
    vi.mocked(authenticate.webhook).mockResolvedValueOnce(fakeContext as never);

    const result = await authenticateWebhookSafely(fakeRequest);

    expect(result).toBe(fakeContext);
  });

  it("re-throws a Response unchange (ex: a real HMAC failure)", async () => {
    const unauthorized = new Response(undefined, { status: 401 });
    vi.mocked(authenticate.webhook).mockRejectedValueOnce(unauthorized);

    const result = authenticateWebhookSafely(fakeRequest);

    await expect(result).rejects.toBe(unauthorized);
  });

  it("converts a non-Response error into a graceful 400", async () => {
    vi.mocked(authenticate.webhook).mockRejectedValueOnce(
      new SyntaxError("Unexpected token in JSON"),
    );

    try {
      await authenticateWebhookSafely(fakeRequest);
      expect.fail("expected authenticateWebhookSafely to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(400);
    }
  });
});
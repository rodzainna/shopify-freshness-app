import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { action } from "./webhooks.app.uninstalled";

vi.mock("../webhooks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks.server")>()),
  authenticateWebhookSafely: vi.fn(async () => ({
    shop: "uninstall-test.myshopify.com",
    session: undefined,
    topic: "APP_UNINSTALLED",
    webhookId: "uninstall-test-webhook",
  })),
}));

const shop = "uninstall-test.myshopify.com";
const otherShop = "uninstall-other.myshopify.com";
const testShops = { shop: { in: [shop, otherShop] } };

async function clearTestData() {
  await db.productLock.deleteMany({ where: testShops });
  await db.processedWebhook.deleteMany({
    where: { id: "uninstall-test-webhook" },
  });
}

describe("app/uninstalled webhook", () => {
  beforeEach(clearTestData);
  afterEach(clearTestData);

  it("deletes the shop's product locks, even with no session left", async () => {
    const lock = {
      productId: "gid://shopify/Product/1",
      token: "t",
      expiresAt: new Date(),
    };
    await db.productLock.createMany({
      data: [
        { ...lock, shop },
        { ...lock, shop: otherShop },
      ],
    });

    await action({
      request: new Request("http://localhost/webhooks/app/uninstalled", {
        method: "POST",
      }),
    } as Parameters<typeof action>[0]);

    expect(await db.productLock.findMany({ where: testShops })).toEqual([
      expect.objectContaining({ shop: otherShop }),
    ]);
  });
});

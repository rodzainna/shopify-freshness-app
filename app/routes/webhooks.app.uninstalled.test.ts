import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { action } from "./webhooks.app.uninstalled";
import {
  clearShopData,
  seedShopData,
  shopsWithData,
} from "../../test/shop-data";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

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
const shops = [shop, otherShop];
const webhookId = "uninstall-test-webhook";

async function clearTestData() {
  await clearShopData(shops);
  await db.processedWebhook.deleteMany({ where: { id: webhookId } });
}

describe("app/uninstalled webhook", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await clearTestData();
    await seedShopData(shop);
    await seedShopData(otherShop);
  });
  afterEach(clearTestData);
  afterEach(() => vi.restoreAllMocks());

  it("deletes the shop's sessions, locks and plans, keeping discrepancies", async () => {
    const response = await action({
      request: new Request("http://localhost/webhooks/app/uninstalled", {
        method: "POST",
      }),
    } as Parameters<typeof action>[0]);

    expect(response.status).toBe(200);
    expect(await shopsWithData(shops)).toEqual({
      sessions: [otherShop],
      locks: [otherShop],
      plans: [otherShop],
      discrepancies: shops.toSorted(),
      jobs: [otherShop],
    });
  });
});

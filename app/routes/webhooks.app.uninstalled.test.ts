import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { isDuplicateWebhook, markWebhookProcessed } from "../webhooks.server";
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

function uninstall() {
  return action({
    request: new Request("http://localhost/webhooks/app/uninstalled", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

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
    expect((await uninstall()).status).toBe(200);
    expect(await shopsWithData(shops)).toEqual({
      sessions: [otherShop],
      locks: [otherShop],
      plans: [otherShop],
      discrepancies: shops.toSorted(),
      jobs: [otherShop],
    });
    expect(await isDuplicateWebhook(webhookId)).toBe(true);
  });

  it("changes nothing when the same webhook arrives again", async () => {
    await markWebhookProcessed(webhookId, "APP_UNINSTALLED");

    expect((await uninstall()).status).toBe(200);
    expect(await shopsWithData([shop])).toEqual({
      sessions: [shop],
      locks: [shop],
      plans: [shop],
      discrepancies: [shop],
      jobs: [shop],
    });
  });
});

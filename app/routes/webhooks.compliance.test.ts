import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authenticateWebhookSafely } from "../webhooks.server";
import { action } from "./webhooks.compliance";
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
  authenticateWebhookSafely: vi.fn(),
}));

const shop = "compliance-test.myshopify.com";
const otherShop = "compliance-other.myshopify.com";
const shops = [shop, otherShop];

function deliver(topic: string) {
  vi.mocked(authenticateWebhookSafely).mockResolvedValue({
    shop,
    topic,
  } as Awaited<ReturnType<typeof authenticateWebhookSafely>>);
  return action({
    request: new Request("http://localhost/webhooks/compliance", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

describe("compliance webhooks", () => {
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await clearShopData(shops);
    await seedShopData(shop);
    await seedShopData(otherShop);
  });
  afterEach(() => clearShopData(shops));
  afterEach(() => vi.restoreAllMocks());

  it("deletes all of the redacted shop's data, and only that shop's", async () => {
    expect((await deliver("SHOP_REDACT")).status).toBe(200);
    expect(await shopsWithData(shops)).toEqual({
      sessions: [otherShop],
      locks: [otherShop],
      plans: [otherShop],
      discrepancies: [otherShop],
      jobs: [otherShop],
    });
  });

  it.each(["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT"])(
    "acknowledges %s without deleting anything",
    async (topic) => {
      expect((await deliver(topic)).status).toBe(200);
      expect(await shopsWithData(shops)).toEqual({
        sessions: shops.toSorted(),
        locks: shops.toSorted(),
        plans: shops.toSorted(),
        discrepancies: shops.toSorted(),
        jobs: shops.toSorted(),
      });
    },
  );
});

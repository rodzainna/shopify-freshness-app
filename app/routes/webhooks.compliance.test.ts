import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { authenticateWebhookSafely } from "../webhooks.server";
import { action } from "./webhooks.compliance";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

vi.mock("../webhooks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks.server")>()),
  authenticateWebhookSafely: vi.fn(),
}));

const shop = "compliance-test.myshopify.com";
const otherShop = "compliance-other.myshopify.com";
const testShops = { shop: { in: [shop, otherShop] } };

async function seed() {
  for (const owner of [shop, otherShop]) {
    await db.session.create({
      data: {
        id: `offline_${owner}`,
        shop: owner,
        state: "",
        accessToken: "t",
      },
    });
    await db.productLock.create({
      data: {
        shop: owner,
        productId: "gid://shopify/Product/1",
        token: "t",
        expiresAt: new Date(),
      },
    });
  }
}

async function clearTestData() {
  await db.session.deleteMany({ where: testShops });
  await db.productLock.deleteMany({ where: testShops });
}

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
    vi.spyOn(console, "log").mockImplementation(() => {});
    await clearTestData();
    await seed();
  });
  afterEach(clearTestData);
  afterEach(() => vi.restoreAllMocks());

  it("deletes only the redacted shop's data on shop/redact", async () => {
    expect((await deliver("SHOP_REDACT")).status).toBe(200);
    expect(await db.session.findMany({ where: testShops })).toEqual([
      expect.objectContaining({ shop: otherShop }),
    ]);
    expect(await db.productLock.findMany({ where: testShops })).toEqual([
      expect.objectContaining({ shop: otherShop }),
    ]);
  });

  it.each(["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT"])(
    "acknowledges %s without deleting anything",
    async (topic) => {
      expect((await deliver(topic)).status).toBe(200);
      expect(await db.session.count({ where: testShops })).toBe(2);
    },
  );
});

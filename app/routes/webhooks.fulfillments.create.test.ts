import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import db from "../db.server";
import { runFulfillmentJob } from "../fulfillment-jobs.server";
import { authenticateWebhookSafely } from "../webhooks.server";
import { action } from "./webhooks.fulfillments.create";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
  unauthenticated: { admin: vi.fn() },
}));

vi.mock("../webhooks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webhooks.server")>()),
  authenticateWebhookSafely: vi.fn(),
}));

// The runner has its own tests; here it only needs to be started
vi.mock("../fulfillment-jobs.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fulfillment-jobs.server")>()),
  runFulfillmentJob: vi.fn(),
}));

const shop = "fulfillment-test.myshopify.com";
const webhookId = "fulfillment-test-webhook";
const fulfillmentId = "gid://shopify/Fulfillment/5512345678";
const admin = {};

// Shaped like a real fulfillments/create payload (extra fields omitted)
const payload = {
  id: 5512345678,
  admin_graphql_api_id: fulfillmentId,
  line_items: [{ id: 1, product_id: 1, quantity: 2 }],
};

function deliver(body: object = payload, sessionAdmin: unknown = admin) {
  vi.mocked(authenticateWebhookSafely).mockResolvedValue({
    shop,
    topic: "FULFILLMENTS_CREATE",
    webhookId,
    payload: body,
    admin: sessionAdmin,
  } as unknown as Awaited<ReturnType<typeof authenticateWebhookSafely>>);
  return action({
    request: new Request("http://localhost/webhooks/fulfillments/create", {
      method: "POST",
    }),
  } as Parameters<typeof action>[0]);
}

const processed = () =>
  db.processedWebhook.findUnique({ where: { id: webhookId } });
const jobs = () => db.fulfillmentJob.findMany({ where: { shop } });

async function clearTestData() {
  await db.processedWebhook.deleteMany({ where: { id: webhookId } });
  await db.fulfillmentJob.deleteMany({ where: { shop } });
}

describe("fulfillments/create webhook", () => {
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runFulfillmentJob).mockReset().mockResolvedValue();
    await clearTestData();
  });
  afterEach(clearTestData);
  afterEach(() => vi.restoreAllMocks());

  it("saves a job, records the webhook and starts the job", async () => {
    expect((await deliver()).status).toBe(200);

    expect(await jobs()).toMatchObject([
      {
        fulfillmentId,
        status: "pending",
        products: [{ productId: "gid://shopify/Product/1", quantity: 2 }],
      },
    ]);
    expect(await processed()).toEqual(
      expect.objectContaining({ topic: "FULFILLMENTS_CREATE" }),
    );
    expect(runFulfillmentJob).toHaveBeenCalledWith({ shop, fulfillmentId });
  });

  it("still replies 200 when the job can't start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runFulfillmentJob).mockRejectedValue(new Error("Database busy"));

    expect((await deliver()).status).toBe(200);
    // Let the rejected run settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await jobs()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      `Failed to start ${fulfillmentId} for ${shop}`,
      expect.any(Error),
    );
  });

  it("skips a webhook it has already processed", async () => {
    await deliver();
    await db.fulfillmentJob.deleteMany({ where: { shop } });
    vi.mocked(runFulfillmentJob).mockClear();

    expect((await deliver()).status).toBe(200);
    expect(await jobs()).toStrictEqual([]);
    expect(runFulfillmentJob).not.toHaveBeenCalled();
  });

  it.each([
    // null, since undefined would fall back to the default admin
    ["a shop with no session", payload, null],
    [
      "a payload with no fulfillment id",
      { line_items: payload.line_items },
      admin,
    ],
    [
      "a fulfillment with no product line items",
      { ...payload, line_items: [] },
      admin,
    ],
  ])(
    "acknowledges %s without saving a job",
    async (_case, body, sessionAdmin) => {
      expect((await deliver(body, sessionAdmin)).status).toBe(200);

      expect(await processed()).not.toBeNull();
      expect(await jobs()).toStrictEqual([]);
      expect(runFulfillmentJob).not.toHaveBeenCalled();
    },
  );
});

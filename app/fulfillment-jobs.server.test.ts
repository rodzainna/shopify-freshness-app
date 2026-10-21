import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import db from "./db.server";
import {
  STALE_RUN_MS,
  runDueJobs,
  runFulfillmentJob,
  saveFulfillmentJob,
  startJobSweep,
} from "./fulfillment-jobs.server";
import { unauthenticated } from "./shopify.server";
import { fakeShopify } from "../test/fake-shopify";

vi.mock("./shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));

const shop = "fulfillment-jobs-test.myshopify.com";
const fulfillmentId = "gid://shopify/Fulfillment/1";
const key = { shop, fulfillmentId };
const productId = "gid://shopify/Product/1";
const BATCH = "gid://shopify/Metaobject/1";

// 23:58 in the fake shop's timezone (UTC) on the day the batch expires
const receivedAt = new Date("2026-10-21T23:58:00Z");
const afterMidnight = new Date("2026-10-22T00:30:00Z");

function setup() {
  const shopify = fakeShopify();
  shopify.addProduct(productId, {
    [BATCH]: { quantity: 5, expirationDate: "2026-10-21" },
  });
  vi.mocked(unauthenticated.admin).mockResolvedValue({
    admin: shopify.admin,
  } as Awaited<ReturnType<typeof unauthenticated.admin>>);
  return shopify;
}

const saveJob = () =>
  saveFulfillmentJob({
    ...key,
    products: [{ productId, quantity: 2 }],
    receivedAt,
  });

const job = () =>
  db.fulfillmentJob.findUnique({ where: { shop_fulfillmentId: key } });

async function clearTestData() {
  const where = { shop };
  await db.fulfillmentJob.deleteMany({ where });
  await db.fulfillmentPlan.deleteMany({ where });
  await db.fulfillmentDiscrepancy.deleteMany({ where });
  await db.productLock.deleteMany({ where });
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await clearTestData();
});
afterEach(clearTestData);
afterEach(() => vi.restoreAllMocks());

describe("saveFulfillmentJob", () => {
  it("saves a job due at once, and ignores a repeat delivery", async () => {
    await saveJob();
    await db.fulfillmentJob.update({
      where: { shop_fulfillmentId: key },
      data: { attempts: 3 },
    });

    await saveJob();

    expect(await job()).toMatchObject({
      status: "pending",
      attempts: 3,
      nextRunAt: receivedAt,
      products: [{ productId, quantity: 2 }],
    });
  });
});

describe("runFulfillmentJob", () => {
  it("applies a due job, then deletes it", async () => {
    const shopify = setup();
    await saveJob();

    await runFulfillmentJob(key, afterMidnight);

    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    expect(await job()).toBeNull();
    expect(unauthenticated.admin).toHaveBeenCalledWith(shop);
  });

  it("plans against the day the job was received, not the day it runs", async () => {
    const shopify = setup();
    await saveJob();

    await runFulfillmentJob(key, afterMidnight);

    // Expired by the run's date, but fresh on the day it was received
    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    expect(await db.fulfillmentDiscrepancy.count({ where: { shop } })).toBe(0);
  });

  it("leaves a job that isn't due yet", async () => {
    const shopify = setup();
    await saveJob();

    await runFulfillmentJob(key, new Date(receivedAt.getTime() - 1));

    expect(shopify.calls).toStrictEqual([]);
    expect(await job()).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("runs a job only once when two runs start together", async () => {
    const shopify = setup();
    await saveJob();

    await Promise.all([
      runFulfillmentJob(key, afterMidnight),
      runFulfillmentJob(key, afterMidnight),
    ]);

    expect(
      shopify.calls.filter((call) => call === "GetProductBatches"),
    ).toHaveLength(1);
    expect(shopify.batch(BATCH)?.quantity).toBe(3);
  });

  it("leaves a job another run holds, but reclaims one held too long", async () => {
    const shopify = setup();
    await saveJob();
    const claimedAt = afterMidnight;
    await db.fulfillmentJob.update({
      where: { shop_fulfillmentId: key },
      data: { status: "running", claimedAt, attempts: 1 },
    });

    await runFulfillmentJob(key, new Date(claimedAt.getTime() + 1_000));
    expect(shopify.calls).toStrictEqual([]);

    await runFulfillmentJob(key, new Date(claimedAt.getTime() + STALE_RUN_MS));
    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    expect(await job()).toBeNull();
  });

  it("leaves a job alone once a newer run has reclaimed it", async () => {
    const shopify = setup();
    await saveJob();
    const reclaimedAt = new Date(afterMidnight.getTime() + STALE_RUN_MS);
    // A newer run reclaims the job while this one is still working
    const reclaim = () =>
      db.fulfillmentJob.update({
        where: { shop_fulfillmentId: key },
        data: { claimedAt: reclaimedAt, attempts: 2 },
      });

    vi.mocked(unauthenticated.admin).mockImplementationOnce(async () => {
      await reclaim();
      throw new Error("Timed out");
    });
    await runFulfillmentJob(key, afterMidnight);
    expect(await job()).toMatchObject({
      status: "running",
      claimedAt: reclaimedAt,
      lastError: null,
    });

    await db.fulfillmentJob.update({
      where: { shop_fulfillmentId: key },
      data: { status: "pending", claimedAt: null, attempts: 0 },
    });
    vi.mocked(unauthenticated.admin).mockImplementationOnce(async () => {
      await reclaim();
      return { admin: shopify.admin } as Awaited<
        ReturnType<typeof unauthenticated.admin>
      >;
    });
    await runFulfillmentJob(key, afterMidnight);
    // The newer run deletes it when it finishes
    expect(await job()).toMatchObject({ claimedAt: reclaimedAt });
  });

  it("waits out another run on the same product instead of retrying", async () => {
    const shopify = setup();
    await saveJob();
    await db.productLock.create({
      data: {
        shop,
        productId,
        token: "other-run",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    // The other run finishes after 2s, past the 1.5s default wait
    // Awaited: a Prisma query doesn't run until something awaits it
    setTimeout(async () => {
      await db.productLock.deleteMany({ where: { shop, token: "other-run" } });
    }, 2_000);

    await runFulfillmentJob(key, afterMidnight);

    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    expect(await job()).toBeNull();
  }, 15_000);

  it("retries a temporary failure after a delay", async () => {
    const shopify = setup();
    shopify.failNext("GetProductBatches");
    await saveJob();

    await runFulfillmentJob(key, afterMidnight);

    expect(await job()).toMatchObject({
      status: "pending",
      attempts: 1,
      nextRunAt: new Date(afterMidnight.getTime() + 30_000),
      lastError: "Simulated network failure in GetProductBatches",
    });

    await runFulfillmentJob(key, new Date(afterMidnight.getTime() + 30_000));
    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    expect(await job()).toBeNull();
  });

  it("gives up after 8 retries and keeps the last error", async () => {
    const shopify = setup();
    shopify.failNext("GetProductBatches", 9);
    await saveJob();

    let now = afterMidnight;
    for (let attempt = 1; attempt <= 9; attempt++) {
      await runFulfillmentJob(key, now);
      const saved = await job();
      now = saved!.nextRunAt;
    }

    expect(await job()).toMatchObject({
      status: "failed",
      attempts: 9,
      lastError: "Simulated network failure in GetProductBatches",
    });
    expect(shopify.batch(BATCH)?.quantity).toBe(5);
  });

  it("gives up at once when the shop has no session", async () => {
    setup();
    vi.mocked(unauthenticated.admin).mockRejectedValue(
      new SessionNotFoundError("Could not find a session"),
    );
    await saveJob();

    await runFulfillmentJob(key, afterMidnight);

    expect(await job()).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Could not find a session",
    });
  });
});

describe("runDueJobs", () => {
  it("runs due jobs oldest first, and leaves the rest", async () => {
    // Dated 2020 so jobs other test files save now aren't due here
    const shopify = setup();
    const save = (id: string, receivedAt: Date) =>
      saveFulfillmentJob({
        shop,
        fulfillmentId: `gid://shopify/Fulfillment/${id}`,
        products: [{ productId, quantity: 1 }],
        receivedAt,
      });
    await save("2", new Date("2020-01-15T10:00:00Z"));
    await save("1", new Date("2020-01-15T09:00:00Z"));
    await save("later", new Date("2020-01-15T23:00:00Z"));
    await save("failed", new Date("2020-01-15T08:00:00Z"));
    await db.fulfillmentJob.updateMany({
      where: { shop, fulfillmentId: { endsWith: "/failed" } },
      data: { status: "failed" },
    });

    const tried = await runDueJobs(new Date("2020-01-15T12:00:00Z"));

    expect(tried).toBe(2);
    expect(shopify.batch(BATCH)?.quantity).toBe(3);
    const plans = await db.fulfillmentPlan.findMany({
      where: { shop },
      orderBy: { createdAt: "asc" },
      select: { fulfillmentId: true },
    });
    expect(plans.map(({ fulfillmentId }) => fulfillmentId)).toStrictEqual([
      "gid://shopify/Fulfillment/1",
      "gid://shopify/Fulfillment/2",
    ]);
    const left = await db.fulfillmentJob.findMany({
      where: { shop },
      select: { fulfillmentId: true },
      orderBy: { fulfillmentId: "asc" },
    });
    expect(left.map(({ fulfillmentId }) => fulfillmentId)).toStrictEqual([
      "gid://shopify/Fulfillment/failed",
      "gid://shopify/Fulfillment/later",
    ]);
  });
  it("carries on with later jobs when one hits a database error", async () => {
    const shopify = setup();
    for (const [id, receivedAt] of [
      ["1", "2020-01-15T09:00:00Z"],
      ["2", "2020-01-15T10:00:00Z"],
    ]) {
      await saveFulfillmentJob({
        shop,
        fulfillmentId: `gid://shopify/Fulfillment/${id}`,
        products: [{ productId, quantity: 1 }],
        receivedAt: new Date(receivedAt),
      });
    }
    // The first job's claim fails
    vi.spyOn(db.fulfillmentJob, "updateMany").mockRejectedValueOnce(
      new Error("Database is locked"),
    );

    await runDueJobs(new Date("2020-01-15T12:00:00Z"));

    expect(shopify.batch(BATCH)?.quantity).toBe(4);
    expect(console.error).toHaveBeenCalledWith(
      `Failed to run gid://shopify/Fulfillment/1 for ${shop}`,
      expect.any(Error),
    );
  });

  it("bases a job's claim and retry on when it runs, not when the sweep began", async () => {
    const shopify = setup();
    shopify.failNext("GetProductBatches");
    await saveFulfillmentJob({
      ...key,
      products: [{ productId, quantity: 1 }],
      receivedAt: new Date("2020-01-15T09:00:00Z"),
    });
    const before = Date.now();

    await runDueJobs(new Date("2020-01-15T12:00:00Z"));

    const saved = await job();
    expect(saved!.claimedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved!.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });
});

describe("startJobSweep", () => {
  afterEach(() => {
    clearInterval(global.fulfillmentJobSweep);
    global.fulfillmentJobSweep = undefined;
  });

  it("replaces the previous timer instead of adding a second sweep", () => {
    const clear = vi.spyOn(global, "clearInterval");

    startJobSweep();
    const first = global.fulfillmentJobSweep;
    startJobSweep();

    expect(clear).toHaveBeenCalledWith(first);
    expect(global.fulfillmentJobSweep).not.toBe(first);
  });
});

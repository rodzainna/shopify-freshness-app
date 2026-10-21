import db from "../app/db.server";

const productId = "gid://shopify/Product/1";
const fulfillmentId = "gid://shopify/Fulfillment/1";

// One row per shop-scoped table, so cleanup tests cover every table.
export async function seedShopData(shop: string) {
  await db.session.create({
    data: { id: `offline_${shop}`, shop, state: "", accessToken: "t" },
  });
  await db.productLock.create({
    data: { shop, productId, token: "t", expiresAt: new Date() },
  });
  await db.fulfillmentPlan.create({
    data: { shop, fulfillmentId, productId, plan: {} },
  });
  await db.fulfillmentDiscrepancy.create({
    data: { shop, fulfillmentId, productId, reason: "oversell", shortfall: 1 },
  });
  await db.fulfillmentJob.create({
    data: {
      shop,
      fulfillmentId,
      products: [],
      receivedAt: new Date(),
      nextRunAt: new Date(),
    },
  });
}

export async function clearShopData(shops: string[]) {
  const where = { shop: { in: shops } };
  await db.session.deleteMany({ where });
  await db.productLock.deleteMany({ where });
  await db.fulfillmentPlan.deleteMany({ where });
  await db.fulfillmentDiscrepancy.deleteMany({ where });
  await db.fulfillmentJob.deleteMany({ where });
}

// Which of the given shops still have rows in each table.
export async function shopsWithData(shops: string[]) {
  const where = { shop: { in: shops } };
  const select = { shop: true };
  const owners = (rows: { shop: string }[]) =>
    rows.map((row) => row.shop).sort();
  return {
    sessions: owners(await db.session.findMany({ where, select })),
    locks: owners(await db.productLock.findMany({ where, select })),
    plans: owners(await db.fulfillmentPlan.findMany({ where, select })),
    discrepancies: owners(
      await db.fulfillmentDiscrepancy.findMany({ where, select }),
    ),
    jobs: owners(await db.fulfillmentJob.findMany({ where, select })),
  };
}

import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateWebhookSafely } from "../webhooks.server";

// The app stores no customer data, so only shop/redact has anything to delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookSafely(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    const where = { shop };
    await db.$transaction([
      db.session.deleteMany({ where }),
      db.productLock.deleteMany({ where }),
      db.fulfillmentPlan.deleteMany({ where }),
      db.fulfillmentDiscrepancy.deleteMany({ where }),
      db.fulfillmentJob.deleteMany({ where }),
    ]);
  }

  return new Response();
};

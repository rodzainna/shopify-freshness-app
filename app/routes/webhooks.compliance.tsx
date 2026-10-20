import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateWebhookSafely } from "../webhooks.server";

// The app stores no customer data, so only shop/redact has anything to delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookSafely(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await db.session.deleteMany({ where: { shop } });
    await db.productLock.deleteMany({ where: { shop } });
  }

  return new Response();
};

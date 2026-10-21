import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed,
} from "../webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticateWebhookSafely(request);

  if (await isDuplicateWebhook(webhookId)) {
    console.log(
      `Duplicate ${topic} webhook ${webhookId} for ${shop}, skipping`,
    );
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  // Discrepancies are kept until shop/redact, so a quick reinstall keeps them.
  const where = { shop };
  await db.$transaction([
    db.session.deleteMany({ where }),
    db.productLock.deleteMany({ where }),
    db.fulfillmentPlan.deleteMany({ where }),
    db.fulfillmentJob.deleteMany({ where }),
  ]);

  await markWebhookProcessed(webhookId, topic);

  return new Response();
};

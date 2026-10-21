import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  processedWebhookQuery,
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
  // Marked in the same transaction, so a retry after a reinstall can't delete the new session.
  const where = { shop };
  await db.$transaction([
    db.session.deleteMany({ where }),
    db.productLock.deleteMany({ where }),
    db.fulfillmentPlan.deleteMany({ where }),
    db.fulfillmentJob.deleteMany({ where }),
    processedWebhookQuery(webhookId, topic),
  ]);

  return new Response();
};

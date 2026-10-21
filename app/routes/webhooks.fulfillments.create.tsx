import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  runFulfillmentJob,
  saveFulfillmentJob,
} from "../fulfillment-jobs.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed,
  processedWebhookQuery,
} from "../webhooks.server";
import {
  groupLineItemsByProduct,
  toFulfillmentGid,
} from "../../shared/fulfillment";

// Saves the fulfillment as a job and replies at once: Shopify allows 5s, and
// applying it takes about 2s per product.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, admin } =
    await authenticateWebhookSafely(request);

  if (await isDuplicateWebhook(webhookId)) {
    console.log(
      `Duplicate ${topic} webhook ${webhookId} for ${shop}, skipping`,
    );
    return new Response();
  }

  console.log(`Received ${topic} webhook ${webhookId} for ${shop}`);

  const fulfillmentId = toFulfillmentGid(payload);
  // No session means the app was uninstalled, so there's nothing to update
  if (!admin || !fulfillmentId) {
    console.warn(
      `Skipping ${topic} webhook ${webhookId}: ${admin ? "no fulfillment id" : "no session"}`,
    );
    await markWebhookProcessed(webhookId, topic);
    return new Response();
  }

  const { products, skipped } = groupLineItemsByProduct(payload.line_items);
  if (skipped.length > 0) {
    console.warn(`Skipped line items in ${fulfillmentId}:`, skipped);
  }
  if (products.length === 0) {
    await markWebhookProcessed(webhookId, topic);
    return new Response();
  }

  // Together, so a webhook is never marked processed without its job
  await db.$transaction([
    saveFulfillmentJob({
      shop,
      fulfillmentId,
      products,
      receivedAt: new Date(),
    }),
    processedWebhookQuery(webhookId, topic),
  ]);

  // Not awaited: the sweep retries the job if this run fails or never starts
  runFulfillmentJob({ shop, fulfillmentId }).catch((error: unknown) => {
    console.error(`Failed to start ${fulfillmentId} for ${shop}`, error);
  });
  return new Response();
};

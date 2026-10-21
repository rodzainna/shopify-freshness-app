import type { ActionFunctionArgs } from "react-router";
import { processFulfillment } from "../fulfillment.server";
import { readShopToday } from "../fulfillment-shopify.server";
import { ProductLockBusyError } from "../product-lock.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed,
} from "../webhooks.server";
import {
  groupLineItemsByProduct,
  toFulfillmentGid,
} from "../../shared/fulfillment";

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

  const started = Date.now();
  try {
    const today = await readShopToday(admin, new Date());
    await processFulfillment({ admin, shop, fulfillmentId, today }, products);
  } catch (error) {
    // Another delivery holds a product; Shopify retries a 503 later
    if (error instanceof ProductLockBusyError) {
      console.warn(error.message);
      return new Response(undefined, { status: 503 });
    }
    throw error;
  }
  console.log(
    `Processed ${fulfillmentId} (${products.length} products) in ${Date.now() - started}ms`,
  );

  await markWebhookProcessed(webhookId, topic);
  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed,
} from "../webhooks.server";

// Batches aren't decremented yet: Shopify doesn't redeliver a 2xx, so
// fulfillments acknowledged before the decrement ships aren't replayed.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticateWebhookSafely(request);

  if (await isDuplicateWebhook(webhookId)) {
    console.log(
      `Duplicate ${topic} webhook ${webhookId} for ${shop}, skipping`,
    );
    return new Response();
  }

  console.log(`Received ${topic} webhook ${webhookId} for ${shop}`);

  await markWebhookProcessed(webhookId, topic);

  return new Response();
};

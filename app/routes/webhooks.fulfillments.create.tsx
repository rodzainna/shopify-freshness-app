import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhookSafely } from "../webhooks.server";

// Acknowledges fulfillments until the batch decrement is wired in.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticateWebhookSafely(request);

  console.log(`Received ${topic} webhook ${webhookId} for ${shop}`);

  return new Response();
};

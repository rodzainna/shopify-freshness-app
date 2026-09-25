import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  authenticateWebhookSafely,
  isDuplicateWebhook,
  markWebhookProcessed,
} from "../webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, webhookId } =
    await authenticateWebhookSafely(request);

  if (await isDuplicateWebhook(webhookId)) {
    console.log(
      `Duplicate ${topic} webhook ${webhookId} for ${shop}, skipping`,
    );
    return new Response();
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  await markWebhookProcessed(webhookId, topic);

  return new Response();
};

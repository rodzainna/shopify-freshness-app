import db from "./db.server";
import { authenticate } from "./shopify.server";

export async function isDuplicateWebhook(webhookId: string): Promise<boolean> {
  const existing = await db.processedWebhook.findUnique({
    where: { id: webhookId },
  });
  return existing !== null;
}

// A query, so a caller can run it in the same transaction as its own writes
export function processedWebhookQuery(webhookId: string, topic: string) {
  // Upsert: an overlapping retry of the same webhook may have marked it first
  return db.processedWebhook.upsert({
    where: { id: webhookId },
    create: { id: webhookId, topic },
    update: {},
  });
}

export async function markWebhookProcessed(
  webhookId: string,
  topic: string,
): Promise<void> {
  await processedWebhookQuery(webhookId, topic);
}

export async function authenticateWebhookSafely(request: Request) {
  try {
    return await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    console.error("Malformed webhook payload", error);
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }
}

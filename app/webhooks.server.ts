import db from "./db.server";
import { authenticate } from "./shopify.server";

export async function isDuplicateWebhook(webhookId: string): Promise<boolean> {
  const existing = await db.processedWebhook.findUnique({
    where: { id: webhookId },
  });
  return existing !== null;
}

export async function markWebhookProcessed(
  webhookId: string,
  topic: string,
): Promise<void> {
  await db.processedWebhook.create({
    data: { id: webhookId, topic },
  });
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
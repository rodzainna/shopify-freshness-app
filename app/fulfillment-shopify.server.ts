import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type {
  FulfillmentPlanData,
  StoredBatch,
} from "../shared/fulfillment-plan";
import { getShopToday } from "../shared/freshness";
import { collectErrorMessages } from "../shared/graphql-errors";
import {
  MAX_BATCHES,
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  type SaveProductFreshnessData,
  type UserErrorsPayload,
  saveProductFreshnessVariables,
} from "../shared/product-metafields";

// Shopify rejected the data itself, so retrying the same writes can't succeed
export class PermanentShopifyError extends Error {
  name = "PermanentShopifyError";
}

// admin.graphql throws on top-level GraphQL errors, so only userErrors
// need checking here.
async function query<T>(
  admin: AdminApiContext,
  operation: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(operation, { variables });
  const { data } = (await response.json()) as { data: T };
  return data;
}

export async function readShopToday(
  admin: AdminApiContext,
  now: Date,
): Promise<string> {
  const data = await query<{ shop: { ianaTimezone: string } }>(
    admin,
    `#graphql
      query GetShopTimezone {
        shop {
          ianaTimezone
        }
      }`,
  );
  return getShopToday(data.shop.ianaTimezone, now);
}

interface ProductBatchesData {
  product: {
    freshnessBatches: {
      references: {
        nodes: {
          id?: string;
          quantity?: { value: string } | null;
          expirationDate?: { value: string } | null;
        }[];
        pageInfo: { hasNextPage: boolean };
      } | null;
    } | null;
  } | null;
}

// notTracked: the product has no batch list, so the app has nothing to update
export type ProductBatches =
  | { batches: StoredBatch[] }
  | { notTracked: true }
  | { problem: "product_not_found" | "too_many_batches" };

export async function readProductBatches(
  admin: AdminApiContext,
  productId: string,
): Promise<ProductBatches> {
  const { product } = await query<ProductBatchesData>(
    admin,
    `#graphql
      query GetProductBatches($productId: ID!, $maxBatches: Int!) {
        product(id: $productId) {
          freshnessBatches: metafield(key: "freshness_batches") {
            references(first: $maxBatches) {
              nodes {
                ... on Metaobject {
                  id
                  quantity: field(key: "quantity") {
                    value
                  }
                  expirationDate: field(key: "expiration_date") {
                    value
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }`,
    { productId, maxBatches: MAX_BATCHES },
  );

  if (!product) return { problem: "product_not_found" };
  if (!product.freshnessBatches) return { notTracked: true };
  const { references } = product.freshnessBatches;
  // Writing back a list we couldn't fully read would unlink batches, so stop
  if (!references || references.nodes.some((node) => !node.id)) {
    throw new PermanentShopifyError(
      `Product ${productId} has a batch list the app can't read`,
    );
  }
  if (references.pageInfo.hasNextPage) return { problem: "too_many_batches" };

  return {
    batches: references.nodes.map((node) => ({
      id: node.id!,
      quantity: Number(node.quantity?.value ?? 0),
      expirationDate: node.expirationDate?.value ?? "",
    })),
  };
}

/**
 * Writes a plan in the panel's order: quantities, then the list and date,
 * then deletes, so the list never points at a deleted batch. Every write
 * sets a final value, so re-running it after a partial failure is safe.
 */
export async function applyPlan(
  admin: AdminApiContext,
  productId: string,
  plan: FulfillmentPlanData,
  earliestExpirationDate: string | null,
): Promise<void> {
  await writeEach(plan.updates, ({ id, after }) =>
    setBatchQuantity(admin, id, after),
  );

  const freshness = await query<SaveProductFreshnessData>(
    admin,
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    saveProductFreshnessVariables(
      productId,
      plan.batchIds,
      earliestExpirationDate,
    ),
  );
  throwOnUserErrors(
    `Saving product ${productId} freshness`,
    freshness.metafieldsSet?.userErrors,
    freshness.metafieldsDelete?.userErrors,
  );

  await writeEach(plan.deletes, ({ id }) => deleteBatch(admin, id));
}

// Enough to overlap round trips without spending Shopify's rate limit at once
const MAX_WRITES_IN_FLIGHT = 10;

/**
 * Runs independent writes in groups, waiting for every one to settle so none
 * is still landing after this returns. Throws once, listing every failure.
 */
async function writeEach<T>(
  items: T[],
  write: (item: T) => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  for (let start = 0; start < items.length; start += MAX_WRITES_IN_FLIGHT) {
    const group = items.slice(start, start + MAX_WRITES_IN_FLIGHT);
    const results = await Promise.allSettled(group.map(write));
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const messages = errors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    // Any temporary failure keeps the whole step retryable
    const permanent = errors.every(
      (error) => error instanceof PermanentShopifyError,
    );
    const Combined = permanent ? PermanentShopifyError : Error;
    throw new Combined(messages.join("; "));
  }
}

async function setBatchQuantity(
  admin: AdminApiContext,
  id: string,
  quantity: number,
): Promise<void> {
  const data = await query<{
    metaobjectUpdate: UserErrorsPayload | null;
  }>(
    admin,
    `#graphql
      mutation SetBatchQuantity($id: ID!, $quantity: String!) {
        metaobjectUpdate(
          id: $id
          metaobject: { fields: [{ key: "quantity", value: $quantity }] }
        ) {
          userErrors {
            field
            message
            code
          }
        }
      }`,
    { id, quantity: String(quantity) },
  );
  throwOnUserErrors(
    `Setting batch ${id} quantity`,
    data.metaobjectUpdate?.userErrors,
  );
}

async function deleteBatch(admin: AdminApiContext, id: string): Promise<void> {
  const data = await query<{
    metaobjectDelete: UserErrorsPayload | null;
  }>(
    admin,
    `#graphql
      mutation DeleteBatch($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
            code
          }
        }
      }`,
    { id },
  );
  // Already gone means an earlier attempt deleted it
  const errors = data.metaobjectDelete?.userErrors.filter(
    (error) => error.code !== "RECORD_NOT_FOUND",
  );
  throwOnUserErrors(`Deleting batch ${id}`, errors);
}

function throwOnUserErrors(
  action: string,
  ...userErrors: ({ message: string }[] | undefined)[]
): void {
  const messages = collectErrorMessages(undefined, ...userErrors);
  if (messages.length > 0) {
    throw new PermanentShopifyError(`${action} failed: ${messages.join("; ")}`);
  }
}

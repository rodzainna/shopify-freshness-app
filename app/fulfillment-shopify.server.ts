import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type {
  FulfillmentPlanData,
  StoredBatch,
} from "../shared/fulfillment-plan";
import { getShopToday } from "../shared/freshness";
import { collectErrorMessages } from "../shared/graphql-errors";
import {
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  type SaveProductFreshnessData,
  saveProductFreshnessVariables,
} from "../shared/product-metafields";

interface UserError {
  message: string;
  code: string | null;
}

// Shopify's largest page size; a partial list would drop batches on write
const MAX_BATCHES = 250;

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
      };
    } | null;
  } | null;
}

export type ProductBatches =
  | { batches: StoredBatch[] }
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
  const references = product.freshnessBatches?.references;
  if (references?.pageInfo.hasNextPage) return { problem: "too_many_batches" };

  return {
    batches: (references?.nodes ?? []).flatMap((node) =>
      node.id
        ? [
            {
              id: node.id,
              quantity: Number(node.quantity?.value ?? 0),
              expirationDate: node.expirationDate?.value ?? "",
            },
          ]
        : [],
    ),
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
  for (const { id, after } of plan.updates) {
    const data = await query<{
      metaobjectUpdate: { userErrors: UserError[] } | null;
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
      { id, quantity: String(after) },
    );
    throwOnUserErrors(
      `Setting batch ${id} quantity`,
      data.metaobjectUpdate?.userErrors,
    );
  }

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

  for (const { id } of plan.deletes) {
    const data = await query<{
      metaobjectDelete: { userErrors: UserError[] } | null;
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
}

function throwOnUserErrors(
  action: string,
  ...userErrors: ({ message: string }[] | undefined)[]
): void {
  const messages = collectErrorMessages(undefined, ...userErrors);
  if (messages.length > 0) {
    throw new Error(`${action} failed: ${messages.join("; ")}`);
  }
}

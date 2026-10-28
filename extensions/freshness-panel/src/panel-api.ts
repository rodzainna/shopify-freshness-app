import { collectErrorMessages } from "../../../shared/graphql-errors";
import { type ProductInventory } from "../../../shared/inventory";
import {
  MAX_BATCHES,
  SAVE_BATCH_LIST_MUTATION,
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  SET_BATCH_FIELDS_MUTATION,
  type SaveBatchListData,
  type SaveProductFreshnessData,
  type SetBatchFieldsData,
  UPSERT_BATCH_MUTATION,
  type UpsertBatchData,
  type UserErrorsPayload,
  isReadableBatch,
  saveBatchListVariables,
  saveProductFreshnessVariables,
  upsertBatchVariables,
} from "../../../shared/product-metafields";

interface PanelProduct extends ProductInventory {
  freshnessBatches: {
    compareDigest: string;
    references: {
      // null for a batch that no longer resolves
      nodes: (FreshnessBatchNode | null)[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

interface PanelData {
  shop: { ianaTimezone: string };
  product: PanelProduct | null;
}

export interface LoadedPanelData {
  shop: PanelData["shop"];
  product: PanelProduct;
  batches: PanelBatch[];
  // null when the product has no batch list yet
  listDigest: string | null;
}

// A load failure that retrying can't fix, so the panel offers no retry
export class PermanentLoadError extends Error {}

// One request for the shop's timezone, the product's stock and its batches
export async function loadPanelData(
  productId: string,
): Promise<LoadedPanelData> {
  const { data, errors } = await shopify.query<PanelData>(
    `
    query GetPanelData($productId: ID!, $maxBatches: Int!) {
      shop {
        ianaTimezone
      }
      product(id: $productId) {
        tracksInventory
        totalInventory
        freshnessBatches: metafield(key: "freshness_batches") {
          compareDigest
          references(first: $maxBatches) {
            nodes {
              ... on Metaobject {
                id
                handle
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
    }
  `,
    { variables: { productId, maxBatches: MAX_BATCHES } },
  );

  // Partial data counts as a failure: a missing batch list would look empty
  if (errors?.length) {
    throw new Error(collectErrorMessages(errors).join("; "));
  }
  if (!data?.product) {
    throw new PermanentLoadError("Product not found");
  }

  // Saving a partial list would unlink the batches that didn't load
  if (data.product.freshnessBatches?.references.pageInfo.hasNextPage) {
    throw new PermanentLoadError(
      `This product has more than ${MAX_BATCHES} batches.`,
    );
  }

  // No metafield yet (product never saved) -> start with an empty list
  const nodes = data.product.freshnessBatches?.references.nodes ?? [];
  // Saving a list with a batch that didn't resolve would unlink it
  if (!nodes.every(isReadableBatch)) {
    throw new Error(
      "Some batches couldn't be read, so editing is turned off to keep them linked. Try again later.",
    );
  }

  return {
    shop: data.shop,
    product: data.product,
    batches: nodes.map(toPanelBatch),
    listDigest: data.product.freshnessBatches?.compareDigest ?? null,
  };
}

export interface PanelBatch {
  id: string;
  // metaobjectUpsert finds the batch by this, so it must stay the same between saves
  handle: string;
  quantity: number;
  expirationDate: string;
}

interface FreshnessBatchNode {
  id: string;
  handle: string;
  quantity: { value: string } | null;
  expirationDate: { value: string } | null;
}

function toPanelBatch(node: FreshnessBatchNode): PanelBatch {
  return {
    id: node.id,
    handle: node.handle,
    quantity: Number(node.quantity?.value ?? 0),
    expirationDate: node.expirationDate?.value ?? "",
  };
}

// Creates the batch in Shopify, or updates it if its handle already exists.
// Returns the batch's Shopify ID.
export async function saveBatch(batch: PanelBatch): Promise<string> {
  const { data, errors } = await shopify.query<UpsertBatchData>(
    UPSERT_BATCH_MUTATION,
    { variables: upsertBatchVariables(batch) },
  );

  // errors = the request itself failed; userErrors = Shopify rejected the values
  const result = data?.metaobjectUpsert;
  const messages = collectErrorMessages(errors, result?.userErrors);

  if (messages.length > 0 || !result?.metaobject) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }

  return result.metaobject.id;
}

// The list changed since the panel loaded it, so it wasn't overwritten
export class BatchListChangedError extends Error {}

// Writes the list only if it's still the one loaded; returns its new digest
export async function saveBatchList(
  productId: string,
  batchIds: string[],
  compareDigest: string | null,
): Promise<string | null> {
  const { data, errors } = await shopify.query<SaveBatchListData>(
    SAVE_BATCH_LIST_MUTATION,
    { variables: saveBatchListVariables(productId, batchIds, compareDigest) },
  );

  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.some(({ code }) => code === "STALE_OBJECT")) {
    throw new BatchListChangedError();
  }
  const messages = collectErrorMessages(errors, userErrors);
  if (messages.length > 0) {
    throw new Error(`Saving the batch list failed: ${messages.join("; ")}`);
  }

  // Without a digest the next save reports "changed" rather than overwriting
  return data?.metafieldsSet?.metafields?.[0]?.compareDigest ?? null;
}

// Updates a saved batch by id, so one deleted elsewhere fails instead of
// coming back unlinked
export async function writeBatch({
  id,
  quantity,
  expirationDate,
}: PanelBatch): Promise<void> {
  const { data, errors } = await shopify.query<SetBatchFieldsData>(
    SET_BATCH_FIELDS_MUTATION,
    {
      variables: {
        id,
        metaobject: {
          fields: [
            { key: "quantity", value: String(quantity) },
            { key: "expiration_date", value: expirationDate },
          ],
        },
      },
    },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metaobjectUpdate?.userErrors,
  );
  if (messages.length > 0) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }
}

// Sets or deletes the product's freshness metafields; see
// planProductMetafieldWrites for which
export async function saveFreshnessMetafields(
  variables: ReturnType<typeof saveProductFreshnessVariables>,
  action: string,
): Promise<void> {
  const { data, errors } = await shopify.query<SaveProductFreshnessData>(
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    { variables },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metafieldsSet?.userErrors,
    data?.metafieldsDelete?.userErrors,
  );
  if (messages.length > 0) {
    throw new Error(`${action} failed: ${messages.join("; ")}`);
  }
}

// What Shopify holds now, after a write that may or may not have landed;
// null when that can't be read either
export async function readCurrent(
  productId: string,
): Promise<LoadedPanelData | null> {
  return loadPanelData(productId).catch(() => null);
}

interface DeleteBatchData {
  metaobjectDelete: UserErrorsPayload | null;
}

export async function deleteBatch(id: string): Promise<void> {
  const { data, errors } = await shopify.query<DeleteBatchData>(
    `
    mutation DeleteBatch($id: ID!) {
      metaobjectDelete(id: $id) {
        userErrors {
          field
          message
        }
      }
    }
  `,
    { variables: { id } },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metaobjectDelete?.userErrors,
  );

  if (messages.length > 0) {
    throw new Error(`Deleting batch failed: ${messages.join("; ")}`);
  }
}

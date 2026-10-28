import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  type FulfillmentPlanData,
  type StoredBatch,
  checkPlanApplied,
  freshnessAfterPlan,
} from "../shared/fulfillment-plan";
import type { NewBatch } from "../shared/batch-edit";
import { getShopToday } from "../shared/freshness";
import { collectErrorMessages } from "../shared/graphql-errors";
import type { ProductInventory } from "../shared/inventory";
import {
  MAX_BATCHES,
  SAVE_BATCH_LIST_MUTATION,
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  SET_BATCH_FIELDS_MUTATION,
  type SetBatchFieldsData,
  UPSERT_BATCH_MUTATION,
  type UpsertBatchData,
  type SaveProductFreshnessData,
  saveEarliestDateVariables,
  type BatchNode,
  type UserErrorsPayload,
  isReadableBatch,
  saveBatchListVariables,
  saveProductFreshnessVariables,
  upsertBatchVariables,
} from "../shared/product-metafields";

// Shopify rejected the data itself, so retrying the same writes can't succeed
export class PermanentShopifyError extends Error {
  name = "PermanentShopifyError";
}

// The batch list changed since it was read, so it wasn't overwritten
export class BatchListChangedError extends Error {
  name = "BatchListChangedError";
}

// A batch a plan touches changed mid-apply; retryable, and the retry drops it
export class BatchesChangedError extends Error {
  name = "BatchesChangedError";
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

/** The product's stock, or null when the product doesn't exist. */
export async function readProductInventory(
  admin: AdminApiContext,
  productId: string,
): Promise<ProductInventory | null> {
  const { product } = await query<{ product: ProductInventory | null }>(
    admin,
    `#graphql
      query GetProductInventory($productId: ID!) {
        product(id: $productId) {
          tracksInventory
          totalInventory
        }
      }`,
    { productId },
  );
  return product;
}

interface ProductBatchesData {
  product: {
    earliestExpiration: { value: string } | null;
    freshnessBatches: {
      compareDigest: string;
      references: {
        // null for a batch that no longer resolves
        nodes: (BatchNode | null)[];
        pageInfo: { hasNextPage: boolean };
      } | null;
    } | null;
  } | null;
}

// notTracked: the product has no batch list, so the app has nothing to update
export type ProductBatches =
  | {
      batches: StoredBatch[];
      earliestExpirationDate: string | null;
      // Lets a list write fail instead of overwriting someone else's change
      listDigest: string;
    }
  | { notTracked: true; earliestExpirationDate: string | null }
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
          earliestExpiration: metafield(key: "earliest_expiration_date") {
            value
          }
          freshnessBatches: metafield(key: "freshness_batches") {
            compareDigest
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
  const earliestExpirationDate = product.earliestExpiration?.value ?? null;
  if (!product.freshnessBatches) {
    return { notTracked: true, earliestExpirationDate };
  }
  const { references } = product.freshnessBatches;
  // Writing back a list we couldn't fully read would unlink batches, so stop
  if (!references || !references.nodes.every(isReadableBatch)) {
    throw new PermanentShopifyError(
      `Product ${productId} has a batch list the app can't read`,
    );
  }
  if (references.pageInfo.hasNextPage) return { problem: "too_many_batches" };

  return {
    batches: references.nodes.map((node) => ({
      id: node.id,
      quantity: Number(node.quantity?.value ?? 0),
      expirationDate: node.expirationDate?.value ?? "",
    })),
    earliestExpirationDate,
    listDigest: product.freshnessBatches.compareDigest,
  };
}

// The panel takes no lock, so its saves can keep changing the list
const LIST_WRITE_ATTEMPTS = 3;

/**
 * Writes quantities, then the list and date, then deletes, so the list never
 * points at a deleted batch. Each write sets a final value, so reruns are safe.
 */
export async function applyPlan(
  admin: AdminApiContext,
  productId: string,
  plan: FulfillmentPlanData,
): Promise<void> {
  await writeEach(plan.updates, ({ id, after }) =>
    setBatchQuantity(admin, id, after),
  );
  await saveListAfterPlan(admin, productId, plan);
  await writeEach(plan.deletes, ({ id }) => deleteBatch(admin, id));
}

// Rebuilds list and date from a fresh read, so batches added meanwhile stay
async function saveListAfterPlan(
  admin: AdminApiContext,
  productId: string,
  plan: FulfillmentPlanData,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { batches, listDigest } = await rereadBatches(admin, productId);
    // e.g. a batch it empties was restocked, or a panel save undid a decrement
    if (checkPlanApplied(plan, batches) === "changed") {
      throw new BatchesChangedError(
        `Product ${productId}'s batches changed mid-fulfillment`,
      );
    }
    const { batchIds, earliestExpirationDate: date } = freshnessAfterPlan(
      plan,
      batches,
    );
    try {
      if (batchIds.length === 0) {
        // Shopify's metafieldsDelete has no stale check, so this is unguarded
        await saveProductFreshness(admin, productId, [], null);
        return;
      }
      if (date === null) {
        // A delete can't join the guarded set, so the clear follows the list
        await saveBatchList(admin, productId, batchIds, listDigest);
        await saveEarliestExpirationDate(admin, productId, null);
        return;
      }
      // One atomic set: a stale list means neither is written
      await saveProductFreshness(admin, productId, batchIds, date, listDigest);
      return;
    } catch (error) {
      if (!(error instanceof BatchListChangedError)) throw error;
      // Not permanent: the job's own retries try again later
      if (attempt === LIST_WRITE_ATTEMPTS) throw error;
      console.info(
        `${productId}'s batch list changed mid-fulfillment, retrying`,
      );
    }
  }
}

async function rereadBatches(
  admin: AdminApiContext,
  productId: string,
): Promise<{ batches: StoredBatch[]; listDigest: string | null }> {
  const read = await readProductBatches(admin, productId);
  if ("problem" in read) {
    throw new PermanentShopifyError(
      `Rereading product ${productId} failed: ${read.problem}`,
    );
  }
  if ("notTracked" in read) return { batches: [], listDigest: null };
  return { batches: read.batches, listDigest: read.listDigest };
}

/**
 * Writes the batch list and earliest date, deleting either when empty.
 *
 * @throws BatchListChangedError if `listDigest` is given and the list changed
 */
export async function saveProductFreshness(
  admin: AdminApiContext,
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
  listDigest?: string | null,
): Promise<void> {
  const freshness = await query<SaveProductFreshnessData>(
    admin,
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    saveProductFreshnessVariables(
      productId,
      batchIds,
      earliestExpirationDate,
      listDigest,
    ),
  );
  throwIfListStale(productId, freshness.metafieldsSet?.userErrors ?? []);
  throwOnUserErrors(
    `Saving product ${productId} freshness`,
    freshness.metafieldsSet?.userErrors,
    freshness.metafieldsDelete?.userErrors,
  );
}

/** Writes only the product's earliest date, deleting it when null. */
export async function saveEarliestExpirationDate(
  admin: AdminApiContext,
  productId: string,
  earliestExpirationDate: string | null,
): Promise<void> {
  const data = await query<SaveProductFreshnessData>(
    admin,
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    saveEarliestDateVariables(productId, earliestExpirationDate),
  );
  throwOnUserErrors(
    `Saving product ${productId} earliest date`,
    data.metafieldsSet?.userErrors,
    data.metafieldsDelete?.userErrors,
  );
}

/**
 * Sets each batch's quantity and date. Every write settles before this
 * returns; the result lists the ones that failed.
 */
export async function writeBatchValues(
  admin: AdminApiContext,
  batches: StoredBatch[],
): Promise<{ batch: StoredBatch; error: unknown }[]> {
  const failures = await settleEach(batches, (batch) =>
    setBatchValues(admin, batch),
  );
  return failures.map(({ item, error }) => ({ batch: item, error }));
}

/**
 * The handles that already belong to a batch some product lists. A batch no
 * product lists is a failed save's leftover, so it isn't included.
 */
export async function findListedHandles(
  admin: AdminApiContext,
  handles: string[],
): Promise<Set<string>> {
  const listed = new Set<string>();
  const failures = await settleEach(handles, async (handle) => {
    if (await isListedHandle(admin, handle)) listed.add(handle);
  });
  if (failures.length > 0) throw failures[0].error;
  return listed;
}

async function isListedHandle(
  admin: AdminApiContext,
  handle: string,
): Promise<boolean> {
  const { metaobjectByHandle: batch } = await query<{
    metaobjectByHandle: {
      id: string;
      referencedBy: { nodes: { key: string }[] };
    } | null;
  }>(
    admin,
    `#graphql
      query FindBatchByHandle($handle: String!) {
        metaobjectByHandle(
          handle: { type: "$app:freshness_batch", handle: $handle }
        ) {
          id
          referencedBy(first: 1) {
            nodes {
              key
            }
          }
        }
      }`,
    { handle },
  );
  return batch !== null && batch.referencedBy.nodes.length > 0;
}

/**
 * Creates each new batch, or updates the unlinked one with its handle, so a
 * retried save doesn't duplicate it. Returns ids by handle and the failures.
 */
export async function upsertBatches(
  admin: AdminApiContext,
  batches: NewBatch[],
): Promise<{
  ids: Map<string, string>;
  failed: { batch: NewBatch; error: unknown }[];
}> {
  const ids = new Map<string, string>();
  const failures = await settleEach(batches, async (batch) => {
    ids.set(batch.handle, await upsertBatch(admin, batch));
  });
  return {
    ids,
    failed: failures.map(({ item, error }) => ({ batch: item, error })),
  };
}

async function upsertBatch(
  admin: AdminApiContext,
  batch: NewBatch,
): Promise<string> {
  const data = await query<UpsertBatchData>(
    admin,
    UPSERT_BATCH_MUTATION,
    upsertBatchVariables(batch),
  );
  const result = data.metaobjectUpsert;
  throwOnUserErrors(`Saving new batch ${batch.handle}`, result?.userErrors);
  if (!result?.metaobject) {
    throw new PermanentShopifyError(
      `Saving new batch ${batch.handle} returned no id`,
    );
  }
  return result.metaobject.id;
}

/**
 * Writes the batch list only if it's still the one read: `compareDigest` is
 * the digest read, or null when the product had no list.
 *
 * @throws BatchListChangedError if the list changed since
 */
export async function saveBatchList(
  admin: AdminApiContext,
  productId: string,
  batchIds: string[],
  compareDigest: string | null,
): Promise<void> {
  const data = await query<{ metafieldsSet: UserErrorsPayload | null }>(
    admin,
    SAVE_BATCH_LIST_MUTATION,
    saveBatchListVariables(productId, batchIds, compareDigest),
  );
  const errors = data.metafieldsSet?.userErrors ?? [];
  throwIfListStale(productId, errors);
  throwOnUserErrors(`Saving product ${productId} batch list`, errors);
}

/** Deletes each batch, settling them all. Returns the ids that failed. */
export async function deleteBatches(
  admin: AdminApiContext,
  ids: string[],
): Promise<string[]> {
  const failures = await settleEach(ids, (id) => deleteBatch(admin, id));
  return failures.map(({ item }) => item);
}

// Enough to overlap round trips without spending Shopify's rate limit at once
const MAX_WRITES_IN_FLIGHT = 10;

/**
 * Runs independent writes in groups, waiting for every one to settle so none
 * is still landing after this returns. Returns the ones that failed.
 */
async function settleEach<T>(
  items: T[],
  write: (item: T) => Promise<void>,
): Promise<{ item: T; error: unknown }[]> {
  const failures: { item: T; error: unknown }[] = [];
  for (let start = 0; start < items.length; start += MAX_WRITES_IN_FLIGHT) {
    const group = items.slice(start, start + MAX_WRITES_IN_FLIGHT);
    const results = await Promise.allSettled(group.map(write));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push({ item: group[index], error: result.reason });
      }
    });
  }
  return failures;
}

/** Like settleEach, but throws once, listing every failure. */
async function writeEach<T>(
  items: T[],
  write: (item: T) => Promise<void>,
): Promise<void> {
  const errors = (await settleEach(items, write)).map(({ error }) => error);

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

function setBatchQuantity(
  admin: AdminApiContext,
  id: string,
  quantity: number,
): Promise<void> {
  return setBatchFields(admin, id, `Setting batch ${id} quantity`, [
    { key: "quantity", value: String(quantity) },
  ]);
}

function setBatchValues(
  admin: AdminApiContext,
  { id, quantity, expirationDate }: StoredBatch,
): Promise<void> {
  return setBatchFields(admin, id, `Saving batch ${id}`, [
    { key: "quantity", value: String(quantity) },
    { key: "expiration_date", value: expirationDate },
  ]);
}

async function setBatchFields(
  admin: AdminApiContext,
  id: string,
  action: string,
  fields: { key: "quantity" | "expiration_date"; value: string }[],
): Promise<void> {
  const data = await query<SetBatchFieldsData>(
    admin,
    SET_BATCH_FIELDS_MUTATION,
    { id, metaobject: { fields } },
  );
  throwOnUserErrors(action, data.metaobjectUpdate?.userErrors);
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

function throwIfListStale(
  productId: string,
  errors: UserErrorsPayload["userErrors"],
): void {
  if (errors.some(({ code }) => code === "STALE_OBJECT")) {
    throw new BatchListChangedError(
      `Product ${productId}'s batch list changed since it was read`,
    );
  }
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

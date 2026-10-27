import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  BatchListChangedError,
  deleteBatches,
  saveBatchList,
  saveEarliestExpirationDate,
  saveProductFreshness,
  upsertBatches,
} from "../fulfillment-shopify.server";
import { ProductLockBusyError, withProductLock } from "../product-lock.server";
import { isShopifySignIn } from "../shopify-response";
import type { NewBatch } from "../../shared/batch-edit";
import type { ProductInventory } from "../../shared/inventory";
import { getEarliestExpirationDate } from "../../shared/freshness";

// The demo tools never run outside `shopify app dev`
export function requireDevelopment() {
  if (process.env.NODE_ENV !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
}

export type StoreProduct = ProductInventory & { id: string; handle: string };

// The demo store has about 60 products, so one page covers them
export async function readStoreProducts(
  admin: AdminApiContext,
): Promise<StoreProduct[]> {
  const response = await admin.graphql(
    `#graphql
      query DemoStoreProducts {
        products(first: 250) {
          nodes {
            id
            handle
            tracksInventory
            totalInventory
          }
        }
      }`,
  );
  const { data } = (await response.json()) as {
    data: { products: { nodes: StoreProduct[] } };
  };
  return data.products.nodes;
}

export type ReseedResult =
  | { kind: "seeded"; added: number; removed: number }
  | { kind: "failed"; message: string };

/**
 * Replaces all of a product's batches with `planned`, under its lock. The new
 * batches are linked before the old ones are deleted, so the list never
 * points at a missing batch.
 */
export async function reseedProduct({
  admin,
  shop,
  productId,
  handle,
  planned,
  lockWaitMs,
}: {
  admin: AdminApiContext;
  shop: string;
  productId: string;
  // The demo product's handle, checked so a plan can't land on another product
  handle: string;
  planned: NewBatch[];
  lockWaitMs?: number;
}): Promise<ReseedResult> {
  try {
    return await withProductLock(
      shop,
      productId,
      () => replaceBatches(admin, productId, handle, planned),
      { waitMs: lockWaitMs },
    );
  } catch (error) {
    if (error instanceof ProductLockBusyError) {
      return failed("The product is being updated. Try again in a moment.");
    }
    throw error;
  }
}

async function replaceBatches(
  admin: AdminApiContext,
  productId: string,
  productHandle: string,
  planned: NewBatch[],
): Promise<ReseedResult> {
  const list = await readBatchList(admin, productId);
  if (!list) return failed("Product not found.");
  if (list.handle !== productHandle) {
    return failed(`This product isn't ${productHandle}.`);
  }

  const { ids, failed: notCreated } = await upsertBatches(admin, planned);
  const created = planned.flatMap(({ handle }) => ids.get(handle) ?? []);
  if (notCreated.length > 0) {
    console.error(`Creating ${productId}'s demo batches failed`, notCreated);
    await removeUnlinked(admin, created);
    return failed(`${notCreated.length} new batches couldn't be created.`);
  }

  // The app deletes an empty list rather than saving "[]"
  if (created.length === 0) {
    try {
      await saveProductFreshness(admin, productId, [], null);
    } catch (error) {
      if (isSignIn(error)) throw error;
      console.error(`Clearing ${productId}'s batch list failed`, error);
      return failed("The old batch list couldn't be cleared.");
    }
    const removed = await removeUnlinked(admin, list.ids);
    return { kind: "seeded", added: 0, removed };
  }

  try {
    await saveBatchList(admin, productId, created, list.digest);
  } catch (error) {
    const unlinked = await linkFailed(admin, productId, created, error);
    if (unlinked) return unlinked;
  }
  const removed = await removeUnlinked(admin, list.ids);
  try {
    await saveEarliestExpirationDate(
      admin,
      productId,
      getEarliestExpirationDate(planned),
    );
  } catch (error) {
    if (isSignIn(error)) throw error;
    console.error(`Saving ${productId}'s earliest date failed`, error);
    return failed("Batches replaced, but the earliest date didn't save.");
  }
  return { kind: "seeded", added: created.length, removed };
}

/**
 * The listed batch ids as stored, so a list pointing at deleted batches can
 * still be replaced. Null when the product doesn't exist.
 */
async function readBatchList(
  admin: AdminApiContext,
  productId: string,
): Promise<{ handle: string; ids: string[]; digest: string | null } | null> {
  const response = await admin.graphql(
    `#graphql
      query GetBatchListIds($productId: ID!) {
        product(id: $productId) {
          handle
          list: metafield(key: "freshness_batches") {
            value
            compareDigest
          }
        }
      }`,
    { variables: { productId } },
  );
  const { data } = (await response.json()) as {
    data: {
      product: {
        handle: string;
        list: { value: string; compareDigest: string } | null;
      } | null;
    };
  };
  if (!data.product) return null;
  const { handle, list } = data.product;
  if (!list) return { handle, ids: [], digest: null };
  return {
    handle,
    ids: parseIds(productId, list.value),
    digest: list.compareDigest,
  };
}

// A list that isn't an array of ids is replaced; its batches can't be found
function parseIds(productId: string, value: string): string[] {
  try {
    const ids: unknown = JSON.parse(value);
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
      return ids;
    }
  } catch {
    // Reported below with the other malformed values
  }
  console.error(`${productId}'s batch list isn't a list of ids`, value);
  return [];
}

// Sign-in responses go on to App Bridge; other HTTP errors are failed writes
function isSignIn(error: unknown): boolean {
  return error instanceof Response && isShopifySignIn(error.status);
}

/**
 * After a failed list write: null when it landed anyway (a lost response),
 * otherwise the failure, with the new batches removed when they're unlinked.
 */
async function linkFailed(
  admin: AdminApiContext,
  productId: string,
  created: string[],
  error: unknown,
): Promise<ReseedResult | null> {
  // A sign-in response goes on to App Bridge
  if (isSignIn(error)) throw error;
  if (error instanceof BatchListChangedError) {
    await removeUnlinked(admin, created);
    return failed("The batches changed during the reseed. Try again.");
  }
  console.error(`Saving ${productId}'s demo batch list failed`, error);
  const list = await readBatchList(admin, productId).catch((readError) => {
    if (isSignIn(readError)) throw readError;
    return null;
  });
  if (!list) return failed("Couldn't tell if the new batches were linked.");
  // The panel may have added a batch since, so check containment, not equality
  if (created.every((id) => list.ids.includes(id))) return null;
  await removeUnlinked(admin, created);
  return failed("The new batches couldn't be linked. Try again.");
}

// No list points at these batches, so one left behind is only clutter.
// Returns how many were deleted.
async function removeUnlinked(
  admin: AdminApiContext,
  ids: string[],
): Promise<number> {
  const notDeleted = await deleteBatches(admin, ids);
  if (notDeleted.length > 0) {
    console.error(`Couldn't delete unlinked batches ${notDeleted.join(", ")}`);
  }
  return ids.length - notDeleted.length;
}

function failed(message: string): ReseedResult {
  return { kind: "failed", message };
}

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  BatchListChangedError,
  PermanentShopifyError,
  type ProductBatches,
  deleteBatches,
  findListedHandles,
  readProductBatches,
  readProductInventory,
  saveBatchList,
  saveEarliestExpirationDate,
  upsertBatches,
  writeBatchValues,
} from "./fulfillment-shopify.server";
import { ProductLockBusyError, withProductLock } from "./product-lock.server";
import {
  type EditableBatch,
  MismatchedEditsError,
  type NewBatch,
  applyEdits,
  planBatchEdit,
  sameValues,
} from "../shared/batch-edit";
import { getEarliestExpirationDate } from "../shared/freshness";
import type { ProductInventory } from "../shared/inventory";
import type { BatchErrors } from "../shared/validation";

export type BatchEditResult =
  | {
      kind: "saved";
      batches: EditableBatch[];
      // Batches whose write failed; they keep their current values
      failed: string[];
      // Handles of new batches that weren't added
      failedNew: string[];
      // The batches saved but the product's earliest date didn't update
      dateFailed: boolean;
    }
  | { kind: "unchanged"; batches: EditableBatch[] }
  | { kind: "invalid"; errors: Record<string, BatchErrors> }
  // Changed since the editor opened; `batches` are the current values
  | { kind: "changed"; batches: EditableBatch[] }
  | { kind: "unavailable"; message: string };

type EditableRead =
  | {
      batches: EditableBatch[];
      earliestExpirationDate: string | null;
      // null when the product has no list yet
      listDigest: string | null;
    }
  | { message: string };

/**
 * The product's batches for the editor, or why they can't be edited. Stock is
 * only shown, so it's null when it can't be read rather than blocking edits.
 */
export async function loadBatches(
  admin: AdminApiContext,
  productId: string,
): Promise<
  | {
      batches: EditableBatch[];
      earliestExpirationDate: string | null;
      inventory: ProductInventory | null;
    }
  | { message: string }
> {
  const [read, inventory] = await Promise.all([
    readForEdit(admin, productId),
    readProductInventory(admin, productId).catch((error) => {
      console.error(`Reading ${productId}'s stock failed`, error);
      return null;
    }),
  ]);
  if ("message" in read) return read;
  return {
    batches: read.batches,
    earliestExpirationDate: read.earliestExpirationDate,
    inventory,
  };
}

// A product without a batch list reads as empty, so batches can be added to it
async function readForEdit(
  admin: AdminApiContext,
  productId: string,
): Promise<EditableRead> {
  try {
    const read = await readProductBatches(admin, productId);
    if ("notTracked" in read) {
      const { earliestExpirationDate } = read;
      return { batches: [], earliestExpirationDate, listDigest: null };
    }
    if ("batches" in read) return read;
    return { message: unavailableMessage(read) };
  } catch (error) {
    if (error instanceof PermanentShopifyError) {
      return { message: "Some batches couldn't be read." };
    }
    throw error;
  }
}

/**
 * Saves the dashboard editor's changes under the product's lock, so a
 * fulfillment can't interleave. Nothing is written if the batches changed
 * since the editor opened. New batches are linked before edits are written,
 * so a list that changed meanwhile still means nothing was saved.
 *
 * @throws MismatchedEditsError if `edited` doesn't cover exactly the opened
 *   batches, or a new batch's handle is bad or already used by a listed batch
 */
export async function editBatches({
  admin,
  shop,
  productId,
  opened,
  edited,
  added = [],
  lockWaitMs,
}: {
  admin: AdminApiContext;
  shop: string;
  productId: string;
  opened: EditableBatch[];
  edited: EditableBatch[];
  added?: NewBatch[];
  lockWaitMs?: number;
}): Promise<BatchEditResult> {
  try {
    return await withProductLock(
      shop,
      productId,
      async (): Promise<BatchEditResult> => {
        const loaded = await readForEdit(admin, productId);
        if ("message" in loaded) return { kind: "unavailable", ...loaded };
        const current = loaded.batches;

        const plan = planBatchEdit(opened, current, edited, added);
        if (plan.kind === "changed") {
          return { kind: "changed", batches: current };
        }
        if (plan.kind === "invalid") return plan;
        if (plan.kind === "tooMany") {
          return {
            kind: "unavailable",
            message:
              plan.limit === "save"
                ? `Add up to ${plan.max} batches at a time.`
                : `A product can have at most ${plan.max} batches.`,
          };
        }

        const updates = plan.kind === "write" ? plan.updates : [];
        const additions = plan.kind === "write" ? plan.additions : [];
        const linked = await addBatches(admin, productId, loaded, additions);
        if (linked.kind === "changed") {
          const reread = await readForEdit(admin, productId);
          if ("message" in reread) return { kind: "unavailable", ...reread };
          return { kind: "changed", batches: reread.batches };
        }

        const after = await writeEdits(
          admin,
          productId,
          linked.batches,
          updates,
        );
        const failed = updates
          .filter((update) => {
            const saved = after.find(({ id }) => id === update.id);
            return !saved || !sameValues(update, saved);
          })
          .map(({ id }) => id);

        // Also repairs a date an earlier save couldn't write
        const earliest = getEarliestExpirationDate(after);
        const dateStale = earliest !== loaded.earliestExpirationDate;
        let dateFailed = false;
        if (dateStale) {
          try {
            await saveEarliestExpirationDate(admin, productId, earliest);
          } catch (error) {
            console.error(`Saving ${productId}'s earliest date failed`, error);
            dateFailed = true;
          }
        }

        if (updates.length === 0 && additions.length === 0 && !dateStale) {
          return { kind: "unchanged", batches: current };
        }
        return {
          kind: "saved",
          batches: after,
          failed,
          failedNew: linked.failedNew,
          dateFailed,
        };
      },
      { waitMs: lockWaitMs },
    );
  } catch (error) {
    if (error instanceof ProductLockBusyError) {
      return {
        kind: "unavailable",
        message: "This product is being updated. Try again in a moment.",
      };
    }
    throw error;
  }
}

/**
 * Creates the new batches and adds the ones created to the product's list.
 * A list write that fails without landing is thrown, leaving the new batches
 * unlinked for a retry to reuse.
 */
async function addBatches(
  admin: AdminApiContext,
  productId: string,
  loaded: Extract<EditableRead, { batches: unknown }>,
  additions: NewBatch[],
): Promise<
  | { kind: "linked"; batches: EditableBatch[]; failedNew: string[] }
  | { kind: "changed" }
> {
  if (additions.length === 0) {
    return { kind: "linked", batches: loaded.batches, failedNew: [] };
  }

  const listed = await findListedHandles(
    admin,
    additions.map(({ handle }) => handle),
  );
  if (listed.size > 0) {
    throw new MismatchedEditsError(
      "A new batch's handle is already used by another batch",
    );
  }

  const { ids, failed } = await upsertBatches(admin, additions);
  for (const { batch, error } of failed) {
    console.error(`Adding batch ${batch.handle} to ${productId} failed`, error);
  }
  const created = additions.flatMap(({ handle, quantity, expirationDate }) => {
    const id = ids.get(handle);
    return id ? [{ id, quantity, expirationDate }] : [];
  });
  const failedNew = failed.map(({ batch }) => batch.handle);
  if (created.length === 0) {
    return { kind: "linked", batches: loaded.batches, failedNew };
  }

  const batches = [...loaded.batches, ...created];
  try {
    await saveBatchList(
      admin,
      productId,
      batches.map(({ id }) => id),
      loaded.listDigest,
    );
  } catch (error) {
    if (!(error instanceof BatchListChangedError)) {
      const linked = await readLanded(admin, productId);
      const linkedIds = new Set(linked?.map(({ id }) => id));
      if (linked && created.every(({ id }) => linkedIds.has(id))) {
        return { kind: "linked", batches: linked, failedNew };
      }
      throw error;
    }
    const notDeleted = await deleteBatches(
      admin,
      created.map(({ id }) => id),
    );
    if (notDeleted.length > 0) {
      console.error(
        `Couldn't remove unlinked batches ${notDeleted.join(", ")}`,
      );
    }
    return { kind: "changed" };
  }
  return { kind: "linked", batches, failedNew };
}

// The batches as Shopify holds them after the writes
async function writeEdits(
  admin: AdminApiContext,
  productId: string,
  current: EditableBatch[],
  updates: EditableBatch[],
): Promise<EditableBatch[]> {
  if (updates.length === 0) return current;
  const failures = await writeBatchValues(admin, updates);
  if (failures.length === 0) return applyEdits(current, updates);

  for (const { batch, error } of failures) {
    console.error(`Saving batch ${batch.id} on ${productId} failed`, error);
  }
  // A write that timed out may still have landed, so read what Shopify holds
  const reread = await readLanded(admin, productId);
  if (reread) return reread;
  const failed = new Set(failures.map(({ batch }) => batch.id));
  return applyEdits(
    current,
    updates.filter(({ id }) => !failed.has(id)),
  );
}

// After a write that timed out, which may still have landed: what Shopify
// holds now, or null when that can't be read either
async function readLanded(
  admin: AdminApiContext,
  productId: string,
): Promise<EditableBatch[] | null> {
  const read = await readForEdit(admin, productId).catch(() => null);
  return read && "batches" in read ? read.batches : null;
}

function unavailableMessage(
  read: Extract<ProductBatches, { problem: unknown }>,
): string {
  if (read.problem === "product_not_found") return "Product not found.";
  return "This product has too many batches to edit here.";
}

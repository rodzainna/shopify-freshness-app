import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  PermanentShopifyError,
  type ProductBatches,
  readProductBatches,
  saveProductFreshness,
  writeBatchValues,
} from "./fulfillment-shopify.server";
import { ProductLockBusyError, withProductLock } from "./product-lock.server";
import {
  type EditableBatch,
  applyEdits,
  planBatchEdit,
} from "../shared/batch-edit";
import { getEarliestExpirationDate } from "../shared/freshness";
import type { BatchErrors } from "../shared/validation";

export type BatchEditResult =
  | {
      kind: "saved";
      batches: EditableBatch[];
      // Batches whose write failed; they keep their current values
      failed: string[];
      // The batches saved but the product's earliest date didn't update
      dateFailed: boolean;
    }
  | { kind: "unchanged"; batches: EditableBatch[] }
  | { kind: "invalid"; errors: Record<string, BatchErrors> }
  // Changed since the editor opened; `batches` are the current values
  | { kind: "changed"; batches: EditableBatch[] }
  | { kind: "unavailable"; message: string };

/** The product's batches for the editor, or why they can't be edited. */
export async function loadBatches(
  admin: AdminApiContext,
  productId: string,
): Promise<{ batches: EditableBatch[] } | { message: string }> {
  try {
    const read = await readProductBatches(admin, productId);
    if ("batches" in read) return { batches: read.batches };
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
 * since the editor opened.
 *
 * @throws MismatchedEditsError if `edited` doesn't cover exactly the opened batches
 */
export async function editBatches({
  admin,
  shop,
  productId,
  opened,
  edited,
  lockWaitMs,
}: {
  admin: AdminApiContext;
  shop: string;
  productId: string;
  opened: EditableBatch[];
  edited: EditableBatch[];
  lockWaitMs?: number;
}): Promise<BatchEditResult> {
  try {
    return await withProductLock(
      shop,
      productId,
      async () => {
        const loaded = await loadBatches(admin, productId);
        if ("message" in loaded) return { kind: "unavailable", ...loaded };
        const current = loaded.batches;

        const plan = planBatchEdit(opened, current, edited);
        if (plan.kind === "changed")
          return { kind: "changed", batches: current };
        if (plan.kind === "unchanged") {
          return { kind: "unchanged", batches: current };
        }
        if (plan.kind === "invalid") return plan;

        const failures = await writeBatchValues(admin, plan.updates);
        for (const { batch, error } of failures) {
          console.error(
            `Saving batch ${batch.id} on ${productId} failed`,
            error,
          );
        }
        const failed = new Set(failures.map(({ batch }) => batch.id));
        const after = applyEdits(
          current,
          plan.updates.filter(({ id }) => !failed.has(id)),
        );

        // The list itself is unchanged; this updates the earliest date
        let dateFailed = false;
        try {
          await saveProductFreshness(
            admin,
            productId,
            current.map(({ id }) => id),
            getEarliestExpirationDate(after),
          );
        } catch (error) {
          console.error(`Saving ${productId}'s earliest date failed`, error);
          dateFailed = true;
        }
        return {
          kind: "saved",
          batches: after,
          failed: [...failed],
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

function unavailableMessage(
  read: Exclude<ProductBatches, { batches: unknown }>,
): string {
  if ("notTracked" in read) return "This product has no batches.";
  if (read.problem === "product_not_found") return "Product not found.";
  return "This product has too many batches to edit here.";
}

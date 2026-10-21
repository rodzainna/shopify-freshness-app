import type { Batch } from "./freshness";
import { validateBatch } from "./validation";

export interface ProductInventory {
  tracksInventory: boolean;
  totalInventory: number;
}

export interface InventoryMismatch {
  batchTotal: number;
  inStock: number;
}

// Skips rows with an invalid quantity; validation reports those
export function totalBatchQuantity(batches: Batch[]): number {
  return batches
    .filter((batch) => !validateBatch(batch).quantity)
    .reduce((total, batch) => total + batch.quantity, 0);
}

/**
 * Batches are entered by hand, so they can drift from Shopify's stock count.
 *
 * @returns both totals when the batches add up to more than is in stock,
 *   or null when inventory isn't tracked or the batches fit
 */
export function getInventoryMismatch(
  batches: Batch[],
  inventory: ProductInventory,
): InventoryMismatch | null {
  if (!inventory.tracksInventory) return null;

  const batchTotal = totalBatchQuantity(batches);
  // Oversold products report negative stock; treat that as none
  const inStock = Math.max(0, inventory.totalInventory);

  return batchTotal > inStock ? { batchTotal, inStock } : null;
}

export function formatInventoryMismatch({
  batchTotal,
  inStock,
}: InventoryMismatch): string {
  if (inStock === 0) {
    return `Batches total ${batchTotal}, but none are in stock.`;
  }
  const verb = inStock === 1 ? "is" : "are";
  return `Batches total ${batchTotal}, but only ${inStock} ${verb} in stock.`;
}

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

// Oversold products report negative stock; treat that as none
export function exceedsStock(
  batchTotal: number,
  inventory: ProductInventory,
): boolean {
  return (
    inventory.tracksInventory &&
    batchTotal > Math.max(0, inventory.totalInventory)
  );
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
  const batchTotal = totalBatchQuantity(batches);
  if (!exceedsStock(batchTotal, inventory)) return null;
  return { batchTotal, inStock: Math.max(0, inventory.totalInventory) };
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

// Stock no batch accounts for yet; null when untracked or every unit is in a batch
export function getUnbatchedStock(
  batchTotal: number,
  inventory: ProductInventory,
): number | null {
  if (!inventory.tracksInventory) return null;
  const unbatched = inventory.totalInventory - batchTotal;
  return unbatched > 0 ? unbatched : null;
}

export function formatUnbatchedStock(units: number): string {
  return units === 1
    ? "1 unit in stock isn't in a batch yet."
    : `${units} units in stock aren't in a batch yet.`;
}

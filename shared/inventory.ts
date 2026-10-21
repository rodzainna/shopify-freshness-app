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

export interface StockComparison {
  // Units across batches with a valid quantity
  batchTotal: number;
  // Batches with an invalid quantity, left out of batchTotal
  uncountedBatches: number;
  // Batch units no stock backs; a lower bound when the batches aren't complete
  overStock: number | null;
  // Stock no batch accounts for; only when every batch is loaded and counted
  unbatchedStock: number | null;
}

/**
 * The one stock rule for the panel and dashboard. Batches are entered by
 * hand, so they can drift from Shopify's stock count.
 *
 * @param complete - false when some batches didn't load
 */
export function compareStock(
  batches: Batch[],
  inventory: ProductInventory,
  complete = true,
): StockComparison {
  let batchTotal = 0;
  let uncountedBatches = 0;
  for (const batch of batches) {
    if (validateBatch(batch).quantity) uncountedBatches += 1;
    else batchTotal += batch.quantity;
  }
  if (!inventory.tracksInventory) {
    return {
      batchTotal,
      uncountedBatches,
      overStock: null,
      unbatchedStock: null,
    };
  }

  // Oversold products report negative stock; treat that as none
  const inStock = Math.max(0, inventory.totalInventory);
  const everyBatchCounted =
    complete && uncountedBatches === 0 && batches.length > 0;
  return {
    batchTotal,
    uncountedBatches,
    overStock: batchTotal > inStock ? batchTotal - inStock : null,
    unbatchedStock:
      everyBatchCounted && inStock > batchTotal ? inStock - batchTotal : null,
  };
}

// The panel's over-stock message, from compareStock
export function getInventoryMismatch(
  batches: Batch[],
  inventory: ProductInventory,
): InventoryMismatch | null {
  const { batchTotal, overStock } = compareStock(batches, inventory);
  return overStock === null
    ? null
    : { batchTotal, inStock: batchTotal - overStock };
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

export function formatUnbatchedStock(units: number): string {
  return units === 1
    ? "1 unit in stock isn't in a batch yet."
    : `${units} units in stock aren't in a batch yet.`;
}

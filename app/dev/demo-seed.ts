import type { NewBatch } from "../../shared/batch-edit";
import { addDays } from "../../shared/freshness";

export type DemoProduct = {
  handle: string;
  title: string;
  // Planned Shopify stock, or null when the product doesn't track it
  stock: number | null;
  batches: ReadonlyArray<readonly [quantity: number, daysFromToday: number]>;
};

// Each run gets new handles, so a reseed never reuses an old batch.
// shopToday is the shop's own date, from getShopToday.
export function planDemoBatches(
  product: DemoProduct,
  shopToday: string,
  makeHandle: () => string,
): NewBatch[] {
  return product.batches.map(([quantity, days]) => ({
    handle: makeHandle(),
    quantity,
    expirationDate: addDays(shopToday, days),
  }));
}

type Tracked = DemoProduct & { stock: number };

const STOCK_CSV_HEADER = [
  "Handle",
  "Title",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Location",
  "On hand (new)",
];

// Shopify's inventory import file; it rejects files without every option column
export function demoStockCsv(
  products: readonly DemoProduct[],
  location: string,
): string {
  const rows = products
    .filter((product): product is Tracked => product.stock !== null)
    .map((product) => stockRow(product, location));
  return [STOCK_CSV_HEADER, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")
    .concat("\n");
}

// Products whose stock the CSV can reset: both sides track stock but differ
export function countStockDiffers(
  rows: readonly { plannedStock: number | null; storeStock: number | null }[],
): number {
  return rows.filter(
    ({ plannedStock, storeStock }) =>
      plannedStock !== null &&
      storeStock !== null &&
      plannedStock !== storeStock,
  ).length;
}

// A product without options is Shopify's single "Default Title" variant
function stockRow({ handle, title, stock }: Tracked, location: string) {
  const options = ["Title", "Default Title", "", "", "", ""];
  return [handle, title, ...options, location, String(stock)];
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

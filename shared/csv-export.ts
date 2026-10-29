import { csvCell } from "./csv";
import {
  type DashboardProductNode,
  type DashboardRow,
  UNREADABLE,
  toDashboardBatch,
} from "./dashboard";
import {
  type FreshnessStatus,
  computeAggregateFreshness,
  isInStock,
} from "./freshness";
import { productStock } from "./inventory";
import { isReadableBatch } from "./product-metafields";

// The export query's product shape: only the fields the file uses
export interface ExportProduct extends Pick<
  DashboardProductNode,
  | "legacyResourceId"
  | "title"
  | "tracksInventory"
  | "totalInventory"
  | "freshnessBatches"
> {
  vendor: string;
  productType: string;
}

export interface ExportRow {
  Product: string;
  Vendor: string;
  Type: string;
  Batches: "None" | "Single" | "Multiple";
  // The stored text, so a value the dashboard can't use is visible to fix
  Quantity: string | null;
  "Expiry date": string | null;
  "Days left": number | null;
  "Batch status": FreshnessStatus | "Sold out" | null;
  "Product status": DashboardRow["status"];
  "Product stock": number | null;
  "Admin link": string;
}

export const EXPORT_COLUMNS: readonly (keyof ExportRow)[] = [
  "Product",
  "Vendor",
  "Type",
  "Batches",
  "Quantity",
  "Expiry date",
  "Days left",
  "Batch status",
  "Product status",
  "Product stock",
  "Admin link",
];

function batchCount(count: number): ExportRow["Batches"] {
  if (count === 0) return "None";
  return count === 1 ? "Single" : "Multiple";
}

/** One row per batch (lists must be complete); one row if none can be read. */
export function toExportRows(
  products: ExportProduct[],
  today: string,
  // e.g. "my-store.myshopify.com"; a plain https link works outside the admin
  shop: string,
): ExportRow[] {
  return products.flatMap((product): ExportRow[] => {
    const references = product.freshnessBatches?.references;
    // A partial list would drop batches and could hide an expired one
    if (references?.pageInfo.hasNextPage) {
      throw new Error(`Export needs every batch of product ${product.title}`);
    }
    const nodes = references?.nodes ?? [];
    const productCells = {
      Product: product.title,
      Vendor: product.vendor,
      Type: product.productType,
      Batches: batchCount(nodes.length),
      "Product stock": productStock(product),
      "Admin link": `https://${shop}/admin/products/${product.legacyResourceId}`,
    };

    if (nodes.length === 0 || !nodes.every(isReadableBatch)) {
      return [
        {
          ...productCells,
          Quantity: null,
          "Expiry date": null,
          "Days left": null,
          "Batch status": null,
          "Product status": nodes.length === 0 ? "Not set" : UNREADABLE,
        },
      ];
    }

    const batches = nodes.map((node) => ({
      node,
      batch: toDashboardBatch(node, today),
    }));
    const productStatus = computeAggregateFreshness(
      batches.map(({ batch }) => batch),
      today,
    );

    return batches.map(({ node, batch }) => ({
      ...productCells,
      Quantity: node.quantity?.value || null,
      "Expiry date": batch.expirationDate || null,
      "Days left": batch.freshness?.daysRemaining ?? null,
      "Batch status": isInStock(batch)
        ? (batch.freshness?.status ?? null)
        : "Sold out",
      "Product status": productStatus,
    }));
  });
}

// Spreadsheets run these as a formula, some after trimming leading blanks
const FORMULA_START = /^(\s*[=+\-@]|[\t\r\n])/;

function toCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return csvCell(FORMULA_START.test(value) ? `'${value}` : value);
}

/** The file's text: a BOM so Excel reads UTF-8, then \r\n lines (RFC 4180). */
export function toCsv(rows: ExportRow[]): string {
  const lines = [
    EXPORT_COLUMNS.map(toCell),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => toCell(row[column]))),
  ];
  return `\uFEFF${lines.map((cells) => cells.join(",")).join("\r\n")}\r\n`;
}

import { type DashboardRow, UNREADABLE } from "./dashboard";

// URL values for the status filter, in the order the choices are listed
export const STATUS_FILTERS = {
  expired: "Expired",
  "use-soon": "Use Soon",
  fresh: "Fresh",
  "not-set": "Not set",
  unreadable: UNREADABLE,
} as const satisfies Record<string, DashboardRow["status"]>;

export const STOCK_FILTERS = {
  over: "Over stock",
  unbatched: "Unbatched",
} as const;

export type StatusFilter = keyof typeof STATUS_FILTERS;
export type StockFilter = keyof typeof STOCK_FILTERS;

// Search and filters the dashboard reads from its URL, e.g. ?q=milk&status=expired
export interface DashboardFilters {
  search: string;
  types: string[];
  vendors: string[];
  statuses: StatusFilter[];
  stock: StockFilter[];
  // Only products with batches
  tracked: boolean;
}

export const FILTER_PARAMS = {
  search: "q",
  type: "type",
  vendor: "vendor",
  status: "status",
  stock: "stock",
  tracked: "tracked",
};

export function parseDashboardFilters(
  params: URLSearchParams,
): DashboardFilters {
  const list = (name: string) => [
    ...new Set(
      params
        .getAll(name)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  // Unknown values (an old or hand-edited URL) are ignored
  const known = <K extends string>(name: string, values: Record<K, string>) =>
    list(name).filter((value): value is K => Object.hasOwn(values, value));
  return {
    search: (params.get(FILTER_PARAMS.search) ?? "").trim(),
    types: list(FILTER_PARAMS.type),
    vendors: list(FILTER_PARAMS.vendor),
    statuses: known(FILTER_PARAMS.status, STATUS_FILTERS),
    stock: known(FILTER_PARAMS.stock, STOCK_FILTERS),
    tracked: params.get(FILTER_PARAMS.tracked) === "1",
  };
}

export function hasActiveFilters(filters: DashboardFilters): boolean {
  return toProductQuery(filters) !== null || hasRowFilters(filters);
}

// Filters the app applies to the rows, since Shopify's search can't see them
export function hasRowFilters(filters: DashboardFilters): boolean {
  return (
    filters.statuses.length > 0 || filters.stock.length > 0 || filters.tracked
  );
}

/** Rows matching every row filter; several choices in one filter mean any of them. */
export function filterRows(
  rows: DashboardRow[],
  filters: DashboardFilters,
): DashboardRow[] {
  const statuses = new Set<string>(
    filters.statuses.map((status) => STATUS_FILTERS[status]),
  );
  return rows.filter(
    (row) =>
      (statuses.size === 0 || statuses.has(row.status)) &&
      (filters.stock.length === 0 ||
        filters.stock.some((issue) => hasStockIssue(row, issue))) &&
      (!filters.tracked || isTracked(row)),
  );
}

function hasStockIssue(row: DashboardRow, issue: StockFilter): boolean {
  return issue === "over"
    ? row.overStock !== null
    : row.unbatchedStock !== null;
}

// Has batches, readable or not
function isTracked(row: DashboardRow): boolean {
  return row.status === UNREADABLE || row.batches.length > 0;
}

/**
 * Shopify search syntax for the filters, or null when there are none.
 * Typed text is escaped so it's searched as words, never as syntax.
 */
export function toProductQuery(filters: DashboardFilters): string | null {
  const parts: string[] = [];
  if (filters.search) parts.push(escapeSearchText(filters.search));
  if (filters.types.length > 0)
    parts.push(anyOf("product_type", filters.types));
  if (filters.vendors.length > 0) parts.push(anyOf("vendor", filters.vendors));
  return parts.length > 0 ? parts.join(" AND ") : null;
}

function anyOf(field: string, values: string[]): string {
  const terms = values.map((value) => `${field}:${quote(value)}`);
  return `(${terms.join(" OR ")})`;
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// Escapes the syntax characters, and lowercases connectives so "AND" is a word
function escapeSearchText(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => {
      const escaped = word.replace(/[\\:()"'*]/g, "\\$&").replace(/^-/, "\\-");
      return /^(AND|OR|NOT)$/.test(escaped) ? escaped.toLowerCase() : escaped;
    })
    .join(" ");
}

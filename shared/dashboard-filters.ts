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
  // Matches the badge, which only products with batches get
  unbatched: "Unbatched (has batches)",
} as const;

// URL values for the sort, in the order they're listed
export const SORTS = {
  title: "Product A–Z",
  "title-desc": "Product Z–A",
  stock: "Stock: low to high",
  "stock-desc": "Stock: high to low",
  type: "Type A–Z",
  vendor: "Vendor A–Z",
} as const;

export type StatusFilter = keyof typeof STATUS_FILTERS;
export type StockFilter = keyof typeof STOCK_FILTERS;
export type DashboardSort = keyof typeof SORTS;

export const DEFAULT_SORT: DashboardSort = "title";

export function isDashboardSort(value: string): value is DashboardSort {
  return isKnown(SORTS, value);
}

function isKnown<K extends string>(
  values: Record<K, string>,
  value: string,
): value is K {
  return Object.hasOwn(values, value);
}

// Search and filters the dashboard reads from its URL, e.g. ?q=milk&status=expired
export interface DashboardFilters {
  search: string;
  types: string[];
  vendors: string[];
  statuses: StatusFilter[];
  stock: StockFilter[];
  // Only products with batches
  tracked: boolean;
  // Not a filter: Clear filters keeps it
  sort: DashboardSort;
}

export const FILTER_PARAMS = {
  search: "q",
  type: "type",
  vendor: "vendor",
  status: "status",
  stock: "stock",
  tracked: "tracked",
};

export const SORT_PARAM = "sort";

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
    list(name).filter((value): value is K => isKnown(values, value));
  return {
    search: (params.get(FILTER_PARAMS.search) ?? "").trim(),
    types: list(FILTER_PARAMS.type),
    vendors: list(FILTER_PARAMS.vendor),
    statuses: known(FILTER_PARAMS.status, STATUS_FILTERS),
    stock: known(FILTER_PARAMS.stock, STOCK_FILTERS),
    tracked: params.get(FILTER_PARAMS.tracked) === "1",
    sort: known(SORT_PARAM, SORTS)[0] ?? DEFAULT_SORT,
  };
}

export interface ProductSort {
  sortKey: "TITLE" | "INVENTORY_TOTAL" | "PRODUCT_TYPE" | "VENDOR";
  reverse: boolean;
}

// Every sort needs an entry, so a new one can't reach Shopify without a key
const PRODUCT_SORTS = {
  title: { sortKey: "TITLE", reverse: false },
  "title-desc": { sortKey: "TITLE", reverse: true },
  stock: { sortKey: "INVENTORY_TOTAL", reverse: false },
  "stock-desc": { sortKey: "INVENTORY_TOTAL", reverse: true },
  type: { sortKey: "PRODUCT_TYPE", reverse: false },
  vendor: { sortKey: "VENDOR", reverse: false },
} as const satisfies Record<DashboardSort, ProductSort>;

/** The products query's sortKey and reverse for a sort. */
export function toProductSort(sort: DashboardSort): ProductSort {
  return PRODUCT_SORTS[sort];
}

/** Sets the sort in a dashboard URL; the default is left out. */
export function applySort(params: URLSearchParams, sort: DashboardSort): void {
  if (sort === DEFAULT_SORT) params.delete(SORT_PARAM);
  else params.set(SORT_PARAM, sort);
}

/** Removes the search and every filter, keeping the sort and the app's own params. */
export function clearFilters(params: URLSearchParams): void {
  for (const name of Object.values(FILTER_PARAMS)) params.delete(name);
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
      (!filters.tracked || row.tracked),
  );
}

function hasStockIssue(row: DashboardRow, issue: StockFilter): boolean {
  return issue === "over"
    ? row.overStock !== null
    : row.unbatchedStock !== null;
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

import { type DashboardRow, UNREADABLE } from "./dashboard";
import { addDays, isCalendarDate } from "./freshness";

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

// URL values for the expiry presets, in the order they're listed
export const EXPIRY_PRESETS = {
  expired: "Already expired",
  today: "Today",
  "7d": "Next 7 days",
  "30d": "Next 30 days",
} as const;

// URL values for the sort, in the order they're listed
export const SORTS = {
  title: "Product A–Z",
  "title-desc": "Product Z–A",
  stock: "Stock: low to high",
  "stock-desc": "Stock: high to low",
  type: "Type A–Z",
  "type-desc": "Type Z–A",
  vendor: "Vendor A–Z",
  "vendor-desc": "Vendor Z–A",
  expiry: "Earliest expiry: soonest first",
} as const;

export type StatusFilter = keyof typeof STATUS_FILTERS;
export type StockFilter = keyof typeof STOCK_FILTERS;
export type DashboardSort = keyof typeof SORTS;
export type ExpiryPreset = keyof typeof EXPIRY_PRESETS;

// Inclusive "YYYY-MM-DD" bounds on the product's earliest in-stock expiry
export interface ExpiryRange {
  from: string | null;
  to: string | null;
}

export type ExpiryFilter = { preset: ExpiryPreset } | ExpiryRange;

export const DEFAULT_SORT: DashboardSort = "title";

// A preset wins over a custom range; invalid dates are ignored
function parseExpiry(params: URLSearchParams): ExpiryFilter | null {
  const preset = params.get(FILTER_PARAMS.expiry)?.trim() ?? "";
  if (isExpiryPreset(preset)) return { preset };
  const date = (name: string) => {
    const value = params.get(name)?.trim() ?? "";
    return isCalendarDate(value) ? value : null;
  };
  const from = date(FILTER_PARAMS.expiryFrom);
  const to = date(FILTER_PARAMS.expiryTo);
  if (!from && !to) return null;
  // A backwards range is taken to mean the same days
  return from && to && from > to ? { from: to, to: from } : { from, to };
}

/** Sets the expiry filter in a dashboard URL, or removes it for null. */
export function applyExpiry(
  params: URLSearchParams,
  expiry: ExpiryFilter | null,
): void {
  params.delete(FILTER_PARAMS.expiry);
  params.delete(FILTER_PARAMS.expiryFrom);
  params.delete(FILTER_PARAMS.expiryTo);
  if (!expiry) return;
  if ("preset" in expiry) {
    params.set(FILTER_PARAMS.expiry, expiry.preset);
    return;
  }
  if (expiry.from) params.set(FILTER_PARAMS.expiryFrom, expiry.from);
  if (expiry.to) params.set(FILTER_PARAMS.expiryTo, expiry.to);
}

/** The range a preset covers, counted from the shop's today. */
export function presetRange(preset: ExpiryPreset, today: string): ExpiryRange {
  switch (preset) {
    case "expired":
      return { from: null, to: addDays(today, -1) };
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: today, to: addDays(today, 7) };
    case "30d":
      return { from: today, to: addDays(today, 30) };
  }
}

/** The URL's page: a whole number from 1, anything else is page 1. */
export function parsePage(params: URLSearchParams): number {
  const page = Number(params.get(PAGE_PARAM)?.trim());
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** Sets the page in a dashboard URL; page 1 is left out. */
export function applyPage(params: URLSearchParams, page: number): void {
  if (page <= 1) params.delete(PAGE_PARAM);
  else params.set(PAGE_PARAM, String(page));
}

export interface PageStepView {
  // The page on screen, which the loader keeps in range
  shown: number;
  pageCount: number;
  current: URLSearchParams;
  // The newest URL, which may still be loading
  pending: URLSearchParams;
}

/** Where Prev/Next goes, or null while a different list is still loading. */
export function pageAfterStep(
  view: PageStepView,
  delta: number,
): number | null {
  const { shown, pageCount, current, pending } = view;
  let from = shown;
  if (!sameParams(pending, current)) {
    // A filter or sort still loading is a list the user hasn't seen
    if (!sameParams(withoutPage(pending), withoutPage(current))) return null;
    from = parsePage(pending);
  }
  return Math.min(Math.max(1, from + delta), pageCount);
}

function withoutPage(params: URLSearchParams): URLSearchParams {
  const copy = new URLSearchParams(params);
  copy.delete(PAGE_PARAM);
  return copy;
}

/** True when two URLs hold the same params, whatever their order. */
export function sameParams(a: URLSearchParams, b: URLSearchParams): boolean {
  const sorted = (params: URLSearchParams) => {
    const copy = new URLSearchParams(params);
    copy.sort();
    return copy.toString();
  };
  return sorted(a) === sorted(b);
}

/** The URL's sort, or the default when it's missing or unknown. */
export function parseSort(params: URLSearchParams): DashboardSort {
  return (
    params
      .getAll(SORT_PARAM)
      .map((value) => value.trim())
      .find(isDashboardSort) ?? DEFAULT_SORT
  );
}

export function isExpiryPreset(value: string): value is ExpiryPreset {
  return isKnown(EXPIRY_PRESETS, value);
}

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
  expiry: ExpiryFilter | null;
  // Not a filter: Clear filters keeps it
  sort: DashboardSort;
  // 1-based; any change to the search, filters or sort goes back to 1
  page: number;
}

export const FILTER_PARAMS = {
  search: "q",
  type: "type",
  vendor: "vendor",
  status: "status",
  stock: "stock",
  tracked: "tracked",
  expiry: "expiry",
  expiryFrom: "expiry_from",
  expiryTo: "expiry_to",
};

export const SORT_PARAM = "sort";
export const PAGE_PARAM = "page";

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
    expiry: parseExpiry(params),
    sort: parseSort(params),
    page: parsePage(params),
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
  "type-desc": { sortKey: "PRODUCT_TYPE", reverse: true },
  vendor: { sortKey: "VENDOR", reverse: false },
  "vendor-desc": { sortKey: "VENDOR", reverse: true },
  // Shopify can't sort by a metafield, so these are fetched by title and sorted here
  expiry: { sortKey: "TITLE", reverse: false },
} as const satisfies Record<DashboardSort, ProductSort>;

/** The products query's sortKey and reverse for a sort. */
export function toProductSort(sort: DashboardSort): ProductSort {
  return PRODUCT_SORTS[sort];
}

/** True for sorts the app applies to the products it loaded. */
export function isAppSort(sort: DashboardSort): boolean {
  return sort === "expiry";
}

/** Soonest earliest expiry first; products with no date keep their order at the end. */
export function sortByExpiry<
  T extends Pick<DashboardRow, "earliestExpirationDate">,
>(items: T[]): T[] {
  // Array sort is stable, so equal dates keep the order Shopify returned
  return [...items].sort((a, b) => {
    const dateA = a.earliestExpirationDate;
    const dateB = b.earliestExpirationDate;
    if (dateA === dateB) return 0;
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA < dateB ? -1 : 1;
  });
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
  return (
    filters.search !== "" ||
    filters.types.length > 0 ||
    filters.vendors.length > 0 ||
    filters.expiry !== null ||
    hasRowFilters(filters)
  );
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

// The app's own metafield, which the definition marks admin-filterable
const EARLIEST_EXPIRY_FIELD = "metafields.$app.earliest_expiration_date";
// Before every real expiry, so ">=" this means "has an expiry date"
const ANY_EXPIRY = "1900-01-01";

/**
 * Shopify search syntax for the filters, or null when there are none.
 * Typed text is escaped so it's searched as words, never as syntax.
 *
 * @param expiry - the expiry filter as dates; a preset is resolved first
 */
export function toProductQuery(
  filters: DashboardFilters,
  expiry: ExpiryRange | null = null,
): string | null {
  const parts: string[] = [];
  if (filters.search) parts.push(escapeSearchText(filters.search));
  if (filters.types.length > 0)
    parts.push(anyOf("product_type", filters.types));
  if (filters.vendors.length > 0) parts.push(anyOf("vendor", filters.vendors));
  if (expiry?.from) parts.push(`${EARLIEST_EXPIRY_FIELD}:>=${expiry.from}`);
  if (expiry?.to) parts.push(`${EARLIEST_EXPIRY_FIELD}:<=${expiry.to}`);
  // The expiry sort lists only dated products, so its 1,000 aren't spent on others
  if (isAppSort(filters.sort) && !expiry?.from && !expiry?.to) {
    parts.push(`${EARLIEST_EXPIRY_FIELD}:>=${ANY_EXPIRY}`);
  }
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

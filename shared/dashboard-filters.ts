// Search and filters the dashboard reads from its URL, e.g. ?q=milk&type=Dairy
export interface DashboardFilters {
  search: string;
  types: string[];
  vendors: string[];
}

export const FILTER_PARAMS = { search: "q", type: "type", vendor: "vendor" };

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
  return {
    search: (params.get(FILTER_PARAMS.search) ?? "").trim(),
    types: list(FILTER_PARAMS.type),
    vendors: list(FILTER_PARAMS.vendor),
  };
}

export function hasActiveFilters(filters: DashboardFilters): boolean {
  return (
    filters.search !== "" ||
    filters.types.length > 0 ||
    filters.vendors.length > 0
  );
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

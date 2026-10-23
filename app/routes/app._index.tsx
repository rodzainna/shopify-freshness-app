import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useState } from "react";
import { useLoaderData, useLocation, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { BATCH_EDITOR_ID, BatchEditor, type EditTarget } from "../batch-editor";
import { StockBadges } from "../stock-badges";
import { Pager } from "../pager";
import { DashboardFilterBar, useDashboardFilters } from "../dashboard-filters";
import { authenticate } from "../shopify.server";
import { readShopToday } from "../fulfillment-shopify.server";
import {
  type DashboardProductNode,
  type DashboardRow,
  ADMIN_PRODUCTS,
  UNREADABLE,
  toDashboardRows,
} from "../../shared/dashboard";
import {
  FRESHNESS_TONE,
  formatDaysRemaining,
  getShopToday,
  isInStock,
} from "../../shared/freshness";
import {
  filterRows,
  hasActiveFilters,
  hasRowFilters,
  isAppSort,
  presetRange,
  sortRowsByExpiry,
  type DashboardFilters,
  type ExpiryRange,
  type ProductSort,
  parseDashboardFilters,
  toProductQuery,
  toProductSort,
} from "../../shared/dashboard-filters";
import { MAX_BATCHES } from "../../shared/product-metafields";
import {
  clampPage,
  findPageStart,
  pageCount,
  pageSlice,
} from "../../shared/pagination";

// Rows per page. Batches load up to the panel's limit, so totals are complete
// unless a product has more; at 250 a page requests 269 of 1,000 points.
const PRODUCT_LIMIT = 50;

// Status, stock and tracked filters look through up to this many pages for
// matches: about 1,076 of the 2,000 points Shopify's bucket holds
const ROW_FILTER_PAGES = 4;

// Cursor-only queries reach a later page this many products at a time
const CURSOR_PAGE = 250;

interface DashboardData {
  shop: { ianaTimezone: string };
  // Only when asked for with $withCount
  productsCount?: { count: number };
  products: {
    nodes: DashboardProductNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface CursorData {
  productsCount?: { count: number };
  products: {
    edges: { cursor: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

type ProductView = { query: string | null } & ProductSort;

interface DashboardPage {
  rows: DashboardRow[];
  page: number;
  totalPages: number;
  // Only for views the app filters or sorts, which check a limited number
  checkedProducts: number | null;
  uncheckedProducts: boolean;
  today: string;
}

type AdminGraphql = Awaited<
  ReturnType<typeof authenticate.admin>
>["admin"]["graphql"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const filters = parseDashboardFilters(new URL(request.url).searchParams);
  // One instant, so a preset and the rows' statuses share the same date
  const now = new Date();
  const { expiry, presetToday } = await resolveExpiry(admin, filters, now);
  const query = toProductQuery(filters, expiry);
  const view = { query, ...toProductSort(filters.sort) };
  const page =
    hasRowFilters(filters) || isAppSort(filters.sort)
      ? await loadCheckedPage(admin.graphql, view, filters, presetToday, now)
      : await loadShopifyPage(
          admin.graphql,
          view,
          filters.page,
          presetToday,
          now,
        );
  return { ...page, filters };
};

// Shopify pages the list: find where the page starts, then load just that page
async function loadShopifyPage(
  graphql: AdminGraphql,
  view: ProductView,
  requestedPage: number,
  presetToday: string | null,
  now: Date,
): Promise<DashboardPage> {
  const start =
    requestedPage > 1
      ? await findPageStart(
          async (after, first, withCount) => {
            const data = await fetchCursors(graphql, {
              ...view,
              after,
              first,
              withCount,
            });
            return {
              count: data.productsCount?.count ?? null,
              cursors: data.products.edges.map(({ cursor }) => cursor),
              ...data.products.pageInfo,
            };
          },
          requestedPage,
          PRODUCT_LIMIT,
          CURSOR_PAGE,
        )
      : { page: 1, after: null, count: null };
  // Page 1 counts here; a later page already counted while finding its start
  const data = await fetchProductPage(graphql, {
    ...view,
    after: start.after,
    withCount: start.count === null,
  });
  const today = presetToday ?? getShopToday(data.shop.ianaTimezone, now);
  const count = start.count ?? data.productsCount?.count ?? 0;
  return {
    rows: toDashboardRows(data.products.nodes, today),
    page: start.page,
    totalPages: pageCount(count, PRODUCT_LIMIT),
    checkedProducts: null,
    uncheckedProducts: false,
    today,
  };
}

// Filters or an expiry sort the app applies: check up to 200, then slice a page
async function loadCheckedPage(
  graphql: AdminGraphql,
  view: ProductView,
  filters: DashboardFilters,
  presetToday: string | null,
  now: Date,
): Promise<DashboardPage> {
  const rows: DashboardRow[] = [];
  let checkedProducts = 0;
  let uncheckedProducts = false;
  let after: string | null = null;
  let today = "";
  for (let page = 0; page < ROW_FILTER_PAGES; page += 1) {
    const data = await fetchProductPage(graphql, {
      ...view,
      after,
      withCount: false,
    });
    today = presetToday ?? getShopToday(data.shop.ianaTimezone, now);
    rows.push(
      ...filterRows(toDashboardRows(data.products.nodes, today), filters),
    );
    checkedProducts += data.products.nodes.length;
    uncheckedProducts = data.products.pageInfo.hasNextPage;
    after = data.products.pageInfo.endCursor;
    if (!uncheckedProducts) break;
  }

  const ordered = isAppSort(filters.sort) ? sortRowsByExpiry(rows) : rows;
  const totalPages = pageCount(ordered.length, PRODUCT_LIMIT);
  const page = clampPage(filters.page, totalPages);
  return {
    rows: pageSlice(ordered, page, PRODUCT_LIMIT),
    page,
    totalPages,
    checkedProducts,
    uncheckedProducts,
    today,
  };
}

// A preset like "Next 7 days" counts from the shop's own date
async function resolveExpiry(
  admin: Parameters<typeof readShopToday>[0],
  filters: DashboardFilters,
  now: Date,
): Promise<{ expiry: ExpiryRange | null; presetToday: string | null }> {
  if (!filters.expiry) return { expiry: null, presetToday: null };
  if (!("preset" in filters.expiry)) {
    return { expiry: filters.expiry, presetToday: null };
  }
  const today = await readShopToday(admin, now);
  return {
    expiry: presetRange(filters.expiry.preset, today),
    presetToday: today,
  };
}

async function fetchCursors(
  graphql: AdminGraphql,
  variables: ProductView & {
    after: string | null;
    first: number;
    withCount: boolean;
  },
): Promise<CursorData> {
  const response = await graphql(
    `
      #graphql
      query DashboardCursors(
        $first: Int!
        $query: String
        $after: String
        $sortKey: ProductSortKeys!
        $reverse: Boolean!
        $withCount: Boolean!
      ) {
        productsCount(query: $query, limit: null) @include(if: $withCount) {
          count
        }
        products(
          first: $first
          after: $after
          sortKey: $sortKey
          reverse: $reverse
          query: $query
        ) {
          edges {
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    { variables },
  );
  const { data } = (await response.json()) as { data: CursorData };
  return data;
}

async function fetchProductPage(
  graphql: AdminGraphql,
  variables: ProductView & { after: string | null; withCount: boolean },
): Promise<DashboardData> {
  const response = await graphql(
    `
      #graphql
      query FreshnessDashboard(
        $productLimit: Int!
        $batchLimit: Int!
        $query: String
        $after: String
        $sortKey: ProductSortKeys!
        $reverse: Boolean!
        $withCount: Boolean!
      ) {
        shop {
          ianaTimezone
        }
        productsCount(query: $query, limit: null) @include(if: $withCount) {
          count
        }
        products(
          first: $productLimit
          after: $after
          sortKey: $sortKey
          reverse: $reverse
          query: $query
        ) {
          nodes {
            id
            legacyResourceId
            title
            tracksInventory
            totalInventory
            featuredMedia {
              preview {
                image {
                  url(transform: { maxWidth: 80, maxHeight: 80 })
                  altText
                }
              }
            }
            earliestExpiration: metafield(key: "earliest_expiration_date") {
              value
            }
            freshnessBatches: metafield(key: "freshness_batches") {
              references(first: $batchLimit) {
                nodes {
                  ... on Metaobject {
                    id
                    quantity: field(key: "quantity") {
                      value
                    }
                    expirationDate: field(key: "expiration_date") {
                      value
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    {
      variables: {
        productLimit: PRODUCT_LIMIT,
        batchLimit: MAX_BATCHES,
        ...variables,
      },
    },
  );
  // admin.graphql throws on any GraphQL error, so data is complete here
  const { data } = (await response.json()) as { data: DashboardData };
  return data;
}

export default function Dashboard() {
  const {
    rows,
    page,
    totalPages,
    uncheckedProducts,
    checkedProducts,
    filters,
    today,
  } = useLoaderData<typeof loader>();
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const controls = useDashboardFilters(filters);
  const location = useLocation();
  const navigation = useNavigation();
  // Only this page's own reloads, not leaving it for another route
  const loading =
    navigation.state === "loading" &&
    navigation.location.pathname === location.pathname;
  const filtered = hasActiveFilters(filters);

  if (rows.length === 0 && !filtered && !isAppSort(filters.sort)) {
    return (
      <s-page heading="Freshness overview">
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-heading>No products yet</s-heading>
            <s-paragraph>
              Add a product, then track its batches from the Freshness batches
              block on the product page.
            </s-paragraph>
            <s-button variant="primary" href={`${ADMIN_PRODUCTS}/new`}>
              Add product
            </s-button>
          </s-stack>
        </s-section>
        <PrivacyLink />
      </s-page>
    );
  }

  return (
    <s-page heading="Freshness overview" inlineSize="large">
      <s-section padding="none">
        <s-table loading={loading || undefined}>
          <DashboardFilterBar filters={filters} controls={controls} />
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Earliest expiry</s-table-header>
            <s-table-header>Stock</s-table-header>
            <s-table-header>In batches</s-table-header>
            <s-table-header>Stock check</s-table-header>
            <s-table-header>Batches</s-table-header>
            <s-table-header>
              <s-text accessibilityVisibility="exclusive">Actions</s-text>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-thumbnail
                      src={row.imageUrl ?? undefined}
                      alt=""
                      size="small"
                    />
                    <s-link href={row.adminUrl}>{row.title}</s-link>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
                </s-table-cell>
                <s-table-cell>{row.earliestExpirationDate ?? "—"}</s-table-cell>
                <s-table-cell>
                  {row.stock ?? <s-text color="subdued">Not tracked</s-text>}
                </s-table-cell>
                <s-table-cell>
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    <s-text>{formatBatchTotal(row)}</s-text>
                    {row.uncountedBatches > 0 && (
                      <s-text color="subdued">
                        ({row.uncountedBatches} not counted)
                      </s-text>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <StockBadges
                    overStock={row.overStock}
                    unbatchedStock={row.unbatchedStock}
                    partial={row.hasMoreBatches}
                  />
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-200">
                    {row.status === UNREADABLE && (
                      <s-text color="subdued">
                        {"Batch details couldn't be loaded"}
                      </s-text>
                    )}
                    {row.batches.map((batch) => (
                      <s-stack
                        key={batch.id}
                        direction="inline"
                        gap="small-200"
                        alignItems="center"
                      >
                        <s-text>
                          {batch.quantity} × {batch.expirationDate || "no date"}
                        </s-text>
                        {!isInStock(batch) ? (
                          <s-badge>Sold out</s-badge>
                        ) : (
                          batch.freshness && (
                            <s-badge
                              tone={FRESHNESS_TONE[batch.freshness.status]}
                            >
                              {formatDaysRemaining(
                                batch.freshness.daysRemaining,
                              )}
                            </s-badge>
                          )
                        )}
                      </s-stack>
                    ))}
                    {row.hiddenBatches > 0 && (
                      <s-text color="subdued">
                        {formatHiddenBatches(row)}
                      </s-text>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {row.status !== UNREADABLE && (
                    <s-button
                      variant="tertiary"
                      commandFor={BATCH_EDITOR_ID}
                      command="--show"
                      accessibilityLabel={`${row.tracked ? "Edit" : "Add"} batches for ${row.title}`}
                      onClick={() =>
                        setEditing({
                          productId: row.id,
                          title: row.title,
                          hasBatches: row.tracked,
                          openedAt: Date.now(),
                        })
                      }
                    >
                      {row.tracked ? "Edit batches" : "Add batches"}
                    </s-button>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="base">
            {filtered ? (
              <s-stack gap="small-200" alignItems="center">
                <s-text>No products match.</s-text>
                <s-button variant="tertiary" onClick={controls.clearAll}>
                  Clear filters
                </s-button>
              </s-stack>
            ) : (
              <s-stack alignItems="center">
                <s-text>No products have an expiry date yet.</s-text>
              </s-stack>
            )}
          </s-box>
        )}
        <Pager page={page} pageCount={totalPages} onPage={controls.setPage} />
      </s-section>
      {isAppSort(filters.sort) && rows.length > 0 && (
        <s-paragraph color="subdued">
          Products without an expiry date aren&apos;t listed in this sort.
        </s-paragraph>
      )}
      {uncheckedProducts && checkedProducts !== null && (
        <s-paragraph color="subdued">
          {limitNote(checkedProducts, filters)}
        </s-paragraph>
      )}
      <BatchEditor target={editing} today={today} />
      <PrivacyLink />
    </s-page>
  );
}

// Views the app filters or sorts only check so many products
function limitNote(checked: number, filters: DashboardFilters) {
  if (isAppSort(filters.sort)) {
    return `Sorted the first ${checked} products with an expiry date. Filter by expiry or search to narrow it down.`;
  }
  return `Status, stock and tracked filters checked the first ${checked} products. Search or filter by type or vendor to narrow it down.`;
}

// Units, e.g. "4120+" when some batches didn't load and the total is a lower bound
function formatBatchTotal({ batchTotal, hasMoreBatches }: DashboardRow) {
  if (batchTotal === null) return "—";
  return hasMoreBatches ? `${batchTotal}+` : String(batchTotal);
}

// "1 more batch", or "240+ more batches" when some didn't load
function formatHiddenBatches({ hiddenBatches, hasMoreBatches }: DashboardRow) {
  if (hasMoreBatches) return `${hiddenBatches}+ more batches`;
  return `${hiddenBatches} more ${hiddenBatches === 1 ? "batch" : "batches"}`;
}

function statusTone(status: DashboardRow["status"]) {
  if (status === "Not set") return undefined;
  if (status === UNREADABLE) return "warning";
  return FRESHNESS_TONE[status];
}

function PrivacyLink() {
  return (
    <s-paragraph color="subdued">
      <s-link href="/app/privacy">Privacy and data terms</s-link>
    </s-paragraph>
  );
}

// After a batch editor save, reload only if the batches are now different
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formAction,
  actionResult,
  defaultShouldRevalidate,
}) => {
  if (formAction === "/app/batches") {
    return actionResult?.kind === "saved" || actionResult?.kind === "changed";
  }
  return defaultShouldRevalidate;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

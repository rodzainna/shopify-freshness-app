import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { DashboardFilterBar } from "../dashboard-filters";
import { authenticate } from "../shopify.server";
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
  FILTER_PARAMS,
  hasActiveFilters,
  parseDashboardFilters,
  toProductQuery,
} from "../../shared/dashboard-filters";
import { MAX_BATCHES } from "../../shared/product-metafields";

// One page only in v1. Batches load up to the panel's limit, so totals are
// complete unless a product has more; at 250 the query requests 269 of 1,000 points.
const PRODUCT_LIMIT = 50;

// Choices for the Type and Vendor filters, from the whole store
const OPTION_LIMIT = 250;

interface DashboardData {
  shop: { ianaTimezone: string };
  productTypes: { nodes: string[] };
  productVendors: { nodes: string[] };
  products: {
    nodes: DashboardProductNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const filters = parseDashboardFilters(new URL(request.url).searchParams);

  const response = await admin.graphql(
    `#graphql
      query FreshnessDashboard(
        $productLimit: Int!
        $batchLimit: Int!
        $optionLimit: Int!
        $query: String
      ) {
        shop {
          ianaTimezone
        }
        productTypes(first: $optionLimit) {
          nodes
        }
        productVendors(first: $optionLimit) {
          nodes
        }
        products(first: $productLimit, sortKey: TITLE, query: $query) {
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
          }
        }
      }`,
    {
      variables: {
        productLimit: PRODUCT_LIMIT,
        batchLimit: MAX_BATCHES,
        optionLimit: OPTION_LIMIT,
        query: toProductQuery(filters),
      },
    },
  );
  // admin.graphql throws on any GraphQL error, so data is complete here
  const { data } = (await response.json()) as { data: DashboardData };

  const today = getShopToday(data.shop.ianaTimezone, new Date());

  return {
    rows: toDashboardRows(data.products.nodes, today),
    hasMoreProducts: data.products.pageInfo.hasNextPage,
    filters,
    types: data.productTypes.nodes,
    vendors: data.productVendors.nodes,
  };
};

export default function Dashboard() {
  const { rows, hasMoreProducts, filters, types, vendors } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const loading = useNavigation().state === "loading";
  const filtered = hasActiveFilters(filters);

  function clearFilters() {
    setSearchParams((params) => {
      for (const name of Object.values(FILTER_PARAMS)) params.delete(name);
      return params;
    });
  }

  if (rows.length === 0 && !filtered) {
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
          <DashboardFilterBar
            filters={filters}
            types={types}
            vendors={vendors}
          />
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Earliest expiry</s-table-header>
            <s-table-header>Stock</s-table-header>
            <s-table-header>In batches</s-table-header>
            <s-table-header>Batches</s-table-header>
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
                    {row.overStock !== null && (
                      <s-badge tone="warning">
                        {row.overStock}
                        {row.hasMoreBatches && "+"} over
                      </s-badge>
                    )}
                    {row.unbatchedStock !== null && (
                      <s-badge tone="info">
                        {row.unbatchedStock} unbatched
                      </s-badge>
                    )}
                  </s-stack>
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
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="base">
            <s-stack gap="small-200" alignItems="center">
              <s-text>No products match.</s-text>
              <s-button variant="tertiary" onClick={clearFilters}>
                Clear filters
              </s-button>
            </s-stack>
          </s-box>
        )}
      </s-section>
      {hasMoreProducts && (
        <s-paragraph color="subdued">
          Showing the first {PRODUCT_LIMIT} products by title.
        </s-paragraph>
      )}
      <PrivacyLink />
    </s-page>
  );
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

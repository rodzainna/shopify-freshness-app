import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  type DashboardProductNode,
  toDashboardRows,
} from "../../shared/dashboard";
import {
  FRESHNESS_TONE,
  formatDaysRemaining,
  getShopToday,
} from "../../shared/freshness";

// One page only in v1; batch counts per product are small
const PRODUCT_LIMIT = 50;
const BATCH_LIMIT = 10;

interface DashboardData {
  shop: { ianaTimezone: string };
  products: {
    nodes: DashboardProductNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query FreshnessDashboard($productLimit: Int!, $batchLimit: Int!) {
        shop {
          ianaTimezone
        }
        products(first: $productLimit, sortKey: TITLE) {
          nodes {
            id
            title
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
    { variables: { productLimit: PRODUCT_LIMIT, batchLimit: BATCH_LIMIT } },
  );
  // admin.graphql throws on any GraphQL error, so data is complete here
  const { data } = (await response.json()) as { data: DashboardData };

  const today = getShopToday(data.shop.ianaTimezone, new Date());

  return {
    rows: toDashboardRows(data.products.nodes, today),
    hasMoreProducts: data.products.pageInfo.hasNextPage,
  };
};

export default function Dashboard() {
  const { rows, hasMoreProducts } = useLoaderData<typeof loader>();

  if (rows.length === 0) {
    return (
      <s-page heading="Freshness overview">
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-heading>No products yet</s-heading>
            <s-paragraph>
              Add a product, then track its batches from the Freshness batches
              block on the product page.
            </s-paragraph>
            <s-button variant="primary" href="shopify://admin/products/new">
              Add product
            </s-button>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Freshness overview">
      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Earliest expiry</s-table-header>
            <s-table-header>Batches</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.id}>
                <s-table-cell>{row.title}</s-table-cell>
                <s-table-cell>
                  <s-badge
                    tone={
                      row.status === "Not set"
                        ? undefined
                        : FRESHNESS_TONE[row.status]
                    }
                  >
                    {row.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>{row.earliestExpirationDate ?? "—"}</s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-200">
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
                        {batch.quantity <= 0 ? (
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
                    {row.hasMoreBatches && (
                      <s-text color="subdued">
                        Showing the first {BATCH_LIMIT} batches
                      </s-text>
                    )}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {hasMoreProducts && (
        <s-paragraph color="subdued">
          Showing the first {PRODUCT_LIMIT} products by title.
        </s-paragraph>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

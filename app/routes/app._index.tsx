import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useState } from "react";
import {
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { BATCH_EDITOR_ID, BatchEditor, type EditTarget } from "../batch-editor";
import { StockBadges } from "../stock-badges";
import { isShopifySignIn, shopifyResponse } from "../shopify-response";
import { Pager } from "../pager";
import { DashboardFilterBar, useDashboardFilters } from "../dashboard-filters";
import { authenticate } from "../shopify.server";
import { loadDashboardPage } from "../dashboard.server";
import {
  type DashboardRow,
  ADMIN_PRODUCTS,
  UNREADABLE,
} from "../../shared/dashboard";
import {
  FRESHNESS_TONE,
  formatDaysRemaining,
  isInStock,
} from "../../shared/freshness";
import {
  hasActiveFilters,
  hasRowFilters,
  isAppSort,
  type DashboardFilters,
  DEFAULT_SORT,
  parseDashboardFilters,
} from "../../shared/dashboard-filters";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const filters = parseDashboardFilters(new URL(request.url).searchParams);
  const page = await loadDashboardPage(admin, filters);
  return { ...page, filters };
};

export default function Dashboard() {
  const { rows, page, totalPages, checked, filters, today } =
    useLoaderData<typeof loader>();
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

  // Above and below the table, so either end of a long page can change it
  const pager = (
    <Pager
      page={page}
      pageCount={totalPages}
      onPage={controls.setPage}
      onStep={(delta) => controls.stepPage(page, totalPages, delta)}
    />
  );

  return (
    <s-page heading="Freshness overview" inlineSize="large">
      <s-section padding="none">
        <s-table loading={loading || undefined}>
          <DashboardFilterBar
            filters={filters}
            controls={controls}
            pager={pager}
          />
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
        {/* The table draws no line under its last row */}
        {rows.length > 0 && <s-divider />}
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
        {totalPages > 1 && <s-box padding="small-200 base">{pager}</s-box>}
      </s-section>
      {isAppSort(filters.sort) && rows.length > 0 && (
        <s-paragraph color="subdued">
          Products without an expiry date aren&apos;t listed in this sort.
        </s-paragraph>
      )}
      {checked?.more && (
        <s-paragraph color="subdued">
          {limitNote(checked.products, filters)}
        </s-paragraph>
      )}
      <BatchEditor target={editing} today={today} />
      <PrivacyLink />
    </s-page>
  );
}

// Views the app filters or sorts only check so many products
function limitNote(checked: number, filters: DashboardFilters) {
  // These filters stop at 200 even with the expiry sort, which alone reads 1,000
  if (isAppSort(filters.sort) && !hasRowFilters(filters)) {
    return `Sorted the first ${checked.toLocaleString("en-US")} products with an expiry date (in title order). Filter by expiry or search to narrow it down.`;
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

// A failed load stays inside the app with a retry, instead of a blank page
export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const view = parseDashboardFilters(new URLSearchParams(useLocation().search));
  const filteredView =
    hasActiveFilters(view) || view.sort !== DEFAULT_SORT || view.page > 1;
  // Shopify's sign-in responses render as Shopify's do; its HTTP errors get the banner
  if (isRouteErrorResponse(error) && isShopifySignIn(error.status)) {
    return shopifyResponse(error);
  }

  return (
    <s-page heading="Freshness overview" inlineSize="large">
      <s-banner tone="critical" heading="Couldn't load the dashboard">
        <s-paragraph>
          Shopify may be unreachable, or this view couldn&apos;t load.
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          loading={revalidator.state === "loading" || undefined}
          onClick={() => revalidator.revalidate()}
        >
          Try again
        </s-button>
        {/* A way out when one filter, sort or page keeps failing */}
        {filteredView && (
          <s-button slot="secondary-actions" href="/app">
            Show all products
          </s-button>
        )}
      </s-banner>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

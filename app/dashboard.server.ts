import type {
  AdminApiContext,
  AdminGraphqlClient,
} from "@shopify/shopify-app-react-router/server";

import { readShopToday } from "./fulfillment-shopify.server";
import {
  type DashboardProductNode,
  type DashboardRow,
  earliestDateOf,
  toDashboardRows,
} from "../shared/dashboard";
import { getShopToday } from "../shared/freshness";
import {
  filterRows,
  hasRowFilters,
  isAppSort,
  presetRange,
  sortByExpiry,
  type DashboardFilters,
  type ExpiryRange,
  type ProductSort,
  toProductQuery,
  toProductSort,
} from "../shared/dashboard-filters";
import { MAX_BATCHES } from "../shared/product-metafields";
import {
  clampPage,
  findPageStart,
  pageCount,
  pageSlice,
} from "../shared/pagination";

// Rows per page. Batches load up to the panel's limit, so totals are complete
// unless a product has more; at 250 a page requests 269 of 1,000 points.
const PRODUCT_LIMIT = 50;

// Status, stock and tracked filters look through up to this many pages for
// matches: about 1,076 of the 2,000 points Shopify's bucket holds
const ROW_FILTER_PAGES = 4;

// Cursor-only queries reach a later page this many products at a time
const CURSOR_PAGE = 250;

// The expiry sort reads dates alone, 250 at a time: 1,000 for about 96 points
const DATE_PAGES = 4;

interface ProductList {
  // Only when asked for with $withCount
  productsCount?: { count: number };
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface DashboardData extends ProductList {
  shop: { ianaTimezone: string };
  products: ProductList["products"] & { nodes: DashboardProductNode[] };
}

interface CursorData extends ProductList {
  products: ProductList["products"] & { edges: { cursor: string }[] };
}

type ProductDate = Pick<DashboardProductNode, "id" | "earliestExpiration">;

interface DatesData extends ProductList {
  products: ProductList["products"] & { nodes: ProductDate[] };
}

interface RowsByIdData {
  shop: { ianaTimezone: string };
  // null for a product deleted since its id was read
  nodes: (DashboardProductNode | null)[];
}

type ProductView = { query: string | null } & ProductSort;

interface DashboardPage {
  rows: DashboardRow[];
  page: number;
  totalPages: number;
  // Views the app filters or sorts check a limited number of products
  checked: { products: number; more: boolean } | null;
  today: string;
}

// Loads the dashboard page the filters ask for, picking how it's fetched
export async function loadDashboardPage(
  admin: AdminApiContext,
  filters: DashboardFilters,
): Promise<DashboardPage> {
  // One instant, so a preset and the rows' statuses share the same date
  const now = new Date();
  const { expiry, presetToday } = await resolveExpiry(admin, filters, now);
  const query = toProductQuery(filters, expiry);
  const view = { query, ...toProductSort(filters.sort) };
  if (hasRowFilters(filters)) {
    return loadCheckedPage(admin.graphql, view, filters, presetToday, now);
  }
  if (isAppSort(filters.sort)) {
    return loadExpirySortedPage(
      admin.graphql,
      view,
      filters.page,
      presetToday,
      now,
    );
  }
  return loadShopifyPage(admin.graphql, view, filters.page, presetToday, now);
}

// Shopify pages the list: find where the page starts, then load just that page
async function loadShopifyPage(
  graphql: AdminGraphqlClient,
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
    checked: null,
    today,
  };
}

// The expiry sort: read dates cheaply, sort them, then load only this page's rows
async function loadExpirySortedPage(
  graphql: AdminGraphqlClient,
  view: ProductView,
  requestedPage: number,
  presetToday: string | null,
  now: Date,
): Promise<DashboardPage> {
  // The two row fields the sort needs
  const dated: Pick<DashboardRow, "id" | "earliestExpirationDate">[] = [];
  let uncheckedProducts = false;
  let after: string | null = null;
  for (let request = 0; request < DATE_PAGES; request += 1) {
    const data = await fetchProductDates(graphql, { ...view, after });
    dated.push(
      ...data.products.nodes.map((node) => ({
        id: node.id,
        earliestExpirationDate: earliestDateOf(node),
      })),
    );
    uncheckedProducts = data.products.pageInfo.hasNextPage;
    after = data.products.pageInfo.endCursor;
    if (!uncheckedProducts) break;
  }

  const ordered = sortByExpiry(dated);
  const totalPages = pageCount(ordered.length, PRODUCT_LIMIT);
  const page = clampPage(requestedPage, totalPages);
  const ids = pageSlice(ordered, page, PRODUCT_LIMIT).map(({ id }) => id);
  const data = await fetchProductsById(graphql, ids);
  const today = presetToday ?? getShopToday(data.shop.ianaTimezone, now);
  const products = data.nodes.filter((node) => node !== null);
  return {
    rows: toDashboardRows(products, today),
    page,
    totalPages,
    checked: { products: dated.length, more: uncheckedProducts },
    today,
  };
}

// Status, stock or tracked filters the app applies: check up to 200, then slice a page
async function loadCheckedPage(
  graphql: AdminGraphqlClient,
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

  // The expiry sort with these filters still needs every product's batches
  const ordered = isAppSort(filters.sort) ? sortByExpiry(rows) : rows;
  const totalPages = pageCount(ordered.length, PRODUCT_LIMIT);
  const page = clampPage(filters.page, totalPages);
  return {
    rows: pageSlice(ordered, page, PRODUCT_LIMIT),
    page,
    totalPages,
    checked: { products: checkedProducts, more: uncheckedProducts },
    today,
  };
}

// A preset like "Next 7 days" counts from the shop's own date
async function resolveExpiry(
  admin: AdminApiContext,
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

// The fields a dashboard row needs; $batchLimit caps the batches read
const PRODUCT_ROW_FIELDS = `#graphql
  fragment DashboardProductRow on Product {
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
`;

async function fetchCursors(
  graphql: AdminGraphqlClient,
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

async function fetchProductDates(
  graphql: AdminGraphqlClient,
  variables: ProductView & { after: string | null },
): Promise<DatesData> {
  const response = await graphql(
    `
      #graphql
      query DashboardExpiryDates(
        $first: Int!
        $query: String
        $after: String
        $sortKey: ProductSortKeys!
        $reverse: Boolean!
      ) {
        products(
          first: $first
          after: $after
          sortKey: $sortKey
          reverse: $reverse
          query: $query
        ) {
          nodes {
            id
            earliestExpiration: metafield(key: "earliest_expiration_date") {
              value
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
    { variables: { first: CURSOR_PAGE, ...variables } },
  );
  const { data } = (await response.json()) as { data: DatesData };
  return data;
}

async function fetchProductsById(
  graphql: AdminGraphqlClient,
  ids: string[],
): Promise<RowsByIdData> {
  const response = await graphql(
    `
      #graphql
      query DashboardRowsById($ids: [ID!]!, $batchLimit: Int!) {
        shop {
          ianaTimezone
        }
        nodes(ids: $ids) {
          ...DashboardProductRow
        }
      }
      ${PRODUCT_ROW_FIELDS}
    `,
    { variables: { ids, batchLimit: MAX_BATCHES } },
  );
  const { data } = (await response.json()) as { data: RowsByIdData };
  return data;
}

async function fetchProductPage(
  graphql: AdminGraphqlClient,
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
            ...DashboardProductRow
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      ${PRODUCT_ROW_FIELDS}
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

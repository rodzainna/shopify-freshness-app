import type { LoaderFunctionArgs } from "react-router";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { isShopifySignIn } from "../shopify-response";

// Shopify's maximum page size; a store with more types or vendors lists the first 250
const OPTION_LIMIT = 250;

export interface FilterOptions {
  types: string[];
  vendors: string[];
  // The Shopify request failed; the filter offers a retry instead
  failed: boolean;
}

// Types and vendors don't change with batch saves, so a save needn't reload them
export const shouldRevalidate = () => false;

// The dashboard's Type and Vendor choices, loaded when a filter first opens or retries
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<FilterOptions> => {
  try {
    const { admin } = await authenticate.admin(request);
    return await readFilterOptions(admin.graphql);
  } catch (error) {
    // Sign-in responses go on to App Bridge; Shopify's HTTP errors count as failures
    if (error instanceof Response && isShopifySignIn(error.status)) throw error;
    // A thrown error would replace the whole dashboard with its error page
    console.error("Filter options request failed", error);
    return { types: [], vendors: [], failed: true };
  }
};

async function readFilterOptions(
  graphql: AdminGraphqlClient,
): Promise<FilterOptions> {
  const response = await graphql(
    `
      #graphql
      query FilterOptions($optionLimit: Int!) {
        productTypes(first: $optionLimit) {
          nodes
        }
        productVendors(first: $optionLimit) {
          nodes
        }
      }
    `,
    { variables: { optionLimit: OPTION_LIMIT } },
  );
  const { data } = (await response.json()) as {
    data: {
      productTypes: { nodes: string[] };
      productVendors: { nodes: string[] };
    };
  };
  return {
    types: data.productTypes.nodes,
    vendors: data.productVendors.nodes,
    failed: false,
  };
}

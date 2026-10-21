import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

// Shopify's maximum page size; a store with more types or vendors lists the first 250
const OPTION_LIMIT = 250;

export interface FilterOptions {
  types: string[];
  vendors: string[];
}

// The dashboard's Type and Vendor choices, loaded once when a filter first opens
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<FilterOptions> => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query FilterOptions($optionLimit: Int!) {
        productTypes(first: $optionLimit) {
          nodes
        }
        productVendors(first: $optionLimit) {
          nodes
        }
      }`,
    { variables: { optionLimit: OPTION_LIMIT } },
  );
  const { data } = (await response.json()) as {
    data: {
      productTypes: { nodes: string[] };
      productVendors: { nodes: string[] };
    };
  };
  return { types: data.productTypes.nodes, vendors: data.productVendors.nodes };
};

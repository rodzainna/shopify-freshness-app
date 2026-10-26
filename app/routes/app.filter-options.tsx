import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

// Shopify's maximum page size; a store with more types or vendors lists the first 250
const OPTION_LIMIT = 250;

export interface FilterOptions {
  types: string[];
  vendors: string[];
  // Shopify couldn't be reached; the filter offers a retry instead
  failed: boolean;
}

// The dashboard's Type and Vendor choices, loaded once when a filter first opens
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<FilterOptions> => {
  const { admin } = await authenticate.admin(request);
  try {
    return await readFilterOptions(admin.graphql);
  } catch (error) {
    if (error instanceof Response) throw error;
    // A thrown error would replace the whole dashboard with its error page
    console.error("Filter options request failed", error);
    return { types: [], vendors: [], failed: true };
  }
};

async function readFilterOptions(
  graphql: Awaited<ReturnType<typeof authenticate.admin>>["admin"]["graphql"],
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

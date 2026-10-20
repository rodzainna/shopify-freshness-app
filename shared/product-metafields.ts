export interface MetafieldWrite {
  ownerId: string;
  key: string;
  value: string;
}

export interface MetafieldIdentifier {
  ownerId: string;
  namespace: string;
  key: string;
}

// Empty metafields are deleted, not set blank. metafieldsDelete needs the
// namespace even though metafieldsSet defaults it to $app.
export function planProductMetafieldWrites(
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
): { set: MetafieldWrite[]; delete: MetafieldIdentifier[] } {
  const set: MetafieldWrite[] = [];
  const toDelete: MetafieldIdentifier[] = [];

  if (batchIds.length > 0) {
    set.push({
      ownerId: productId,
      key: "freshness_batches",
      value: JSON.stringify(batchIds),
    });
  } else {
    toDelete.push({
      ownerId: productId,
      namespace: "$app",
      key: "freshness_batches",
    });
  }

  if (earliestExpirationDate) {
    set.push({
      ownerId: productId,
      key: "earliest_expiration_date",
      value: earliestExpirationDate,
    });
  } else {
    toDelete.push({
      ownerId: productId,
      namespace: "$app",
      key: "earliest_expiration_date",
    });
  }

  return { set, delete: toDelete };
}

// Shopify's largest page size; the app loads a product's batches in one request
export const MAX_BATCHES = 250;

// Shared by the panel and the fulfillment webhook, so both write identically.
export const SAVE_PRODUCT_FRESHNESS_MUTATION = `#graphql
  mutation SaveProductFreshness(
    $set: [MetafieldsSetInput!]!
    $delete: [MetafieldIdentifierInput!]!
    $hasSet: Boolean!
    $hasDelete: Boolean!
  ) {
    metafieldsSet(metafields: $set) @include(if: $hasSet) {
      userErrors {
        field
        message
      }
    }
    metafieldsDelete(metafields: $delete) @include(if: $hasDelete) {
      userErrors {
        field
        message
      }
    }
  }
`;

// `code` is only present when the operation selects it
export interface UserErrorsPayload {
  userErrors: {
    field: string[] | null;
    message: string;
    code?: string | null;
  }[];
}

export interface SaveProductFreshnessData {
  metafieldsSet?: UserErrorsPayload | null;
  metafieldsDelete?: UserErrorsPayload | null;
}

export function saveProductFreshnessVariables(
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
) {
  const writes = planProductMetafieldWrites(
    productId,
    batchIds,
    earliestExpirationDate,
  );
  return {
    set: writes.set,
    delete: writes.delete,
    hasSet: writes.set.length > 0,
    hasDelete: writes.delete.length > 0,
  };
}

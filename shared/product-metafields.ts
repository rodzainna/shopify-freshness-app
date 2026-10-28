export interface MetafieldWrite {
  ownerId: string;
  key: string;
  value: string;
  compareDigest?: string | null;
}

export interface MetafieldIdentifier {
  ownerId: string;
  namespace: string;
  key: string;
}

// A batch as the dashboard and fulfillment queries read it
export interface BatchNode {
  id?: string;
  quantity?: { value: string } | null;
  expirationDate?: { value: string } | null;
}

// Shopify returns null for a batch reference that no longer resolves.
// Writing back a list with one would unlink it, so callers stop instead.
export function isReadableBatch<T extends { id?: string }>(
  node: T | null,
): node is T & { id: string } {
  return Boolean(node?.id);
}

// Empty metafields are deleted, not set blank. metafieldsDelete needs the
// namespace even though metafieldsSet defaults it to $app.
export function planProductMetafieldWrites(
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
  // When given, the list write is refused if the list changed since read
  listDigest?: string | null,
): { set: MetafieldWrite[]; delete: MetafieldIdentifier[] } {
  const set: MetafieldWrite[] = [];
  const toDelete: MetafieldIdentifier[] = [];

  if (batchIds.length > 0) {
    set.push({
      ownerId: productId,
      key: "freshness_batches",
      value: JSON.stringify(batchIds),
      ...(listDigest !== undefined && { compareDigest: listDigest }),
    });
  } else {
    toDelete.push({
      ownerId: productId,
      namespace: "$app",
      key: "freshness_batches",
    });
  }

  const date = planEarliestDateWrite(productId, earliestExpirationDate);
  return { set: [...set, ...date.set], delete: [...toDelete, ...date.delete] };
}

// Just the earliest date, for saves that leave the batch list alone
export function planEarliestDateWrite(
  productId: string,
  earliestExpirationDate: string | null,
): { set: MetafieldWrite[]; delete: MetafieldIdentifier[] } {
  const key = "earliest_expiration_date";
  return earliestExpirationDate
    ? {
        set: [{ ownerId: productId, key, value: earliestExpirationDate }],
        delete: [],
      }
    : { set: [], delete: [{ ownerId: productId, namespace: "$app", key }] };
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
        code
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

// Creates a batch, or updates the one with its handle, so a retry can't duplicate it
export const UPSERT_BATCH_MUTATION = `#graphql
  mutation UpsertBatch($handle: String!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectUpsert(
      handle: { type: "$app:freshness_batch", handle: $handle }
      metaobject: { fields: $fields }
    ) {
      metaobject {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface UpsertBatchData {
  metaobjectUpsert:
    (UserErrorsPayload & { metaobject: { id: string } | null }) | null;
}

export function upsertBatchVariables({
  handle,
  quantity,
  expirationDate,
}: {
  handle: string;
  quantity: number;
  expirationDate: string;
}) {
  return {
    handle,
    // Metaobject field values are always sent as strings
    fields: [
      { key: "quantity", value: String(quantity) },
      { key: "expiration_date", value: expirationDate },
    ],
  };
}

// Updates an existing batch by id; unlike an upsert, it can't recreate a deleted one
export const SET_BATCH_FIELDS_MUTATION = `#graphql
  mutation SetBatchFields($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface SetBatchFieldsData {
  metaobjectUpdate: UserErrorsPayload | null;
}

export const DELETE_BATCH_MUTATION = `#graphql
  mutation DeleteBatch($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface DeleteBatchData {
  metaobjectDelete: (UserErrorsPayload & { deletedId: string | null }) | null;
}

// A batch that's already gone counts as deleted
export function deleteBatchErrors(
  payload: DeleteBatchData["metaobjectDelete"] | undefined,
): UserErrorsPayload["userErrors"] {
  return (payload?.userErrors ?? []).filter(
    (error) => error.code !== "RECORD_NOT_FOUND",
  );
}

// Writes only the batch list, failing with STALE_OBJECT if it changed since read
export const SAVE_BATCH_LIST_MUTATION = `#graphql
  mutation SaveBatchList(
    $productId: ID!
    $value: String!
    $compareDigest: String
  ) {
    metafieldsSet(
      metafields: [
        {
          ownerId: $productId
          key: "freshness_batches"
          value: $value
          compareDigest: $compareDigest
        }
      ]
    ) {
      metafields {
        compareDigest
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface SaveBatchListData {
  metafieldsSet:
    | (UserErrorsPayload & { metafields: { compareDigest: string }[] | null })
    | null;
}

export function saveBatchListVariables(
  productId: string,
  batchIds: string[],
  compareDigest: string | null,
) {
  // An explicit null, not undefined: a missing digest would skip the check
  return { productId, value: JSON.stringify(batchIds), compareDigest };
}

export interface SaveProductFreshnessData {
  metafieldsSet?: UserErrorsPayload | null;
  metafieldsDelete?: UserErrorsPayload | null;
}

export function saveProductFreshnessVariables(
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
  listDigest?: string | null,
) {
  return toMutationVariables(
    planProductMetafieldWrites(
      productId,
      batchIds,
      earliestExpirationDate,
      listDigest,
    ),
  );
}

export function saveEarliestDateVariables(
  productId: string,
  earliestExpirationDate: string | null,
) {
  return toMutationVariables(
    planEarliestDateWrite(productId, earliestExpirationDate),
  );
}

function toMutationVariables(writes: {
  set: MetafieldWrite[];
  delete: MetafieldIdentifier[];
}) {
  return {
    set: writes.set,
    delete: writes.delete,
    hasSet: writes.set.length > 0,
    hasDelete: writes.delete.length > 0,
  };
}

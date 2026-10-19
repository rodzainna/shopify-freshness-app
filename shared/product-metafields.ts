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

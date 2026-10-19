// Helpers for reading Promise.allSettled results back into the items that
// produced them. results[i] always belongs to items[i].

// Rows that saved take their Shopify ID; failed rows keep their local one.
export function applySavedIds<T extends { id: string }>(
  items: T[],
  results: PromiseSettledResult<string>[],
): { items: T[]; errors: unknown[] } {
  const errors: unknown[] = [];

  const updated = items.map((item, index) => {
    const result = results[index];
    if (result.status === "fulfilled") return { ...item, id: result.value };

    errors.push(result.reason);
    return item;
  });

  return { items: updated, errors };
}

export function failedItems<T>(
  items: T[],
  results: PromiseSettledResult<unknown>[],
): T[] {
  return items.filter((_, index) => results[index].status === "rejected");
}

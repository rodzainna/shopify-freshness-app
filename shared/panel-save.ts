import type { Batch } from "./freshness";

// A panel row: saved rows have a Shopify GID, new ones their UUID handle
export type PanelRow = Batch & { id: string; handle: string };

export type PanelSavePlan = {
  creates: PanelRow[];
  updates: PanelRow[];
  // A row was added or a saved one removed, so the list must be rewritten
  listChanged: boolean;
};

/**
 * Decides what a panel save writes. `saved` is what Shopify held when the
 * panel last loaded or saved; untouched rows aren't written, so a tab left
 * open can't reset a change made elsewhere meanwhile.
 */
export function planPanelSave(
  saved: PanelRow[],
  rows: PanelRow[],
): PanelSavePlan {
  const savedById = new Map(saved.map((row) => [row.id, row]));
  const rowIds = new Set(rows.map(({ id }) => id));

  const creates = rows.filter(({ id }) => !savedById.has(id));
  const updates = rows.filter((row) => {
    const before = savedById.get(row.id);
    return (
      before !== undefined &&
      (before.quantity !== row.quantity ||
        before.expirationDate !== row.expirationDate)
    );
  });
  const removed = saved.some(({ id }) => !rowIds.has(id));

  return {
    creates,
    updates,
    listChanged: creates.length > 0 || removed,
  };
}

/**
 * After a list write reported "changed": the new batches it's safe to delete.
 * One the list now holds was linked by an earlier attempt that did land, so
 * it stays. `linkedIds` is null when the list couldn't be re-read.
 */
export function unlinkedCreates(
  createdIds: string[],
  linkedIds: Set<string> | null,
): string[] {
  if (!linkedIds) return [];
  return createdIds.filter((id) => !linkedIds.has(id));
}

// After a list write failed some other way: whether it landed anyway
export function listLanded(
  writtenIds: string[],
  linkedIds: Set<string> | null,
): boolean {
  return (
    linkedIds !== null &&
    linkedIds.size === writtenIds.length &&
    writtenIds.every((id) => linkedIds.has(id))
  );
}

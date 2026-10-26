/** Pages needed for `total` items; an empty list still has page 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A page within 1..count, so an old or hand-edited URL still lands somewhere. */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, page), count);
}

/** How many items come before `page`. */
export function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/** The items on `page`. */
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const start = pageOffset(page, pageSize);
  return items.slice(start, start + pageSize);
}

export interface CursorBatch {
  // Total matching items; asked for on the first request only
  count: number | null;
  cursors: string[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** The cursor just before `requestedPage`; a page past the end becomes the last real page. */
export async function findPageStart(
  fetchCursors: (
    after: string | null,
    first: number,
    withCount: boolean,
  ) => Promise<CursorBatch>,
  requestedPage: number,
  pageSize: number,
  batchSize: number,
): Promise<{ page: number; after: string | null; count: number }> {
  const cursors: string[] = [];
  let page = requestedPage;
  let offset = pageOffset(page, pageSize);
  let count = 0;
  let after: string | null = null;
  let ended = false;
  while (cursors.length < offset) {
    const first = cursors.length === 0;
    const batch = await fetchCursors(
      after,
      Math.min(batchSize, offset - cursors.length),
      first,
    );
    if (first) {
      count = batch.count ?? 0;
      page = clampPage(requestedPage, pageCount(count, pageSize));
      offset = pageOffset(page, pageSize);
    }
    cursors.push(...batch.cursors);
    after = batch.endCursor;
    ended = !batch.hasNextPage;
    if (ended) break;
  }
  // Nothing after the offset means the page would be empty
  if (cursors.length < offset || (ended && cursors.length === offset)) {
    count = cursors.length;
    page = clampPage(page, pageCount(count, pageSize));
    offset = pageOffset(page, pageSize);
  }
  return { page, after: offset > 0 ? cursors[offset - 1] : null, count };
}

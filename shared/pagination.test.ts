import { describe, it, expect } from "vitest";

import {
  clampPage,
  findPageStart,
  pageCount,
  pageOffset,
  pageSlice,
} from "./pagination";

describe("pageCount", () => {
  it.each([
    [0, 1],
    [1, 1],
    [50, 1],
    [51, 2],
    [200, 4],
  ])("fits %i items into %i pages of 50", (total, pages) => {
    expect(pageCount(total, 50)).toBe(pages);
  });
});

describe("clampPage", () => {
  it.each([
    [0, 1],
    [3, 3],
    [9, 4],
  ])("keeps page %i within 1..4 as %i", (page, expected) => {
    expect(clampPage(page, 4)).toBe(expected);
  });
});

describe("pageOffset and pageSlice", () => {
  const items = Array.from({ length: 120 }, (_, index) => index);

  it("skips the pages before", () => {
    expect(pageOffset(1, 50)).toBe(0);
    expect(pageOffset(3, 50)).toBe(100);
  });

  it("returns a full page, then what's left", () => {
    expect(pageSlice(items, 2, 50)).toStrictEqual(items.slice(50, 100));
    expect(pageSlice(items, 3, 50)).toStrictEqual(items.slice(100));
  });
});

describe("findPageStart", () => {
  // A fake list whose cursors are "c1", "c2", …; `counted` can differ from
  // `total`, like a count taken before some items were deleted
  function list(total: number, counted = total) {
    const requests: {
      after: string | null;
      first: number;
      withCount: boolean;
    }[] = [];
    const fetchCursors = async (
      after: string | null,
      first: number,
      withCount: boolean,
    ) => {
      requests.push({ after, first, withCount });
      const start = after ? Number(after.slice(1)) : 0;
      const end = Math.min(start + first, total);
      const cursors = Array.from(
        { length: end - start },
        (_, index) => `c${start + index + 1}`,
      );
      return {
        count: withCount ? counted : null,
        cursors,
        hasNextPage: end < total,
        endCursor: cursors.at(-1) ?? null,
      };
    };
    return { fetchCursors, requests };
  }

  it("starts after the last item of the page before", async () => {
    const { fetchCursors, requests } = list(500);

    expect(await findPageStart(fetchCursors, 3, 50, 250)).toStrictEqual({
      page: 3,
      after: "c100",
      count: 500,
    });
    expect(requests).toStrictEqual([
      { after: null, first: 100, withCount: true },
    ]);
  });

  it("reads cursors in batches to reach a far page, counting once", async () => {
    const { fetchCursors, requests } = list(1000);

    expect(await findPageStart(fetchCursors, 12, 50, 250)).toStrictEqual({
      page: 12,
      after: "c550",
      count: 1000,
    });
    expect(requests).toStrictEqual([
      { after: null, first: 250, withCount: true },
      { after: "c250", first: 250, withCount: false },
      { after: "c500", first: 50, withCount: false },
    ]);
  });

  it("turns a page past the end into the last page", async () => {
    const { fetchCursors } = list(120);

    expect(await findPageStart(fetchCursors, 9, 50, 250)).toStrictEqual({
      page: 3,
      after: "c100",
      count: 120,
    });
  });

  it("falls back to the last real page when the cursors run out early", async () => {
    // Counted 320 (7 pages), but only 95 are left
    const { fetchCursors } = list(95, 320);

    expect(await findPageStart(fetchCursors, 5, 50, 250)).toStrictEqual({
      page: 2,
      after: "c50",
      count: 95,
    });
  });

  it("falls back when the list ends exactly where the page would start", async () => {
    // Counted 150 (3 pages), but only 100 are left
    const { fetchCursors } = list(100, 150);

    expect(await findPageStart(fetchCursors, 3, 50, 250)).toStrictEqual({
      page: 2,
      after: "c50",
      count: 100,
    });
  });

  it("goes to page 1 when there's nothing to skip", async () => {
    const { fetchCursors } = list(30);

    expect(await findPageStart(fetchCursors, 4, 50, 250)).toStrictEqual({
      page: 1,
      after: null,
      count: 30,
    });
  });
});

import { describe, it, expect } from "vitest";

import {
  type PanelRow,
  listLanded,
  planPanelSave,
  unlinkedCreates,
} from "./panel-save";

const row = (
  id: string,
  quantity: number,
  expirationDate: string,
  handle = `handle-${id}`,
): PanelRow => ({ id, handle, quantity, expirationDate });

const SOON = "gid://shopify/Metaobject/1";
const LATER = "gid://shopify/Metaobject/2";
const NEW = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";

const saved = [row(SOON, 6, "2026-10-23"), row(LATER, 12, "2026-10-28")];

describe("planPanelSave", () => {
  it("writes nothing for rows that weren't touched", () => {
    expect(planPanelSave(saved, saved)).toStrictEqual({
      creates: [],
      updates: [],
      listChanged: false,
    });
  });

  it("updates only the rows whose values changed", () => {
    const rows = [row(SOON, 6, "2026-10-23"), row(LATER, 10, "2026-10-28")];

    expect(planPanelSave(saved, rows)).toMatchObject({
      updates: [row(LATER, 10, "2026-10-28")],
      listChanged: false,
    });
  });

  it.each([
    ["quantity", row(SOON, 5, "2026-10-23")],
    ["expiry date", row(SOON, 6, "2026-10-24")],
  ])("counts a changed %s as an update", (_case, changed) => {
    expect(planPanelSave(saved, [changed, saved[1]]).updates).toStrictEqual([
      changed,
    ]);
  });

  it("creates new rows and rewrites the list", () => {
    const added = row(NEW, 3, "2026-10-20", NEW);

    expect(planPanelSave(saved, [...saved, added])).toStrictEqual({
      creates: [added],
      updates: [],
      listChanged: true,
    });
  });

  it("rewrites the list when a saved row is removed", () => {
    expect(planPanelSave(saved, [saved[1]])).toStrictEqual({
      creates: [],
      updates: [],
      listChanged: true,
    });
  });

  it("rewrites the list for a product with no batches yet", () => {
    const added = row(NEW, 3, "2026-10-20", NEW);

    expect(planPanelSave([], [added])).toMatchObject({
      creates: [added],
      listChanged: true,
    });
  });

  it("leaves the list alone when rows are only reordered", () => {
    expect(planPanelSave(saved, [...saved].reverse()).listChanged).toBe(false);
  });
});

describe("unlinkedCreates", () => {
  const created = ["gid://shopify/Metaobject/7", "gid://shopify/Metaobject/8"];

  it("deletes only new batches the list doesn't hold", () => {
    const linked = new Set([SOON, "gid://shopify/Metaobject/7"]);

    expect(unlinkedCreates(created, linked)).toStrictEqual([
      "gid://shopify/Metaobject/8",
    ]);
  });

  it("deletes nothing when the list couldn't be re-read", () => {
    expect(unlinkedCreates(created, null)).toStrictEqual([]);
  });
});

describe("listLanded", () => {
  const written = [SOON, LATER];

  it("is true when the list holds exactly what was written", () => {
    expect(listLanded(written, new Set([LATER, SOON]))).toBe(true);
  });

  it.each([
    ["the list couldn't be re-read", null],
    ["a written batch is missing", new Set([SOON])],
    ["it holds another batch in place of one written", new Set([SOON, "x"])],
    ["the list holds another batch too", new Set([SOON, LATER, "x"])],
  ])("is false when %s", (_case, linked) => {
    expect(listLanded(written, linked)).toBe(false);
  });
});

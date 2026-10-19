import { describe, it, expect } from "vitest";

import { decrementFefo } from "./fefo";

const TODAY = "2026-10-19";

function batch(id: string, quantity: number, expirationDate: string) {
  return { id, quantity, expirationDate };
}

const A = batch("A", 3, "2026-10-20");
const B = batch("B", 10, "2026-10-25");
const C = batch("C", 5, "2026-11-01");

describe("decrementFefo", () => {
  it("takes from the soonest batch first and splits into the next", () => {
    // Listed out of date order on purpose
    expect(decrementFefo([C, A, B], 5, TODAY)).toStrictEqual({
      remaining: [C, batch("B", 8, "2026-10-25")],
      updated: [batch("B", 8, "2026-10-25")],
      emptied: [batch("A", 0, "2026-10-20")],
      shortfall: 0,
    });
  });

  it("empties a batch that exactly covers the quantity", () => {
    expect(decrementFefo([A, B], 3, TODAY)).toStrictEqual({
      remaining: [B],
      updated: [],
      emptied: [batch("A", 0, "2026-10-20")],
      shortfall: 0,
    });
  });

  it("only touches the soonest batch when it has enough", () => {
    const result = decrementFefo([A, B, C], 2, TODAY);

    expect(result.remaining).toStrictEqual([batch("A", 1, "2026-10-20"), B, C]);
    expect(result.updated).toStrictEqual([batch("A", 1, "2026-10-20")]);
    expect(result.emptied).toStrictEqual([]);
  });

  it("empties every batch and reports the shortfall on an oversell", () => {
    expect(decrementFefo([A, B, C], 20, TODAY)).toStrictEqual({
      remaining: [],
      updated: [],
      emptied: [
        batch("A", 0, "2026-10-20"),
        batch("B", 0, "2026-10-25"),
        batch("C", 0, "2026-11-01"),
      ],
      shortfall: 2,
    });
  });

  it("reports the whole quantity as shortfall when there are no batches", () => {
    expect(decrementFefo([], 4, TODAY)).toStrictEqual({
      remaining: [],
      updated: [],
      emptied: [],
      shortfall: 4,
    });
  });

  it("never takes from an expired batch, even when it's the soonest", () => {
    const expired = batch("expired", 5, "2026-10-01");

    expect(decrementFefo([expired, C], 3, TODAY)).toStrictEqual({
      remaining: [expired, batch("C", 2, "2026-11-01")],
      updated: [batch("C", 2, "2026-11-01")],
      emptied: [],
      shortfall: 0,
    });
  });

  it("reports a shortfall rather than using expired stock", () => {
    const expired = batch("expired", 5, "2026-10-18");

    expect(decrementFefo([expired], 2, TODAY)).toStrictEqual({
      remaining: [expired],
      updated: [],
      emptied: [],
      shortfall: 2,
    });
  });

  it("still uses a batch on its expiry day", () => {
    const expiresToday = batch("today", 4, TODAY);

    expect(decrementFefo([expiresToday, B], 1, TODAY).updated).toStrictEqual([
      batch("today", 3, TODAY),
    ]);
  });

  it("ignores batches with a negative quantity", () => {
    const negative = batch("negative", -2, "2026-10-20");

    expect(decrementFefo([negative, B], 3, TODAY)).toStrictEqual({
      remaining: [negative, batch("B", 7, "2026-10-25")],
      updated: [batch("B", 7, "2026-10-25")],
      emptied: [],
      shortfall: 0,
    });
  });

  it("uses batches with the same date in their existing order", () => {
    const first = batch("first", 2, "2026-10-20");
    const second = batch("second", 2, "2026-10-20");

    expect(decrementFefo([first, second], 3, TODAY)).toStrictEqual({
      remaining: [batch("second", 1, "2026-10-20")],
      updated: [batch("second", 1, "2026-10-20")],
      emptied: [batch("first", 0, "2026-10-20")],
      shortfall: 0,
    });
  });

  it("leaves batches already at zero untouched", () => {
    const soldOut = batch("soldOut", 0, "2026-10-01");

    expect(decrementFefo([soldOut, B], 1, TODAY)).toStrictEqual({
      remaining: [soldOut, batch("B", 9, "2026-10-25")],
      updated: [batch("B", 9, "2026-10-25")],
      emptied: [],
      shortfall: 0,
    });
  });

  it("uses a batch with an unreadable date last", () => {
    const undated = batch("undated", 5, "");

    expect(decrementFefo([undated, C], 6, TODAY)).toStrictEqual({
      remaining: [batch("undated", 4, "")],
      updated: [batch("undated", 4, "")],
      emptied: [batch("C", 0, "2026-11-01")],
      shortfall: 0,
    });
  });

  it("uses unreadable dates in their existing order, after real dates", () => {
    const invalid = batch("invalid", 2, "2026-13-45");
    const empty = batch("empty", 2, "");

    expect(decrementFefo([invalid, empty, C], 7, TODAY)).toStrictEqual({
      remaining: [empty],
      updated: [],
      emptied: [batch("invalid", 0, "2026-13-45"), batch("C", 0, "2026-11-01")],
      shortfall: 0,
    });
  });

  it("skips batches whose quantity isn't a whole number", () => {
    const fractional = batch("fractional", 1.5, "2026-10-21");

    expect(decrementFefo([fractional, B], 2, TODAY)).toStrictEqual({
      remaining: [fractional, batch("B", 8, "2026-10-25")],
      updated: [batch("B", 8, "2026-10-25")],
      emptied: [],
      shortfall: 0,
    });
  });

  it("treats the same batch object listed twice as two batches", () => {
    const X = batch("X", 5, "2026-10-20");

    expect(decrementFefo([X, X], 6, TODAY)).toStrictEqual({
      remaining: [batch("X", 4, "2026-10-20")],
      updated: [batch("X", 4, "2026-10-20")],
      emptied: [batch("X", 0, "2026-10-20")],
      shortfall: 0,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "changes nothing for a quantity of %s",
    (quantity) => {
      expect(decrementFefo([A, B], quantity, TODAY)).toStrictEqual({
        remaining: [A, B],
        updated: [],
        emptied: [],
        shortfall: 0,
      });
    },
  );

  it("returns a new list even when nothing changes", () => {
    const original = [A, B];
    const { remaining } = decrementFefo(original, 0, TODAY);

    expect(remaining).not.toBe(original);
  });

  it("doesn't modify the batches it was given", () => {
    const original = [batch("A", 3, "2026-10-20")];
    decrementFefo(original, 2, TODAY);

    expect(original).toStrictEqual([batch("A", 3, "2026-10-20")]);
  });
});

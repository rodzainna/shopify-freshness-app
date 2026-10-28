import { describe, it, expect } from "vitest";

import {
  Batch,
  getShopToday,
  computeBatchFreshness,
  computeAggregateFreshness,
  isExpired,
  isInStock,
  isPositiveWholeNumber,
  formatDaysRemaining,
  getEarliestExpirationDate,
  addDays,
  batchFreshnessOrNull,
  showsSoldOut,
  isCalendarDate,
} from "./freshness";

describe("addDays", () => {
  it.each([
    ["2026-10-23", 7, "2026-10-30"],
    ["2026-10-23", 30, "2026-11-22"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-01", -1, "2026-02-28"],
  ])("%s plus %i days is %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe("computeBatchFreshness", () => {
  const today = "2026-09-12"; // fixed — never derived from new Date()

  it("marks a batch expired when the expiry date has passed", () => {
    const result = computeBatchFreshness("2025-01-01", today);
    expect(result).toStrictEqual({ status: "Expired", daysRemaining: -619 });
  });

  it("marks a batch Fresh at 4 days remaining", () => {
    const result = computeBatchFreshness("2026-09-16", today);
    expect(result).toStrictEqual({ status: "Fresh", daysRemaining: 4 });
  });

  it("marks a batch Use Soon at exactly 3 days remaining (the threshold)", () => {
    const result = computeBatchFreshness("2026-09-15", today);
    expect(result).toStrictEqual({ status: "Use Soon", daysRemaining: 3 });
  });

  it("proves the result isn't cached: same expiration, two different 'today' values give different statuses", () => {
    const expirationDate = "2026-09-15";
    const earlier = computeBatchFreshness(expirationDate, "2026-09-10"); // 5 days out
    const later = computeBatchFreshness(expirationDate, "2026-09-13"); // 2 days out
    expect(earlier.status).toBe("Fresh");
    expect(later.status).toBe("Use Soon");
  });
});

describe("batchFreshnessOrNull", () => {
  it("computes freshness when both dates can be read", () => {
    expect(batchFreshnessOrNull("2026-09-15", "2026-09-12")).toStrictEqual({
      status: "Use Soon",
      daysRemaining: 3,
    });
  });

  it.each([
    ["a missing expiry date", "", "2026-09-12"],
    ["an expiry date that doesn't exist", "2026-02-30", "2026-09-12"],
  ])("is null for %s", (_, expirationDate, today) => {
    expect(batchFreshnessOrNull(expirationDate, today)).toBeNull();
  });

  it("still throws for an unreadable today, which would break every row", () => {
    expect(() => batchFreshnessOrNull("2026-09-15", "12/09/2026")).toThrow();
  });
});

describe("showsSoldOut", () => {
  const batch = (quantity: number) => ({
    quantity,
    expirationDate: "2026-11-01",
  });

  it.each([
    ["stored at 0 and untouched", batch(0), batch(0), true],
    ["stored at 0 and cleared to retype", batch(0), batch(Number.NaN), true],
    ["stored negative", batch(-2), batch(-2), true],
    ["stored fractional", batch(2.5), batch(2.5), true],
    ["stored as NaN", batch(Number.NaN), batch(Number.NaN), true],
    ["stored at 0 with a restock typed", batch(0), batch(5), false],
    ["in stock and cleared to retype", batch(7), batch(Number.NaN), false],
    ["in stock", batch(7), batch(7), false],
    ["new, so nothing is stored", undefined, batch(0), false],
  ])("for a batch %s is %s", (_, stored, typed, expected) => {
    expect(showsSoldOut(stored, typed)).toBe(expected);
  });
});

describe("getShopToday", () => {
  it("uses the shop's local date across a day boundary, not the UTC date", () => {
    // 11pm UTC on the 12th is already 7am on the 13th in Manila (UTC+8)
    const instant = new Date("2026-09-12T23:00:00.000Z");
    expect(getShopToday("Asia/Manila", instant)).toBe("2026-09-13");
  });

  it("works the other direction too, for a timezone behind UTC", () => {
    // 2am UTC on the 12th is still 7pm on the 11th in Los Angeles (UTC-7 in September, daylight saving)
    const instant = new Date("2026-09-12T02:00:00.000Z");
    expect(getShopToday("America/Los_Angeles", instant)).toBe("2026-09-11");
  });

  it("returns a date every freshness function can read", () => {
    const today = getShopToday("Asia/Manila", new Date("2026-01-05T12:00:00Z"));
    expect(today).toBe("2026-01-05");
    expect(isCalendarDate(today)).toBe(true);
  });

  it("throws for an invalid timezone", () => {
    expect(() => getShopToday("Not/AZone", new Date())).toThrow(RangeError);
  });
});

describe("computeAggregateFreshness", () => {
  const today = "2026-09-12";

  it("shows the worst status among active batches (mixed case)", () => {
    const batches = [
      { quantity: 3, expirationDate: "2025-01-01" }, // already expired
      { quantity: 10, expirationDate: "2030-01-01" }, // way fresh
    ];
    const result = computeAggregateFreshness(batches, today);
    expect(result).toBe("Expired");
  });

  it("skips batches whose date can't be read", () => {
    const batches = [
      { quantity: 2, expirationDate: "2026-02-30" },
      { quantity: 4, expirationDate: "" },
      { quantity: 10, expirationDate: "2030-01-01" },
    ];
    expect(computeAggregateFreshness(batches, today)).toBe("Fresh");
  });

  it("returns 'Not set' when there are no active batches", () => {
    const batches: Batch[] = [];
    const result = computeAggregateFreshness(batches, today);
    expect(result).toBe("Not set");
  });
});

describe("parseDateOnly validation (via computeBatchFreshness)", () => {
  const today = "2026-09-12";

  it("throws on a malformed date shape", () => {
    expect(() => computeBatchFreshness("not-a-date", today)).toThrow();
  });

  it("throws on wrong separators", () => {
    expect(() => computeBatchFreshness("2026/09/15", today)).toThrow();
  });

  it("throws on a date that doesn't exist, even with the right shape", () => {
    // February never has 30 days — this is the round-trip check catching
    // Date.UTC's silent rollover behavior
    expect(() => computeBatchFreshness("2026-02-30", today)).toThrow();
  });

  it("throws with a message that actually mentions the bad input", () => {
    expect(() => computeBatchFreshness("2026-13-01", today)).toThrow(
      "2026-13-01",
    );
  });

  it("still works correctly for a valid date (no false positives)", () => {
    expect(() => computeBatchFreshness("2026-09-20", today)).not.toThrow();
  });
});

describe("formatDaysRemaining", () => {
  it.each([
    [-150, "Expired 5mo ago"],
    [-100, "Expired 3mo ago"],
    [-99, "Expired 99d ago"],
    [-8, "Expired 8d ago"],
    [-1, "Expired yesterday"],
    [0, "Expires today"],
    [1, "Expires tomorrow"],
    [3, "Expires in 3d"],
    [99, "Expires in 99d"],
    [100, "Expires in 3mo"],
  ])("formats %i as %s", (daysRemaining, expected) => {
    expect(formatDaysRemaining(daysRemaining)).toBe(expected);
  });
});

describe("getEarliestExpirationDate", () => {
  it("returns the soonest expiry date across batches", () => {
    const batches: Batch[] = [
      { quantity: 5, expirationDate: "2026-10-20" },
      { quantity: 3, expirationDate: "2026-10-02" },
      { quantity: 8, expirationDate: "2026-11-15" },
    ];
    expect(getEarliestExpirationDate(batches)).toBe("2026-10-02");
  });

  it("ignores batches with no stock left", () => {
    const batches: Batch[] = [
      { quantity: 0, expirationDate: "2026-10-01" },
      { quantity: 4, expirationDate: "2026-10-09" },
    ];
    expect(getEarliestExpirationDate(batches)).toBe("2026-10-09");
  });

  it.each([
    ["a missing date", ""],
    ["a non-ISO date", "1/2/2026"],
    ["a day that doesn't exist", "2026-02-30"],
  ])("ignores a batch with %s", (_, expirationDate) => {
    const batches: Batch[] = [
      { quantity: 2, expirationDate },
      { quantity: 4, expirationDate: "2026-03-05" },
    ];
    expect(getEarliestExpirationDate(batches)).toBe("2026-03-05");
  });

  it("returns null when no in-stock batch has a readable date", () => {
    expect(
      getEarliestExpirationDate([
        { quantity: 2, expirationDate: "2026-02-30" },
      ]),
    ).toBeNull();
  });

  it("skips the same unreadable dates in the aggregate and earliest date", () => {
    const batches = [
      { quantity: 4, expirationDate: "2026-02-30" },
      { quantity: 4, expirationDate: "2026-12-01" },
    ];
    expect(computeAggregateFreshness(batches, "2026-09-12")).toBe("Fresh");
    expect(getEarliestExpirationDate(batches)).toBe("2026-12-01");
  });

  it("returns null when no batch is in stock", () => {
    expect(getEarliestExpirationDate([])).toBeNull();
    expect(
      getEarliestExpirationDate([
        { quantity: 0, expirationDate: "2026-10-01" },
      ]),
    ).toBeNull();
  });
});

describe("isExpired", () => {
  it.each([
    ["the day before today", "2026-10-19", true],
    ["today, its last usable day", "2026-10-20", false],
    ["a future date", "2026-10-21", false],
    ["an unreadable date", "not-a-date", false],
    ["a missing date", "", false],
  ])("is %s → %s", (_, expirationDate, expected) => {
    expect(isExpired({ quantity: 1, expirationDate }, "2026-10-20")).toBe(
      expected,
    );
  });
});

describe("isInStock", () => {
  it.each([
    [1, true],
    [12, true],
    [0, false],
    [-2, false],
    [1.5, false],
    [Number.NaN, false],
  ])("is %s → %s", (quantity, expected) => {
    expect(isInStock({ quantity, expirationDate: "2026-11-01" })).toBe(
      expected,
    );
  });

  it("is the rule the aggregate and earliest date both use", () => {
    const batches = [
      { quantity: 1.5, expirationDate: "2026-09-13" },
      { quantity: 4, expirationDate: "2026-12-01" },
    ];
    expect(computeAggregateFreshness(batches, "2026-09-12")).toBe("Fresh");
    expect(getEarliestExpirationDate(batches)).toBe("2026-12-01");
  });
});

describe("isPositiveWholeNumber", () => {
  it.each([1, 42])("accepts %s", (value) => {
    expect(isPositiveWholeNumber(value)).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, "2", null])("rejects %s", (value) => {
    expect(isPositiveWholeNumber(value)).toBe(false);
  });
});

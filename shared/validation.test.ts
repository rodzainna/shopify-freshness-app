import { describe, it, expect } from "vitest";

import { MAX_QUANTITY, validateBatch, hasErrors } from "./validation";

describe("validateBatch", () => {
  it("accepts a positive whole quantity and a real date", () => {
    expect(
      validateBatch({ quantity: 12, expirationDate: "2026-11-20" }),
    ).toStrictEqual({});
  });

  it("accepts a date that has already passed", () => {
    expect(
      validateBatch({ quantity: 1, expirationDate: "2020-01-01" }),
    ).toStrictEqual({});
  });

  it.each([0, -3])("rejects a quantity of %i", (quantity) => {
    expect(
      validateBatch({ quantity, expirationDate: "2026-11-20" }).quantity,
    ).toBe("Must be at least 1");
  });

  it.each([2.5, Number.NaN])("rejects a quantity of %s", (quantity) => {
    expect(
      validateBatch({ quantity, expirationDate: "2026-11-20" }).quantity,
    ).toBe("Must be a whole number");
  });

  it("accepts the largest allowed quantity", () => {
    expect(
      validateBatch({ quantity: MAX_QUANTITY, expirationDate: "2026-11-20" }),
    ).toStrictEqual({});
  });

  it.each([MAX_QUANTITY + 1, 1e21])("rejects a quantity of %s", (quantity) => {
    expect(
      validateBatch({ quantity, expirationDate: "2026-11-20" }).quantity,
    ).toBe("Number is too large");
  });

  it("requires an expiry date", () => {
    expect(
      validateBatch({ quantity: 1, expirationDate: "" }).expirationDate,
    ).toBe("Enter an expiry date");
  });

  it("rejects a date that doesn't exist", () => {
    expect(
      validateBatch({ quantity: 1, expirationDate: "2026-02-30" })
        .expirationDate,
    ).toBe("Enter a valid date");
  });

  it("reports both fields at once", () => {
    expect(validateBatch({ quantity: 0, expirationDate: "" })).toStrictEqual({
      quantity: "Must be at least 1",
      expirationDate: "Enter an expiry date",
    });
  });
});

describe("hasErrors", () => {
  it("is false for an empty error object", () => {
    expect(hasErrors({})).toBe(false);
  });

  it("is true when any field has an error", () => {
    expect(hasErrors({ quantity: "Must be at least 1" })).toBe(true);
  });
});

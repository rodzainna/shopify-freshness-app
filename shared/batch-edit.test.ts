import { describe, it, expect } from "vitest";

import {
  type EditableBatch,
  earliestAfterEdits,
  planBatchEdit,
  validateEdit,
} from "./batch-edit";

const loaf = (id: string, quantity: number, expirationDate: string) => ({
  id,
  quantity,
  expirationDate,
});

const opened: EditableBatch[] = [
  loaf("a", 6, "2026-10-23"),
  loaf("b", 12, "2026-10-28"),
];

describe("planBatchEdit", () => {
  it("writes only the batches that changed", () => {
    const edited = [loaf("a", 6, "2026-10-23"), loaf("b", 10, "2026-10-30")];

    expect(planBatchEdit(opened, opened, edited)).toStrictEqual({
      kind: "write",
      updates: [loaf("b", 10, "2026-10-30")],
    });
  });

  it("writes nothing when nothing was edited", () => {
    expect(planBatchEdit(opened, opened, opened)).toStrictEqual({
      kind: "unchanged",
    });
  });

  it("accepts the batches in any order", () => {
    const edited = [loaf("b", 12, "2026-10-28"), loaf("a", 5, "2026-10-23")];

    expect(planBatchEdit(opened, [...opened].reverse(), edited)).toStrictEqual({
      kind: "write",
      updates: [loaf("a", 5, "2026-10-23")],
    });
  });

  it.each([
    ["a quantity changed", [loaf("a", 5, "2026-10-23"), opened[1]]],
    ["a date changed", [loaf("a", 6, "2026-10-24"), opened[1]]],
    ["a batch was removed", [opened[0]]],
    ["a batch was added", [...opened, loaf("c", 1, "2026-11-01")]],
  ])("refuses when %s since it opened", (_case, current) => {
    const edited = [loaf("a", 4, "2026-10-23"), opened[1]];

    expect(planBatchEdit(opened, current, edited)).toStrictEqual({
      kind: "changed",
    });
  });

  it("reports invalid values by batch before checking for changes", () => {
    const edited = [loaf("a", 0, "2026-10-23"), loaf("b", 12, "")];

    expect(planBatchEdit(opened, [], edited)).toStrictEqual({
      kind: "invalid",
      errors: {
        a: {
          quantity:
            "Must be at least 1. To remove a batch, use the product panel.",
        },
        b: { expirationDate: "Enter an expiry date" },
      },
    });
  });

  it.each([
    ["a batch is missing", [opened[0]]],
    ["a batch replaces another", [opened[0], opened[0]]],
    ["a batch is listed twice", [opened[0], opened[0], opened[1]]],
    ["an unknown batch is added", [...opened, loaf("c", 1, "2026-11-01")]],
    ["an id is swapped", [opened[0], loaf("c", 12, "2026-10-28")]],
  ])("throws when %s in the edits", (_case, edited) => {
    expect(() => planBatchEdit(opened, opened, edited)).toThrow(
      "The edits don't match the batches that were opened",
    );
  });
});

describe("validateEdit", () => {
  it("points to the panel for removing a batch", () => {
    expect(validateEdit({ quantity: 0, expirationDate: "2026-10-23" })).toEqual(
      {
        quantity:
          "Must be at least 1. To remove a batch, use the product panel.",
      },
    );
  });

  it("keeps the panel's other messages", () => {
    expect(
      validateEdit({ quantity: 1.5, expirationDate: "2026-02-30" }),
    ).toEqual({
      quantity: "Must be a whole number",
      expirationDate: "Enter a valid date",
    });
  });
});

describe("earliestAfterEdits", () => {
  it("uses the written dates over the current ones", () => {
    expect(earliestAfterEdits(opened, [loaf("a", 6, "2026-11-30")])).toBe(
      "2026-10-28",
    );
  });

  it("keeps the current date for a batch whose write failed", () => {
    expect(earliestAfterEdits(opened, [])).toBe("2026-10-23");
  });
});

import { describe, it, expect } from "vitest";

import {
  type EditableBatch,
  type NewBatch,
  MAX_NEW_BATCHES_PER_SAVE,
  applyEdits,
  isBatchHandle,
  validateNewBatches,
  parseBatchEditRequest,
  planBatchEdit,
  validateEdit,
} from "./batch-edit";
import { MAX_BATCHES } from "./product-metafields";

const loaf = (id: string, quantity: number, expirationDate: string) => ({
  id,
  quantity,
  expirationDate,
});

const HANDLE = "3f2b8c1e-9d4a-4b7e-8f6a-2c1d0e9b8a7f";
const OTHER_HANDLE = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

const fresh = (
  handle: string,
  quantity: number,
  expirationDate: string,
): NewBatch => ({ handle, quantity, expirationDate });

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
      additions: [],
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
      additions: [],
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

describe("planBatchEdit with new batches", () => {
  it("adds batches to a product that has none", () => {
    const added = [fresh(HANDLE, 12, "2026-11-15")];

    expect(planBatchEdit([], [], [], added)).toStrictEqual({
      kind: "write",
      updates: [],
      additions: added,
    });
  });

  it("adds batches alongside edits to the opened ones", () => {
    const edited = [loaf("a", 5, "2026-10-23"), opened[1]];
    const added = [fresh(HANDLE, 3, "2026-11-01")];

    expect(planBatchEdit(opened, opened, edited, added)).toStrictEqual({
      kind: "write",
      updates: [loaf("a", 5, "2026-10-23")],
      additions: added,
    });
  });

  it("reports a new batch's errors under its handle, with the panel's messages", () => {
    const added = [fresh(HANDLE, 0, "2026-02-30")];

    expect(planBatchEdit(opened, opened, opened, added)).toStrictEqual({
      kind: "invalid",
      errors: {
        [HANDLE]: {
          quantity: "Must be at least 1",
          expirationDate: "Enter a valid date",
        },
      },
    });
  });

  it("refuses new batches when the opened ones changed", () => {
    const current = [loaf("a", 2, "2026-10-23"), opened[1]];
    const added = [fresh(HANDLE, 3, "2026-11-01")];

    expect(planBatchEdit(opened, current, opened, added)).toStrictEqual({
      kind: "changed",
    });
  });

  it("refuses to go over the batch limit", () => {
    const many = Array.from({ length: MAX_BATCHES - 1 }, (_, index) =>
      loaf(`b${index}`, 1, "2026-11-01"),
    );
    const added = [
      fresh(HANDLE, 1, "2026-11-01"),
      fresh(OTHER_HANDLE, 1, "2026-11-01"),
    ];

    expect(planBatchEdit(many, many, many, added)).toStrictEqual({
      kind: "tooMany",
      limit: "product",
      max: MAX_BATCHES,
    });
    expect(planBatchEdit(many, many, many, added.slice(1))).toMatchObject({
      kind: "write",
    });
  });

  it("refuses to add more than a save allows", () => {
    const handles = Array.from({ length: MAX_NEW_BATCHES_PER_SAVE + 1 }, () =>
      crypto.randomUUID(),
    );
    const added = handles.map((handle) => fresh(handle, 1, "2026-11-01"));

    expect(planBatchEdit([], [], [], added)).toStrictEqual({
      kind: "tooMany",
      limit: "save",
      max: MAX_NEW_BATCHES_PER_SAVE,
    });
    expect(planBatchEdit([], [], [], added.slice(1))).toMatchObject({
      kind: "write",
    });
  });

  it.each([
    [
      "repeats a handle",
      [fresh(HANDLE, 1, "2026-11-01"), fresh(HANDLE, 2, "2026-11-02")],
    ],
    ["has a handle that isn't a UUID", [fresh("batch-1", 1, "2026-11-01")]],
  ])("throws when the new batches %s", (_case, added) => {
    expect(() => planBatchEdit(opened, opened, opened, added)).toThrow(
      "Each new batch needs its own lowercase UUID handle",
    );
  });

  it("returns its own copy of the new batches", () => {
    const added = [fresh(HANDLE, 1, "2026-11-01")];
    const plan = planBatchEdit(opened, opened, opened, added);
    added[0].quantity = 9;
    added.pop();

    expect(plan).toMatchObject({ additions: [fresh(HANDLE, 1, "2026-11-01")] });
  });
});

describe("validateNewBatches", () => {
  it("keys errors by handle and skips valid batches", () => {
    expect(
      validateNewBatches([
        fresh(HANDLE, 2, "2026-11-01"),
        fresh(OTHER_HANDLE, 1.5, ""),
      ]),
    ).toStrictEqual({
      [OTHER_HANDLE]: {
        quantity: "Must be a whole number",
        expirationDate: "Enter an expiry date",
      },
    });
  });
});

describe("isBatchHandle", () => {
  it("accepts a randomUUID handle", () => {
    expect(isBatchHandle(crypto.randomUUID())).toBe(true);
  });

  it.each([
    ["uppercase", HANDLE.toUpperCase()],
    ["not version 4", "3f2b8c1e-9d4a-1b7e-8f6a-2c1d0e9b8a7f"],
    ["a Shopify GID", "gid://shopify/Metaobject/1"],
    ["empty", ""],
  ])("rejects %s", (_case, value) => {
    expect(isBatchHandle(value)).toBe(false);
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

describe("applyEdits", () => {
  it("uses the written values over the current ones", () => {
    expect(applyEdits(opened, [loaf("a", 4, "2026-11-30")])).toStrictEqual([
      loaf("a", 4, "2026-11-30"),
      opened[1],
    ]);
  });

  it("keeps the current values for a batch whose write failed", () => {
    expect(applyEdits(opened, [])).toStrictEqual(opened);
  });
});

describe("parseBatchEditRequest", () => {
  const stored = [
    loaf("gid://shopify/Metaobject/1", 6, "2026-10-23"),
    loaf("gid://shopify/Metaobject/2", 12, "2026-10-28"),
  ];
  const added = [fresh(HANDLE, 3, "2026-11-01")];
  const body = {
    productId: "gid://shopify/Product/1",
    opened: stored,
    edited: stored,
    added,
  };

  it("accepts a well-formed request", () => {
    expect(parseBatchEditRequest(body)).toStrictEqual(body);
  });

  it("reads a request without new batches as adding none", () => {
    const withoutAdded = {
      productId: body.productId,
      opened: stored,
      edited: stored,
    };

    expect(parseBatchEditRequest(withoutAdded)).toStrictEqual({
      ...withoutAdded,
      added: [],
    });
  });

  it.each([
    ["no body", null],
    ["a product id that isn't a GID", { ...body, productId: "1" }],
    ["a non-list of batches", { ...body, edited: "x" }],
    [
      "a quantity sent as text",
      { ...body, edited: [{ ...stored[0], quantity: "6" }] },
    ],
    [
      "a batch without an id",
      { ...body, opened: [{ quantity: 1, expirationDate: "" }] },
    ],
    [
      "a batch id that isn't a Metaobject GID",
      { ...body, opened: [loaf(HANDLE, 6, "2026-10-23")] },
    ],
    ["new batches that aren't a list", { ...body, added: "x" }],
    [
      "a new batch without a handle",
      { ...body, added: [{ quantity: 1, expirationDate: "2026-11-01" }] },
    ],
    [
      "a new batch's quantity sent as text",
      { ...body, added: [{ ...added[0], quantity: "3" }] },
    ],
    [
      "a new batch handle that isn't a UUID",
      { ...body, added: [fresh("batch-1", 1, "2026-11-01")] },
    ],
    ["a repeated new batch handle", { ...body, added: [...added, ...added] }],
  ])("rejects %s", (_case, value) => {
    expect(parseBatchEditRequest(value)).toBeNull();
  });
});

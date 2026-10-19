import { describe, it, expect } from "vitest";

import { applySavedIds, failedItems } from "./settled";

const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({
  status: "fulfilled",
  value,
});
const rejected = (reason: unknown): PromiseSettledResult<never> => ({
  status: "rejected",
  reason,
});

describe("applySavedIds", () => {
  it("gives every saved row its Shopify ID", () => {
    const result = applySavedIds(
      [{ id: "local-a" }, { id: "local-b" }],
      [
        fulfilled("gid://shopify/Metaobject/1"),
        fulfilled("gid://shopify/Metaobject/2"),
      ],
    );

    expect(result).toStrictEqual({
      items: [
        { id: "gid://shopify/Metaobject/1" },
        { id: "gid://shopify/Metaobject/2" },
      ],
      errors: [],
    });
  });

  it("keeps IDs from rows that saved when another row failed", () => {
    const error = new Error("invalid date");
    const result = applySavedIds(
      [{ id: "local-a" }, { id: "local-b" }],
      [fulfilled("gid://shopify/Metaobject/1"), rejected(error)],
    );

    expect(result).toStrictEqual({
      items: [{ id: "gid://shopify/Metaobject/1" }, { id: "local-b" }],
      errors: [error],
    });
  });
});

describe("failedItems", () => {
  it("returns only the items whose result was rejected", () => {
    expect(
      failedItems(
        ["a", "b", "c"],
        [fulfilled(undefined), rejected(new Error("x")), fulfilled(undefined)],
      ),
    ).toStrictEqual(["b"]);
  });

  it("returns an empty list when everything succeeded", () => {
    expect(failedItems(["a"], [fulfilled(undefined)])).toStrictEqual([]);
  });
});

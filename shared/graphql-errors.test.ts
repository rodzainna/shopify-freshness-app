import { describe, it, expect } from "vitest";

import { collectErrorMessages } from "./graphql-errors";

describe("collectErrorMessages", () => {
  it("is empty when nothing failed", () => {
    expect(collectErrorMessages(undefined, [], undefined)).toStrictEqual([]);
  });

  it("lists request errors before user errors, in order", () => {
    expect(
      collectErrorMessages(
        [{ message: "Throttled" }],
        [{ message: "Quantity is invalid" }],
        [{ message: "Key is taken" }],
      ),
    ).toStrictEqual(["Throttled", "Quantity is invalid", "Key is taken"]);
  });

  it("is empty when called with no errors at all", () => {
    expect(collectErrorMessages(undefined)).toStrictEqual([]);
  });

  it("works with only request errors", () => {
    expect(
      collectErrorMessages([{ message: "Throttled" }, { message: "Timeout" }]),
    ).toStrictEqual(["Throttled", "Timeout"]);
  });

  it("works with only user errors", () => {
    expect(
      collectErrorMessages(undefined, [{ message: "Not found" }]),
    ).toStrictEqual(["Not found"]);
  });
});

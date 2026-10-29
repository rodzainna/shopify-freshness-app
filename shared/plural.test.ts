import { describe, expect, it } from "vitest";

import { plural } from "./plural";

describe("plural", () => {
  it.each([
    [0, "batches"],
    [1, "batch"],
    [2, "batches"],
    [-1, "batches"],
  ])("uses the right word for %i", (count, expected) => {
    expect(plural(count, "batch", "batches")).toBe(expected);
  });
});

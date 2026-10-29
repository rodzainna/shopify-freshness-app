import { describe, it, expect } from "vitest";

import { fileName } from "./export-button";

describe("fileName", () => {
  it("uses the name the export route gives", () => {
    const headers = new Headers({
      "Content-Disposition":
        'attachment; filename="freshness-batches-2026-10-29.csv"',
    });

    expect(fileName(headers)).toBe("freshness-batches-2026-10-29.csv");
  });

  it("falls back to a plain name without one", () => {
    expect(fileName(new Headers())).toBe("freshness-batches.csv");
  });
});

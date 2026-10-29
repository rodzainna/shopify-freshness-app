import { describe, it, expect } from "vitest";

import { csvCell } from "./csv";

describe("csvCell", () => {
  it("leaves plain text alone", () => {
    expect(csvCell("Sourdough loaf")).toBe("Sourdough loaf");
  });

  it("quotes commas, quotes and line breaks, doubling inner quotes", () => {
    expect(csvCell("Eggs, free-range")).toBe('"Eggs, free-range"');
    expect(csvCell('The "best" milk')).toBe('"The ""best"" milk"');
    expect(csvCell("Two\nlines")).toBe('"Two\nlines"');
    expect(csvCell("Two\r\nlines")).toBe('"Two\r\nlines"');
  });
});

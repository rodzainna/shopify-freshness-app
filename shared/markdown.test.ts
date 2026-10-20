import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("splits bold and code out of plain text", () => {
    expect(parseInline("Use **only** the `product_id` field")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "strong", content: [{ kind: "text", text: "only" }] },
      { kind: "text", text: " the " },
      { kind: "code", text: "product_id" },
      { kind: "text", text: " field" },
    ]);
  });
});

describe("parseInline with nesting", () => {
  it("parses code inside bold", () => {
    expect(parseInline("**Webhooks (`fulfillments/create`).**")).toEqual([
      {
        kind: "strong",
        content: [
          { kind: "text", text: "Webhooks (" },
          { kind: "code", text: "fulfillments/create" },
          { kind: "text", text: ")." },
        ],
      },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings, paragraphs and nested lists", () => {
    const source = [
      "# Title",
      "",
      "First line",
      "continues here.",
      "",
      "## Section",
      "",
      "- **One:** first",
      "- Two:",
      "  - nested",
      "- Three",
    ].join("\n");

    expect(parseMarkdown(source)).toEqual([
      { kind: "heading", level: 1, content: [{ kind: "text", text: "Title" }] },
      {
        kind: "paragraph",
        content: [{ kind: "text", text: "First line continues here." }],
      },
      {
        kind: "heading",
        level: 2,
        content: [{ kind: "text", text: "Section" }],
      },
      {
        kind: "list",
        items: [
          {
            content: [
              { kind: "strong", content: [{ kind: "text", text: "One:" }] },
              { kind: "text", text: " first" },
            ],
            children: [],
          },
          {
            content: [{ kind: "text", text: "Two:" }],
            children: [
              { content: [{ kind: "text", text: "nested" }], children: [] },
            ],
          },
          { content: [{ kind: "text", text: "Three" }], children: [] },
        ],
      },
    ]);
  });

  it("handles Windows line endings", () => {
    expect(parseMarkdown("## A\r\n\r\n- x\r\n").map((b) => b.kind)).toEqual([
      "heading",
      "list",
    ]);
  });

  it("joins a wrapped list item's continuation line", () => {
    expect(parseMarkdown("- first part\n  second part\n- next")).toEqual([
      {
        kind: "list",
        items: [
          {
            content: [{ kind: "text", text: "first part second part" }],
            children: [],
          },
          { content: [{ kind: "text", text: "next" }], children: [] },
        ],
      },
    ]);
  });

  it("starts a new list after a paragraph", () => {
    const blocks = parseMarkdown("- a\n\ntext\n\n- b");
    expect(blocks.map((block) => block.kind)).toEqual([
      "list",
      "paragraph",
      "list",
    ]);
  });
});

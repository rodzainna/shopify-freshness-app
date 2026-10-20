// Parses the small markdown subset PRIVACY.md uses, so the app can render it
// with Polaris components instead of injecting HTML.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; content: Inline[] };

export type ListItem = { content: Inline[]; children: ListItem[] };

export type Block =
  | { kind: "heading"; level: 1 | 2; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "list"; items: ListItem[] };

function parseCode(text: string): Inline[] {
  return text
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((piece) =>
      piece.startsWith("`") && piece.endsWith("`")
        ? { kind: "code", text: piece.slice(1, -1) }
        : { kind: "text", text: piece },
    );
}

// Bold may contain code, as in "**Fulfillment webhooks (`fulfillments/create`).**".
export function parseInline(text: string): Inline[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .flatMap((piece) =>
      piece.startsWith("**") && piece.endsWith("**")
        ? [{ kind: "strong" as const, content: parseCode(piece.slice(2, -2)) }]
        : parseCode(piece),
    );
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        content: parseInline(paragraph.join(" ")),
      });
      paragraph = [];
    }
  };

  for (const line of source.split("\n")) {
    const heading = line.match(/^(#{1,2}) (.+)$/);
    const item = line.match(/^( *)- (.+)$/);

    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2,
        content: parseInline(heading[2]),
      });
    } else if (item) {
      flushParagraph();
      const entry: ListItem = { content: parseInline(item[2]), children: [] };
      const last = blocks.at(-1);
      // Two-space indent nests under the previous item, as in PRIVACY.md.
      if (item[1].length > 0 && last?.kind === "list" && last.items.length) {
        last.items[last.items.length - 1].children.push(entry);
      } else if (last?.kind === "list") {
        last.items.push(entry);
      } else {
        blocks.push({ kind: "list", items: [entry] });
      }
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return blocks;
}

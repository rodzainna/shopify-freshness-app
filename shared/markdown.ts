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

  // Raw text of the item a continuation line would extend.
  let openItem: { entry: ListItem; raw: string } | null = null;

  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,2}) (.+)$/);
    const item = line.match(/^( *)- (.+)$/);

    if (heading) {
      flushParagraph();
      openItem = null;
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2,
        content: parseInline(heading[2]),
      });
    } else if (item) {
      flushParagraph();
      const entry: ListItem = { content: parseInline(item[2]), children: [] };
      openItem = { entry, raw: item[2] };
      const last = blocks.at(-1);
      // Any indent nests one level under the previous item; deeper levels aren't supported.
      if (item[1].length > 0 && last?.kind === "list" && last.items.length) {
        last.items[last.items.length - 1].children.push(entry);
      } else if (last?.kind === "list") {
        last.items.push(entry);
      } else {
        blocks.push({ kind: "list", items: [entry] });
      }
    } else if (openItem && /^ +\S/.test(line)) {
      // An indented line right after an item is that item wrapped.
      openItem.raw = `${openItem.raw} ${line.trim()}`;
      openItem.entry.content = parseInline(openItem.raw);
    } else if (line.trim() === "") {
      flushParagraph();
      openItem = null;
    } else {
      openItem = null;
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return blocks;
}

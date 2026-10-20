import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import privacyMarkdown from "../../PRIVACY.md?raw";
import {
  parseMarkdown,
  type Block,
  type Inline,
  type ListItem,
} from "../../shared/markdown";

type Section = { heading?: Inline[]; blocks: Block[] };

const plainText = (content: Inline[]): string =>
  content
    .map((part) =>
      part.kind === "strong" ? plainText(part.content) : part.text,
    )
    .join("");

// Each "##" heading starts a Polaris section; the "#" title becomes the page heading.
function toSections(blocks: Block[]) {
  let title = "Privacy";
  const sections: Section[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1) {
      title = plainText(block.content);
    } else if (block.kind === "heading") {
      sections.push({ heading: block.content, blocks: [] });
    } else {
      if (sections.length === 0) sections.push({ blocks: [] });
      sections[sections.length - 1].blocks.push(block);
    }
  }
  return { title, sections };
}

const { title, sections } = toSections(parseMarkdown(privacyMarkdown));

function InlineText({ content }: { content: Inline[] }) {
  return content.map((part, index) =>
    part.kind === "strong" ? (
      <strong key={index}>
        <InlineText content={part.content} />
      </strong>
    ) : part.kind === "code" ? (
      <code key={index}>{part.text}</code>
    ) : (
      part.text
    ),
  );
}

function List({ items }: { items: ListItem[] }) {
  return (
    <s-unordered-list>
      {items.map((item, index) => (
        <s-list-item key={index}>
          <InlineText content={item.content} />
          {item.children.length > 0 && <List items={item.children} />}
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}

export default function PrivacyPage() {
  return (
    <s-page heading={title}>
      {sections.map((section, index) => (
        <s-section
          key={index}
          heading={section.heading && plainText(section.heading)}
        >
          {section.blocks.map((block, blockIndex) =>
            block.kind === "list" ? (
              <List key={blockIndex} items={block.items} />
            ) : (
              <s-paragraph key={blockIndex}>
                <InlineText content={block.content} />
              </s-paragraph>
            ),
          )}
        </s-section>
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

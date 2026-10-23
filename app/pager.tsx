/** "‹ Page [3] of 9 ›" under the table; hidden when everything fits on one page. */
export function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);

  return (
    <s-stack
      direction="inline"
      gap="small-200"
      alignItems="center"
      justifyContent="center"
    >
      {page > 1 && (
        <s-button
          icon="chevron-left"
          accessibilityLabel="Previous page"
          onClick={() => onPage(page - 1)}
        />
      )}
      <s-text>Page</s-text>
      {/* Keyed by page, since the value attribute only sets a starting value */}
      <s-box inlineSize="80px">
        <s-select
          key={page}
          label="Page"
          labelAccessibilityVisibility="exclusive"
          value={String(page)}
          onChange={(event) => onPage(Number(event.currentTarget.value))}
        >
          {pages.map((number) => (
            <s-option key={number} value={String(number)}>
              {String(number)}
            </s-option>
          ))}
        </s-select>
      </s-box>
      <s-text>of {pageCount}</s-text>
      {page < pageCount && (
        <s-button
          icon="chevron-right"
          accessibilityLabel="Next page"
          onClick={() => onPage(page + 1)}
        />
      )}
    </s-stack>
  );
}

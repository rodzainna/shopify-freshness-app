import type { StockComparison } from "../shared/inventory";

/** compareStock's flags, as the dashboard and the batch editor show them. */
export function StockBadges({
  overStock,
  unbatchedStock,
  partial = false,
}: Pick<StockComparison, "overStock" | "unbatchedStock"> & {
  // Some batches didn't load, so the over count is a lower bound
  partial?: boolean;
}) {
  return (
    <>
      {overStock !== null && (
        <s-badge tone="warning">
          {overStock}
          {partial && "+"} over
        </s-badge>
      )}
      {unbatchedStock !== null && (
        <s-badge tone="info">{unbatchedStock} unbatched</s-badge>
      )}
    </>
  );
}

import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import {
  countStockDiffers,
  countTrackingDiffers,
  demoStockCsv,
} from "../dev/demo-seed";
import { DEMO_PRODUCTS } from "../dev/demo-seed.data";
import { productStock } from "../../shared/inventory";
import { plural } from "../../shared/plural";
import {
  type ReseedResult,
  readStoreProducts,
  requireDevelopment,
} from "../dev/demo-seed.server";
import { readShopToday } from "../fulfillment-shopify.server";
import { authenticate } from "../shopify.server";

const LOCATION = "Shop location";

type RowState = { kind: "idle" } | { kind: "running" } | ReseedResult;

// Dev-only: refreshes every demo product's batches, dated from today
export const loader = async ({ request }: LoaderFunctionArgs) => {
  requireDevelopment();
  const { admin } = await authenticate.admin(request);
  const [today, store] = await Promise.all([
    readShopToday(admin, new Date()),
    readStoreProducts(admin),
  ]);
  const byHandle = new Map(store.map((product) => [product.handle, product]));
  const rows = DEMO_PRODUCTS.map(({ handle, title, stock, batches }) => {
    const found = byHandle.get(handle);
    const storeStock = found ? productStock(found) : null;
    return {
      handle,
      title,
      batches: batches.length,
      plannedStock: stock,
      storeStock,
      productId: found?.id ?? null,
    };
  });
  return { today, rows };
};

export default function SeedDemoPage() {
  const { today, rows } = useLoaderData<typeof loader>();
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  // A single retry also counts, so two reseeds of one product can't race
  const busy =
    running || Object.values(states).some(({ kind }) => kind === "running");
  const inStore = rows.flatMap(({ productId, ...row }) =>
    productId ? [{ ...row, productId }] : [],
  );
  const stockDiffers = countStockDiffers(inStore);
  const trackingDiffers = countTrackingDiffers(inStore);
  let reseedLabel = `Reseed all ${inStore.length} products`;
  if (inStore.length === 0) reseedLabel = "No demo products to reseed";
  if (inStore.length === 1) reseedLabel = "Reseed 1 product";

  const reseed = async (handle: string, productId: string) => {
    setStates((current) => ({ ...current, [handle]: { kind: "running" } }));
    let result: ReseedResult;
    try {
      const response = await fetch("/app/dev/seed-demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, productId }),
      });
      result = await response.json();
    } catch {
      result = { kind: "failed", message: "The request didn't finish." };
    }
    setStates((current) => ({ ...current, [handle]: result }));
  };

  const reseedAll = async () => {
    setRunning(true);
    // One at a time, so each product's writes finish before the next starts
    for (const { handle, productId } of inStore) {
      await reseed(handle, productId);
    }
    setRunning(false);
  };

  const downloadStockCsv = () => {
    const blob = new Blob([demoStockCsv(DEMO_PRODUCTS, LOCATION)], {
      type: "text/csv",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "demo-stock.csv";
    link.click();
    // Some browsers start the download after this handler returns
    setTimeout(() => URL.revokeObjectURL(link.href));
  };

  return (
    <s-page heading="Reseed demo batches">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            Replaces every demo product&apos;s batches with the planned ones,
            dated from the shop&apos;s today ({today}). Products and images
            aren&apos;t changed.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={reseedAll}
              loading={running || undefined}
              disabled={busy || inStore.length === 0 || undefined}
            >
              {reseedLabel}
            </s-button>
            <s-button onClick={downloadStockCsv}>Download stock CSV</s-button>
          </s-stack>
          {stockDiffers > 0 && (
            <s-banner tone="warning" heading="Stock differs from the plan">
              {stockDiffers}{" "}
              {plural(
                stockDiffers,
                "product doesn't have its",
                "products don't have their",
              )}{" "}
              planned stock available. Import the stock CSV in Products →
              Inventory to reset it. Units held by unfulfilled orders still
              count as a difference.
            </s-banner>
          )}
          {trackingDiffers > 0 && (
            <s-banner tone="warning" heading="Inventory tracking differs">
              {trackingDiffers}{" "}
              {plural(trackingDiffers, "product tracks", "products track")}{" "}
              inventory differently from the plan. Turn tracking on or off in
              each product&apos;s Inventory section to match the Planned stock
              column.
            </s-banner>
          )}
        </s-stack>
      </s-section>
      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Batches</s-table-header>
            <s-table-header>Planned stock</s-table-header>
            <s-table-header>Available</s-table-header>
            <s-table-header listSlot="secondary">Result</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map(({ productId, ...row }) => (
              <s-table-row key={row.handle}>
                <s-table-cell>{row.title}</s-table-cell>
                <s-table-cell>{row.batches}</s-table-cell>
                <s-table-cell>{row.plannedStock ?? "Not tracked"}</s-table-cell>
                <s-table-cell>
                  {productId ? (row.storeStock ?? "Not tracked") : "—"}
                </s-table-cell>
                <s-table-cell>
                  {productId ? (
                    <Result
                      state={states[row.handle] ?? { kind: "idle" }}
                      retry={
                        busy ? undefined : () => reseed(row.handle, productId)
                      }
                    />
                  ) : (
                    <s-badge tone="critical">Not in the store</s-badge>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

function Result({ state, retry }: { state: RowState; retry?: () => void }) {
  if (state.kind === "idle") return null;
  if (state.kind === "running") return <s-badge>Reseeding…</s-badge>;
  if (state.kind === "seeded") {
    return (
      <s-badge tone="success">
        {state.added} added, {state.removed} removed
      </s-badge>
    );
  }
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-badge tone="critical">{state.message}</s-badge>
      {retry && <s-button onClick={retry}>Retry</s-button>}
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

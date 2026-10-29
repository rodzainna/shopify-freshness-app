import { useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { saveFile } from "./save-file";
import { viewSearch } from "../shared/dashboard-filters";

const FALLBACK_NAME = "freshness-batches.csv";

/** Page action that downloads what the dashboard's filters and sort match. */
export function ExportButton({
  commitSearch,
}: {
  // The view chosen, which may still be loading
  commitSearch: () => string;
}) {
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(false);
  // A ref, so a second click before the next render is still ignored
  const running = useRef(false);

  async function download() {
    // One export at a time; each reads up to 1,000 products
    if (running.current) return;
    running.current = true;
    setExporting(true);
    try {
      // App Bridge signs the app's own fetches; a plain link would get sign-in HTML
      const response = await fetch(`/app/export${viewSearch(commitSearch())}`);
      // A sign-in page can arrive as a 200, so only a CSV is saved
      const isCsv = response.headers
        .get("Content-Type")
        ?.startsWith("text/csv");
      if (!response.ok || !isCsv) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        shopify.toast.show(body?.message ?? "Couldn't export. Try again.", {
          isError: true,
        });
        return;
      }
      saveFile(await response.blob(), fileName(response.headers));
    } catch {
      shopify.toast.show("Couldn't reach the app. Try again.", {
        isError: true,
      });
    } finally {
      running.current = false;
      setExporting(false);
    }
  }

  return (
    <s-button
      slot="secondary-actions"
      icon="export"
      loading={exporting || undefined}
      onClick={download}
    >
      Export CSV
    </s-button>
  );
}

/** The name the route gives the file, dated by the shop's day. */
export function fileName(headers: Headers): string {
  const disposition = headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? FALLBACK_NAME;
}

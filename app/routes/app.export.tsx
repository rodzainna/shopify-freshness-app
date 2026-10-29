import type { LoaderFunctionArgs } from "react-router";

import {
  EXPORT_LIMIT,
  ExportChangedError,
  loadExportProducts,
} from "../export.server";
import { authenticate } from "../shopify.server";
import { isShopifySignIn } from "../shopify-response";
import { toCsv, toExportRows } from "../../shared/csv-export";
import { parseDashboardFilters } from "../../shared/dashboard-filters";

// Loader only: a route with a component answers with the page's HTML instead
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const filters = parseDashboardFilters(new URL(request.url).searchParams);
    const data = await loadExportProducts(admin, filters);
    if (data.kind === "tooMany") {
      return message(
        422,
        `More than ${EXPORT_LIMIT.toLocaleString("en-US")} products to check. Narrow your search, type, vendor or expiry first.`,
      );
    }
    const csv = toCsv(toExportRows(data.products, data.today, session.shop));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="freshness-batches-${data.today}.csv"`,
        // Each export reads the batches as they are now
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // Sign-in responses go on to App Bridge; the rest become a message
    if (error instanceof Response && isShopifySignIn(error.status)) throw error;
    if (error instanceof ExportChangedError) {
      return message(409, "Products changed during the export. Try again.");
    }
    console.error("CSV export failed", error);
    return message(502, "Couldn't reach Shopify. Try again.");
  }
};

const message = (status: number, text: string) =>
  Response.json({ message: text }, { status });

import { describe, it, expect, afterEach, vi } from "vitest";

import { authenticate } from "../shopify.server";
import { ExportChangedError, loadExportProducts } from "../export.server";
import { loader } from "./app.export";

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../export.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../export.server")>()),
  loadExportProducts: vi.fn(),
}));

const shop = "export-route-test.myshopify.com";

function signedIn() {
  vi.mocked(authenticate.admin).mockResolvedValue({
    admin: {},
    session: { shop },
  } as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
}

const get = (query = "") =>
  loader({
    request: new Request(`http://localhost/app/export?${query}`),
  } as Parameters<typeof loader>[0]);

afterEach(() => {
  vi.mocked(authenticate.admin).mockReset();
  vi.mocked(loadExportProducts).mockReset();
  vi.restoreAllMocks();
});

describe("app/export", () => {
  it("returns the CSV file named for the shop's day", async () => {
    signedIn();
    vi.mocked(loadExportProducts).mockResolvedValue({
      kind: "ready",
      today: "2026-10-29",
      products: [
        {
          legacyResourceId: "7",
          title: "Sourdough loaf",
          vendor: "Hearth Bakery",
          productType: "Bread",
          tracksInventory: true,
          totalInventory: 3,
          freshnessBatches: null,
        },
      ],
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="freshness-batches-2026-10-29.csv"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // ignoreBOM keeps the mark, which decoding strips by default
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await response.arrayBuffer(),
    );
    expect(text.startsWith("\uFEFFProduct,")).toBe(true);
    expect(text).toContain(`https://${shop}/admin/products/7`);
  });

  it("passes the dashboard's filters from the URL", async () => {
    signedIn();
    vi.mocked(loadExportProducts).mockResolvedValue({
      kind: "ready",
      today: "2026-10-29",
      products: [],
    });

    await get("q=milk&status=expired&sort=expiry");

    expect(vi.mocked(loadExportProducts).mock.calls[0][1]).toMatchObject({
      search: "milk",
      statuses: ["expired"],
      sort: "expiry",
    });
  });

  it("asks to narrow the filters past 1,000 products", async () => {
    signedIn();
    vi.mocked(loadExportProducts).mockResolvedValue({ kind: "tooMany" });

    const response = await get();

    expect(response.status).toBe(422);
    expect(await response.json()).toStrictEqual({
      message:
        "More than 1,000 products to check. Narrow your search, type, vendor or expiry first.",
    });
  });

  it("asks to try again when products changed mid-export", async () => {
    signedIn();
    vi.mocked(loadExportProducts).mockRejectedValue(
      new ExportChangedError("Product Apples moved during the export"),
    );

    const response = await get();

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      message: "Products changed during the export. Try again.",
    });
  });

  it("logs any other failure and returns a message", async () => {
    signedIn();
    const failure = new Error("THROTTLED");
    vi.mocked(loadExportProducts).mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await get();

    expect(response.status).toBe(502);
    expect(await response.json()).toStrictEqual({
      message: "Couldn't reach Shopify. Try again.",
    });
    expect(log).toHaveBeenCalledWith("CSV export failed", failure);
  });

  it("turns a Shopify error response into a message", async () => {
    vi.mocked(authenticate.admin).mockRejectedValue(
      new Response(null, { status: 503 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await get();

    expect(response.status).toBe(502);
    expect(await response.json()).toStrictEqual({
      message: "Couldn't reach Shopify. Try again.",
    });
  });

  it("lets a sign-in response through to App Bridge", async () => {
    const signIn = new Response(null, { status: 401 });
    vi.mocked(authenticate.admin).mockRejectedValue(signIn);

    await expect(get()).rejects.toBe(signIn);
  });
});

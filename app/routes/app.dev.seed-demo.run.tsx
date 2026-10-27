import type { ActionFunctionArgs } from "react-router";

import { requireDevelopment, reseedProduct } from "../dev/demo-seed.server";
import { planDemoBatches } from "../dev/demo-seed";
import { DEMO_PRODUCTS } from "../dev/demo-seed.data";
import { readShopToday } from "../fulfillment-shopify.server";
import { authenticate } from "../shopify.server";
import { isShopifySignIn } from "../shopify-response";
import { PRODUCT_GID } from "../../shared/product-gid";

// POST { handle, productId }: replaces that demo product's batches with ones
// dated from the shop's today
export const action = async ({ request }: ActionFunctionArgs) => {
  requireDevelopment();
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const product = DEMO_PRODUCTS.find(({ handle }) => handle === body?.handle);
  const { productId } = body ?? {};
  if (
    !product ||
    typeof productId !== "string" ||
    !PRODUCT_GID.test(productId)
  ) {
    return Response.json(
      { kind: "failed", message: "Invalid request." },
      { status: 400 },
    );
  }

  try {
    // Read per request, so a page left open past midnight still dates correctly
    const today = await readShopToday(admin, new Date());
    const planned = planDemoBatches(product, today, () => crypto.randomUUID());
    const { handle } = product;
    return Response.json(
      await reseedProduct({
        admin,
        shop: session.shop,
        productId,
        handle,
        planned,
      }),
    );
  } catch (error) {
    if (error instanceof Response && isShopifySignIn(error.status)) throw error;
    console.error(`Reseeding ${product.handle} failed`, error);
    return Response.json(
      { kind: "failed", message: "Couldn't reach Shopify. Try again." },
      { status: 502 },
    );
  }
};

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { editBatches, loadBatches } from "../batch-edit.server";
import { authenticate } from "../shopify.server";
import {
  MismatchedEditsError,
  parseBatchEditRequest,
} from "../../shared/batch-edit";
import { PRODUCT_GID } from "../../shared/product-gid";

// The editor loads fresh batches each time it opens, so a save needn't reload them
export const shouldRevalidate = () => false;

// The dashboard's batch editor: GET ?productId= reads, POST saves
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId") ?? "";
  if (!PRODUCT_GID.test(productId)) {
    return Response.json({ message: "Unknown product." }, { status: 400 });
  }
  return withErrorMessage(() => loadBatches(admin, productId));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = parseBatchEditRequest(await request.json().catch(() => null));
  if (!body) {
    return Response.json({ message: "Invalid request." }, { status: 400 });
  }
  return withErrorMessage(() =>
    editBatches({ admin, shop: session.shop, ...body }),
  );
};

// Shows the error in the editor instead of replacing the whole dashboard
async function withErrorMessage<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof MismatchedEditsError) {
      return Response.json({ message: error.message }, { status: 400 });
    }
    console.error("Batch editor request failed", error);
    return Response.json(
      { message: "Couldn't reach Shopify. Try again." },
      { status: 502 },
    );
  }
}

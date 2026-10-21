import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { editBatches, loadBatches } from "../batch-edit.server";
import { authenticate } from "../shopify.server";
import {
  MismatchedEditsError,
  parseBatchEditRequest,
} from "../../shared/batch-edit";
import { PRODUCT_GID } from "../../shared/product-gid";

// The dashboard's batch editor: GET ?productId= reads, POST saves
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("productId") ?? "";
  if (!PRODUCT_GID.test(productId)) {
    return Response.json({ message: "Unknown product." }, { status: 400 });
  }
  return loadBatches(admin, productId);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = parseBatchEditRequest(await request.json().catch(() => null));
  if (!body) {
    return Response.json({ message: "Invalid request." }, { status: 400 });
  }

  try {
    return await editBatches({ admin, shop: session.shop, ...body });
  } catch (error) {
    if (error instanceof MismatchedEditsError) {
      return Response.json({ message: error.message }, { status: 400 });
    }
    throw error;
  }
};

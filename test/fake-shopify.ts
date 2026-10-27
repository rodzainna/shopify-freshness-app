import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ProductInventory } from "../shared/inventory";

interface FakeBatch {
  quantity: number;
  expirationDate: string;
}

interface FakeProduct {
  // null when the product has no freshness_batches metafield
  batchIds: string[] | null;
  earliestExpirationDate: string | null;
}

type Variables = Record<string, unknown>;

// Changes whenever the stored list does, like Shopify's compareDigest
export const listDigest = (batchIds: string[]) =>
  `digest:${JSON.stringify(batchIds)}`;

/**
 * An in-memory store answering the app's fulfillment GraphQL operations, so
 * tests can check what Shopify ends up holding after failures and retries.
 * `delayMs` makes every call take that long, so concurrent work overlaps.
 * It uses real timers, so it hangs under vi.useFakeTimers().
 */
export function fakeShopify({ delayMs = 0 } = {}) {
  const products = new Map<string, FakeProduct>();
  const batches = new Map<string, FakeBatch>();
  // Untracked unless a test sets it
  const inventories = new Map<string, ProductInventory>();
  // Handle → id, for batches created by handle
  const handles = new Map<string, string>();
  // Product id → handle, for reads that return it
  const productHandles = new Map<string, string>();
  let nextBatchNumber = 1000;
  const isListed = (id: string) =>
    [...products.values()].some(({ batchIds }) => batchIds?.includes(id));
  const calls: string[] = [];
  // Operation name → how many more calls should fail before succeeding
  const failures = new Map<string, number>();
  // Operation name → how many more calls apply but then fail like a timeout
  const lostResponses = new Map<string, number>();
  // Operation name → how many more calls Shopify should reject
  const rejections = new Map<string, number>();
  const payloadField: Record<string, string> = {
    SetBatchFields: "metaobjectUpdate",
    SaveProductFreshness: "metafieldsSet",
    DeleteBatch: "metaobjectDelete",
    UpsertBatch: "metaobjectUpsert",
    SaveBatchList: "metafieldsSet",
  };

  const userError = (message: string, code: string) => ({
    userErrors: [{ field: ["id"], message, code }],
  });
  const ok = { userErrors: [] };

  const answer: Record<string, (variables: Variables) => unknown> = {
    GetShopTimezone: () => ({ shop: { ianaTimezone: "UTC" } }),
    GetProductInventory: ({ productId }) => {
      if (!products.has(productId as string)) return { product: null };
      const inventory = inventories.get(productId as string);
      return {
        product: inventory ?? { tracksInventory: false, totalInventory: 0 },
      };
    },
    GetProductBatches: ({ productId }) => {
      const product = products.get(productId as string);
      if (!product) return { product: null };
      const earliestExpiration = product.earliestExpirationDate
        ? { value: product.earliestExpirationDate }
        : null;
      if (!product.batchIds) {
        return { product: { earliestExpiration, freshnessBatches: null } };
      }
      return {
        product: {
          earliestExpiration,
          freshnessBatches: {
            compareDigest: listDigest(product.batchIds),
            references: {
              // A batch that isn't stored comes back as null, like Shopify
              nodes: product.batchIds.map((id) => {
                const batch = batches.get(id);
                if (!batch) return null;
                return {
                  id,
                  quantity: { value: String(batch.quantity) },
                  expirationDate: { value: batch.expirationDate },
                };
              }),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    },
    GetBatchListIds: ({ productId }) => {
      const product = products.get(productId as string);
      if (!product) return { product: null };
      const { batchIds } = product;
      return {
        product: {
          handle: productHandles.get(productId as string) ?? "demo-product",
          list: batchIds && {
            value: JSON.stringify(batchIds),
            compareDigest: listDigest(batchIds),
          },
        },
      };
    },
    SetBatchFields: ({ id, metaobject }) => {
      const batch = batches.get(id as string);
      if (!batch) {
        return {
          metaobjectUpdate: userError("Record not found", "RECORD_NOT_FOUND"),
        };
      }
      // Applies only the fields the mutation sends
      const { fields } = metaobject as {
        fields: { key: string; value: string }[];
      };
      for (const { key, value } of fields) {
        if (key === "quantity") batch.quantity = Number(value);
        if (key === "expiration_date") batch.expirationDate = value;
      }
      return { metaobjectUpdate: ok };
    },
    SaveProductFreshness: (variables) => {
      const set = variables.set as {
        ownerId: string;
        key: string;
        value: string;
      }[];
      const remove = variables.delete as { ownerId: string; key: string }[];
      for (const { ownerId, key, value } of set) {
        const product = products.get(ownerId)!;
        if (key === "freshness_batches") product.batchIds = JSON.parse(value);
        else product.earliestExpirationDate = value;
      }
      for (const { ownerId, key } of remove) {
        const product = products.get(ownerId)!;
        if (key === "freshness_batches") product.batchIds = null;
        else product.earliestExpirationDate = null;
      }
      return { metafieldsSet: ok, metafieldsDelete: ok };
    },
    FindBatchByHandle: ({ handle }) => {
      const id = handles.get(handle as string);
      if (!id || !batches.has(id)) return { metaobjectByHandle: null };
      return {
        metaobjectByHandle: {
          id,
          referencedBy: {
            nodes: isListed(id) ? [{ key: "freshness_batches" }] : [],
          },
        },
      };
    },
    UpsertBatch: ({ handle, fields }) => {
      const values = Object.fromEntries(
        (fields as { key: string; value: string }[]).map(({ key, value }) => [
          key,
          value,
        ]),
      );
      const existing = handles.get(handle as string);
      const id = existing ?? `gid://shopify/Metaobject/${nextBatchNumber++}`;
      handles.set(handle as string, id);
      batches.set(id, {
        quantity: Number(values.quantity),
        expirationDate: values.expiration_date,
      });
      return { metaobjectUpsert: { metaobject: { id }, ...ok } };
    },
    SaveBatchList: ({ productId, value, compareDigest }) => {
      const product = products.get(productId as string)!;
      const digest = product.batchIds ? listDigest(product.batchIds) : null;
      if (compareDigest !== digest) {
        return {
          metafieldsSet: userError(
            "The metafield has been modified since it was loaded.",
            "STALE_OBJECT",
          ),
        };
      }
      product.batchIds = JSON.parse(value as string);
      return { metafieldsSet: ok };
    },
    DeleteBatch: ({ id }) => {
      if (!batches.delete(id as string)) {
        return {
          metaobjectDelete: userError("Record not found", "RECORD_NOT_FOUND"),
        };
      }
      return { metaobjectDelete: ok };
    },
  };

  const admin = {
    graphql: async (query: string, options?: { variables?: Variables }) => {
      const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
      calls.push(operation);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const remaining = failures.get(operation) ?? 0;
      if (remaining > 0) {
        failures.set(operation, remaining - 1);
        throw new Error(`Simulated network failure in ${operation}`);
      }
      const rejectionsLeft = rejections.get(operation) ?? 0;
      if (rejectionsLeft > 0) {
        rejections.set(operation, rejectionsLeft - 1);
        return Response.json({
          data: {
            [payloadField[operation]]: userError("Invalid value", "INVALID"),
          },
        });
      }
      const data = answer[operation](options?.variables ?? {});
      // The write landed, but the response never arrived
      const lostLeft = lostResponses.get(operation) ?? 0;
      if (lostLeft > 0) {
        lostResponses.set(operation, lostLeft - 1);
        throw new Error(`Simulated timeout after ${operation}`);
      }
      return Response.json({ data });
    },
  } as unknown as AdminApiContext;

  return {
    admin,
    calls,
    addProduct(
      productId: string,
      productBatches: Record<string, FakeBatch> | null,
    ) {
      if (productBatches) {
        for (const [id, batch] of Object.entries(productBatches)) {
          batches.set(id, { ...batch });
        }
      }
      products.set(productId, {
        batchIds: productBatches ? Object.keys(productBatches) : null,
        earliestExpirationDate: null,
      });
    },
    failNext(operation: string, times = 1) {
      failures.set(operation, times);
    },
    rejectNext(operation: string, times = 1) {
      rejections.set(operation, times);
    },
    loseResponseNext(operation: string, times = 1) {
      lostResponses.set(operation, times);
    },
    product: (productId: string) => products.get(productId),
    batch: (id: string) => batches.get(id),
    batchIdByHandle: (handle: string) => handles.get(handle),
    // Gives a stored batch the handle it was created under
    setHandle(id: string, handle: string) {
      handles.set(handle, id);
    },
    setProductHandle(productId: string, handle: string) {
      productHandles.set(productId, handle);
    },
    setInventory(productId: string, inventory: ProductInventory) {
      inventories.set(productId, inventory);
    },
    setQuantity(id: string, quantity: number) {
      batches.get(id)!.quantity = quantity;
    },
  };
}

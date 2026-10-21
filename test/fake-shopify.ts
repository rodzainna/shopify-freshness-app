import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

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

/**
 * An in-memory store answering the app's fulfillment GraphQL operations, so
 * tests can check what Shopify ends up holding after failures and retries.
 * `delayMs` makes every call take that long, so concurrent work overlaps.
 * It uses real timers, so it hangs under vi.useFakeTimers().
 */
export function fakeShopify({ delayMs = 0 } = {}) {
  const products = new Map<string, FakeProduct>();
  const batches = new Map<string, FakeBatch>();
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
  };

  const userError = (message: string, code: string) => ({
    userErrors: [{ field: ["id"], message, code }],
  });
  const ok = { userErrors: [] };

  const answer: Record<string, (variables: Variables) => unknown> = {
    GetShopTimezone: () => ({ shop: { ianaTimezone: "UTC" } }),
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
    setQuantity(id: string, quantity: number) {
      batches.get(id)!.quantity = quantity;
    },
  };
}

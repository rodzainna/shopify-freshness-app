import "@shopify/ui-extensions/preact";
import {
  type BatchFreshness,
  formatDaysRemaining,
  computeBatchFreshness,
  getShopToday,
  type FreshnessStatus,
} from "../../../shared/freshness";
import { Fragment, render } from "preact";
import { useState } from "preact/hooks";

interface PanelData {
  shop: { ianaTimezone: string };
  product: {
    freshnessBatches: {
      references: { nodes: FreshnessBatchNode[] };
    } | null;
  } | null;
}

export default async () => {
  const productId = shopify.data.selected[0].id;

  // One request for both: the shop's timezone and the product's saved batches
  const { data } = await shopify.query<PanelData>(
    `
    query GetPanelData($productId: ID!) {
      shop {
        ianaTimezone
      }
      product(id: $productId) {
        freshnessBatches: metafield(key: "freshness_batches") {
          references(first: 50) {
            nodes {
              ... on Metaobject {
                id
                handle
                quantity: field(key: "quantity") {
                  value
                }
                expirationDate: field(key: "expiration_date") {
                  value
                }
              }
            }
          }
        }
      }
    }
  `,
    { variables: { productId } },
  );

  // No metafield yet (product never saved) -> start with an empty list
  const savedBatches =
    data?.product?.freshnessBatches?.references.nodes.map(toPanelBatch) ?? [];

  render(
    <Extension
      timezone={data?.shop.ianaTimezone ?? "UTC"}
      initialBatches={savedBatches}
    />,
    document.body,
  );
};

interface PanelBatch {
  id: string;
  // metaobjectUpsert finds the batch by this, so it must stay the same between saves
  handle: string;
  quantity: number;
  expirationDate: string;
}

interface FreshnessBatchNode {
  id: string;
  handle: string;
  quantity: { value: string } | null;
  expirationDate: { value: string } | null;
}

// const MOCK_BATCHES: PanelBatch[] = [
//   { id: "1", quantity: 12, expirationDate: "2026-09-14" },
//   { id: "2", quantity: 5, expirationDate: "2026-09-08" },
//   { id: "3", quantity: 20, expirationDate: "2026-10-01" },
// ];

// s-date-field has a built-in 224px (14rem) min width, so on narrow blocks the
// status badge gets whatever is left and truncates. Accepted trade-off.
const ROW_COLUMNS =
  "@container (inline-size > 600px) 10rem 14rem 1fr auto, 5rem 14rem 1fr auto";

const STATUS_TONE: Record<FreshnessStatus, "success" | "warning" | "critical"> =
  {
    Fresh: "success",
    "Use Soon": "warning",
    Expired: "critical",
  };

function toPanelBatch(node: FreshnessBatchNode): PanelBatch {
  return {
    id: node.id,
    handle: node.handle,
    quantity: Number(node.quantity?.value ?? 0),
    expirationDate: node.expirationDate?.value ?? "",
  };
}

interface SaveBatchData {
  metaobjectUpsert: {
    metaobject: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  } | null;
}

// Creates the batch in Shopify, or updates it if its handle already exists.
// Returns the batch's Shopify ID.
async function saveBatch(batch: PanelBatch): Promise<string> {
  const { data, errors } = await shopify.query<SaveBatchData>(
    `
    mutation SaveBatch(
      $handle: String!
      $quantity: String!
      $expirationDate: String!
    ) {
      metaobjectUpsert(
        handle: { type: "$app:freshness_batch", handle: $handle }
        metaobject: {
          fields: [
            { key: "quantity", value: $quantity }
            { key: "expiration_date", value: $expirationDate }
          ]
        }
      ) {
        metaobject {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `,
    {
      variables: {
        handle: batch.handle,
        // Metaobject field values are always sent as strings
        quantity: String(batch.quantity),
        expirationDate: batch.expirationDate,
      },
    },
  );

  // errors = the request itself failed; userErrors = Shopify rejected the values
  const result = data?.metaobjectUpsert;
  const messages = [
    ...(errors ?? []).map((error) => error.message),
    ...(result?.userErrors ?? []).map((error) => error.message),
  ];

  if (messages.length > 0 || !result?.metaobject) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }

  return result.metaobject.id;
}

function getFreshness(
  expirationDate: string,
  today: string,
): BatchFreshness | null {
  if (!expirationDate) return null;

  try {
    return computeBatchFreshness(expirationDate, today);
  } catch {
    return null;
  }
}

function Extension({
  timezone,
  initialBatches,
}: {
  timezone: string;
  initialBatches: PanelBatch[];
}) {
  const { data } = shopify;
  console.log({ data });
  const today = getShopToday(timezone, new Date());

  const [batches, setBatches] = useState<PanelBatch[]>(initialBatches);
  const [saving, setSaving] = useState(false);

  async function saveBatches() {
    setSaving(true);
    try {
      // Save all rows at once, then swap in the Shopify IDs we got back
      const saved = await Promise.all(
        batches.map(async (batch) => ({
          ...batch,
          id: await saveBatch(batch),
        })),
      );
      setBatches(saved);
    } finally {
      setSaving(false);
    }
  }

  function updateBatch(id: string, changes: Partial<PanelBatch>) {
    setBatches((current) =>
      current.map((batch) =>
        batch.id === id ? { ...batch, ...changes } : batch,
      ),
    );
  }

  function removeBatch(id: string) {
    setBatches((current) => current.filter((batch) => batch.id !== id));
  }

  function addBatch() {
    // Not saved yet, so there's no Shopify ID. The UUID is the local id and
    // also becomes the handle Shopify stores the batch under on first save.
    const uuid = crypto.randomUUID();

    setBatches((current) => [
      ...current,
      {
        id: uuid,
        handle: uuid,
        quantity: 0,
        expirationDate: "",
      },
    ]);
  }

  return (
    <s-admin-block
      heading="Freshness batches"
      collapsedSummary={`${batches.length} ${batches.length === 1 ? "batch" : "batches"}`}
    >
      <s-stack direction="block" gap="base">
        {batches.length > 0 && (
          <s-query-container>
            <s-grid
              gridTemplateColumns={ROW_COLUMNS}
              columnGap="base"
              rowGap="small-200"
              alignItems="center"
            >
              <s-text>Quantity</s-text>
              <s-text>Expiry Date *</s-text>
              <s-text>Status</s-text>
              <s-text />
              {batches.map((batch) => {
                const freshness = getFreshness(batch.expirationDate, today);

                return (
                  <Fragment key={batch.id}>
                    <s-number-field
                      label="Quantity"
                      labelAccessibilityVisibility="exclusive"
                      value={String(batch.quantity)}
                      onChange={(event) =>
                        updateBatch(batch.id, {
                          quantity: Number(event.currentTarget.value),
                        })
                      }
                    />
                    <s-date-field
                      label="Expiry Date"
                      labelAccessibilityVisibility="exclusive"
                      value={batch.expirationDate}
                      required
                      onChange={(event) =>
                        updateBatch(batch.id, {
                          expirationDate: event.currentTarget.value,
                        })
                      }
                    />
                    {freshness ? (
                      <s-badge tone={STATUS_TONE[freshness.status]}>
                        {formatDaysRemaining(freshness.daysRemaining)}
                      </s-badge>
                    ) : (
                      <s-badge tone="info">No expiry date</s-badge>
                    )}
                    <s-button
                      icon="delete"
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel="Remove batch"
                      onClick={() => removeBatch(batch.id)}
                    />
                  </Fragment>
                );
              })}
            </s-grid>
          </s-query-container>
        )}
        <s-stack direction="inline" gap="base">
          <s-button icon="plus" onClick={addBatch}>
            Add batch
          </s-button>
          <s-button
            variant="primary"
            loading={saving}
            disabled={batches.length === 0}
            onClick={saveBatches}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}

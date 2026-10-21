import "@shopify/ui-extensions/preact";
import {
  type BatchFreshness,
  formatDaysRemaining,
  computeBatchFreshness,
  getEarliestExpirationDate,
  getShopToday,
  FRESHNESS_TONE,
} from "../../../shared/freshness";
import {
  type ProductInventory,
  formatInventoryMismatch,
  formatUnbatchedStock,
  getInventoryMismatch,
  getUnbatchedStock,
  totalBatchQuantity,
} from "../../../shared/inventory";
import { collectErrorMessages } from "../../../shared/graphql-errors";
import {
  MAX_BATCHES,
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  type SaveProductFreshnessData,
  type UserErrorsPayload,
  isReadableBatch,
  saveProductFreshnessVariables,
} from "../../../shared/product-metafields";
import { applySavedIds, failedItems } from "../../../shared/settled";
import {
  MAX_QUANTITY,
  hasErrors,
  validateBatch,
} from "../../../shared/validation";
import { render } from "preact";
import { useRef, useState } from "preact/hooks";

interface PanelProduct extends ProductInventory {
  freshnessBatches: {
    references: {
      // null for a batch that no longer resolves
      nodes: (FreshnessBatchNode | null)[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

interface PanelData {
  shop: { ianaTimezone: string };
  product: PanelProduct | null;
}

interface LoadedPanelData {
  shop: PanelData["shop"];
  product: PanelProduct;
  batches: PanelBatch[];
}

export default async () => {
  await mountPanel(shopify.data.selected[0].id);
};

// A load failure that retrying can't fix, so the panel offers no retry
class PermanentLoadError extends Error {}

async function mountPanel(productId: string) {
  let data: LoadedPanelData;
  try {
    data = await loadPanelData(productId);
  } catch (error) {
    // Never fall back to an empty editor: saving it would unlink every batch
    render(
      <LoadError
        message={errorMessage(error)}
        onRetry={
          error instanceof PermanentLoadError
            ? undefined
            : () => mountPanel(productId)
        }
      />,
      document.body,
    );
    return;
  }

  render(
    <Extension
      productId={productId}
      timezone={data.shop.ianaTimezone}
      initialBatches={data.batches}
      inventory={data.product}
    />,
    document.body,
  );
}

// One request for the shop's timezone, the product's stock and its batches
async function loadPanelData(productId: string): Promise<LoadedPanelData> {
  const { data, errors } = await shopify.query<PanelData>(
    `
    query GetPanelData($productId: ID!, $maxBatches: Int!) {
      shop {
        ianaTimezone
      }
      product(id: $productId) {
        tracksInventory
        totalInventory
        freshnessBatches: metafield(key: "freshness_batches") {
          references(first: $maxBatches) {
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
            pageInfo {
              hasNextPage
            }
          }
        }
      }
    }
  `,
    { variables: { productId, maxBatches: MAX_BATCHES } },
  );

  // Partial data counts as a failure: a missing batch list would look empty
  if (errors?.length) {
    throw new Error(collectErrorMessages(errors).join("; "));
  }
  if (!data?.product) {
    throw new PermanentLoadError("Product not found");
  }

  // Saving a partial list would unlink the batches that didn't load
  if (data.product.freshnessBatches?.references.pageInfo.hasNextPage) {
    throw new PermanentLoadError(
      `This product has more than ${MAX_BATCHES} batches.`,
    );
  }

  // No metafield yet (product never saved) -> start with an empty list
  const nodes = data.product.freshnessBatches?.references.nodes ?? [];
  // Saving a list with a batch that didn't resolve would unlink it
  if (!nodes.every(isReadableBatch)) {
    throw new Error(
      "Some batches couldn't be read, so editing is turned off to keep them linked. Try again later.",
    );
  }

  return {
    shop: data.shop,
    product: data.product,
    batches: nodes.map(toPanelBatch),
  };
}

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

// s-date-field has a built-in 224px (14rem) min width, so on narrow blocks the
// status badge gets whatever is left and truncates. Accepted trade-off.
const ROW_COLUMNS =
  "@container (inline-size > 600px) 10rem 14rem 1fr auto, 5rem 14rem 1fr auto";

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
  const messages = collectErrorMessages(errors, result?.userErrors);

  if (messages.length > 0 || !result?.metaobject) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }

  return result.metaobject.id;
}

// Points the product at its saved batches and updates the date the storefront
// reads. See planProductMetafieldWrites for what gets set vs deleted.
async function saveProductFreshness(
  productId: string,
  batchIds: string[],
  earliestExpirationDate: string | null,
): Promise<void> {
  const { data, errors } = await shopify.query<SaveProductFreshnessData>(
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    {
      variables: saveProductFreshnessVariables(
        productId,
        batchIds,
        earliestExpirationDate,
      ),
    },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metafieldsSet?.userErrors,
    data?.metafieldsDelete?.userErrors,
  );

  if (messages.length > 0) {
    throw new Error(`Saving product freshness failed: ${messages.join("; ")}`);
  }
}

interface DeleteBatchData {
  metaobjectDelete: UserErrorsPayload | null;
}

async function deleteBatch(id: string): Promise<void> {
  const { data, errors } = await shopify.query<DeleteBatchData>(
    `
    mutation DeleteBatch($id: ID!) {
      metaobjectDelete(id: $id) {
        userErrors {
          field
          message
        }
      }
    }
  `,
    { variables: { id } },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metaobjectDelete?.userErrors,
  );

  if (messages.length > 0) {
    throw new Error(`Deleting batch failed: ${messages.join("; ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  // State updates on the next render, so a double-click could start two loads
  const inFlight = useRef(false);

  async function retry() {
    if (!onRetry || inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // Only matters if the retry failed too; on success this is unmounted
      inFlight.current = false;
      setRetrying(false);
    }
  }

  return (
    <s-admin-block heading="Freshness batches">
      <s-banner heading="Batches couldn't be loaded" tone="critical">
        {message}
        {onRetry && (
          <s-button
            slot="secondary-actions"
            variant="secondary"
            loading={retrying}
            onClick={retry}
          >
            Try again
          </s-button>
        )}
      </s-banner>
    </s-admin-block>
  );
}

function Extension({
  productId,
  timezone,
  initialBatches,
  inventory,
}: {
  productId: string;
  timezone: string;
  initialBatches: PanelBatch[];
  inventory: ProductInventory;
}) {
  const today = getShopToday(timezone, new Date());

  const [batches, setBatches] = useState<PanelBatch[]>(initialBatches);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{
    tone: "critical" | "warning";
    heading: string;
    message: string;
  } | null>(null);
  // Saved batches the merchant removed; their metaobjects go on the next save
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  // Errors stay hidden until the first save attempt, then update live
  const [showErrors, setShowErrors] = useState(false);

  async function saveBatches() {
    setSaveError(null);
    setShowErrors(true);
    if (batches.some((batch) => hasErrors(validateBatch(batch)))) return;

    setSaving(true);
    try {
      // Rows that saved keep their Shopify ID even if another row failed,
      // so removing one later still deletes its metaobject
      const upserts = await Promise.allSettled(batches.map(saveBatch));
      const { items: saved, errors } = applySavedIds(batches, upserts);
      setBatches(saved);
      if (errors.length > 0) throw errors[0];

      // Only link the batches once every one of them saved, so the product
      // never points at a batch that doesn't exist
      await saveProductFreshness(
        productId,
        saved.map((batch) => batch.id),
        getEarliestExpirationDate(saved),
      );
      // Rows added after a successful save start without errors again
      setShowErrors(false);

      // Delete last, so a failure can't leave the product referencing a
      // missing batch. Failed deletes stay queued for the next save.
      const deletes = await Promise.allSettled(removedIds.map(deleteBatch));
      setRemovedIds(failedItems(removedIds, deletes));

      const firstFailure = deletes.find(
        (result) => result.status === "rejected",
      );
      if (firstFailure) {
        setSaveError({
          tone: "warning",
          heading: "Saved, but a removed batch wasn't deleted",
          message: errorMessage(firstFailure.reason),
        });
      }
    } catch (error) {
      setSaveError({
        tone: "critical",
        heading: "Batches weren't saved",
        message: errorMessage(error),
      });
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

    // Rows that were never saved only exist locally; nothing to delete
    if (id.startsWith("gid://")) {
      setRemovedIds((current) =>
        current.includes(id) ? current : [...current, id],
      );
    }
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

  const mismatch = getInventoryMismatch(batches, inventory);
  // Only once the product has batches; otherwise it isn't freshness-tracked yet
  const unbatched =
    batches.length > 0
      ? getUnbatchedStock(totalBatchQuantity(batches), inventory)
      : null;

  return (
    <s-admin-block
      heading="Freshness batches"
      collapsedSummary={`${batches.length} ${batches.length === 1 ? "batch" : "batches"}`}
    >
      <s-stack direction="block" gap="base">
        {saveError && (
          <s-banner heading={saveError.heading} tone={saveError.tone}>
            {saveError.message}
          </s-banner>
        )}
        {mismatch && (
          <s-banner heading="More in batches than in stock" tone="warning">
            {formatInventoryMismatch(mismatch)} Check the quantities or update
            the product inventory.
          </s-banner>
        )}
        {unbatched !== null && (
          <s-text color="subdued">{formatUnbatchedStock(unbatched)}</s-text>
        )}
        {batches.length > 0 && (
          <s-query-container>
            <s-stack direction="block" gap="small-200">
              <s-grid gridTemplateColumns={ROW_COLUMNS} columnGap="base">
                <s-text>Quantity</s-text>
                <s-text>Expiry Date *</s-text>
                <s-text>Status</s-text>
              </s-grid>
              {batches.map((batch) => {
                const freshness = getFreshness(batch.expirationDate, today);
                const errors = showErrors ? validateBatch(batch) : {};

                // One grid per row: mounting several keyed Fragments into a
                // shared grid at once interleaved their cells. The fixed
                // column template keeps every row's columns aligned.
                // Keyed by handle, which survives a save; id changes to the
                // Shopify GID on first save and would remount the row.
                return (
                  <s-grid
                    key={batch.handle}
                    gridTemplateColumns={ROW_COLUMNS}
                    columnGap="base"
                    alignItems="center"
                  >
                    <s-number-field
                      label="Quantity"
                      labelAccessibilityVisibility="exclusive"
                      value={String(batch.quantity)}
                      min={1}
                      max={MAX_QUANTITY}
                      step={1}
                      error={errors.quantity}
                      disabled={saving}
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
                      error={errors.expirationDate}
                      disabled={saving}
                      onChange={(event) =>
                        updateBatch(batch.id, {
                          expirationDate: event.currentTarget.value,
                        })
                      }
                    />
                    {freshness ? (
                      <s-badge tone={FRESHNESS_TONE[freshness.status]}>
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
                      disabled={saving}
                      onClick={() => removeBatch(batch.id)}
                    />
                  </s-grid>
                );
              })}
            </s-stack>
          </s-query-container>
        )}
        <s-stack direction="inline" gap="base">
          <s-button icon="plus" disabled={saving} onClick={addBatch}>
            Add batch
          </s-button>
          <s-button
            variant="primary"
            loading={saving}
            disabled={batches.length === 0 && removedIds.length === 0}
            onClick={saveBatches}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}

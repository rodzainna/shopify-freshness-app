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
  compareStock,
  formatUnbatchedStock,
  getInventoryMismatch,
} from "../../../shared/inventory";
import { collectErrorMessages } from "../../../shared/graphql-errors";
import {
  listLanded,
  planPanelSave,
  unlinkedCreates,
} from "../../../shared/panel-save";
import {
  MAX_BATCHES,
  SAVE_BATCH_LIST_MUTATION,
  SAVE_PRODUCT_FRESHNESS_MUTATION,
  SET_BATCH_FIELDS_MUTATION,
  type SaveBatchListData,
  type SaveProductFreshnessData,
  type SetBatchFieldsData,
  UPSERT_BATCH_MUTATION,
  type UpsertBatchData,
  type UserErrorsPayload,
  isReadableBatch,
  saveBatchListVariables,
  saveEarliestDateVariables,
  saveProductFreshnessVariables,
  upsertBatchVariables,
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
    compareDigest: string;
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
  // null when the product has no batch list yet
  listDigest: string | null;
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
      // A reload remounts the editor, so no unsaved state carries over
      key={Date.now()}
      productId={productId}
      timezone={data.shop.ianaTimezone}
      initialBatches={data.batches}
      initialListDigest={data.listDigest}
      inventory={data.product}
      onReload={() => mountPanel(productId)}
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
          compareDigest
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
    listDigest: data.product.freshnessBatches?.compareDigest ?? null,
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

// Creates the batch in Shopify, or updates it if its handle already exists.
// Returns the batch's Shopify ID.
async function saveBatch(batch: PanelBatch): Promise<string> {
  const { data, errors } = await shopify.query<UpsertBatchData>(
    UPSERT_BATCH_MUTATION,
    { variables: upsertBatchVariables(batch) },
  );

  // errors = the request itself failed; userErrors = Shopify rejected the values
  const result = data?.metaobjectUpsert;
  const messages = collectErrorMessages(errors, result?.userErrors);

  if (messages.length > 0 || !result?.metaobject) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }

  return result.metaobject.id;
}

// The list changed since the panel loaded it, so it wasn't overwritten
class BatchListChangedError extends Error {}

// Writes the list only if it's still the one loaded; returns its new digest
async function saveBatchList(
  productId: string,
  batchIds: string[],
  compareDigest: string | null,
): Promise<string | null> {
  const { data, errors } = await shopify.query<SaveBatchListData>(
    SAVE_BATCH_LIST_MUTATION,
    { variables: saveBatchListVariables(productId, batchIds, compareDigest) },
  );

  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.some(({ code }) => code === "STALE_OBJECT")) {
    throw new BatchListChangedError();
  }
  const messages = collectErrorMessages(errors, userErrors);
  if (messages.length > 0) {
    throw new Error(`Saving the batch list failed: ${messages.join("; ")}`);
  }

  // Without a digest the next save reports "changed" rather than overwriting
  return data?.metafieldsSet?.metafields?.[0]?.compareDigest ?? null;
}

// Updates a saved batch by id, so one deleted elsewhere fails instead of
// coming back unlinked
async function writeBatch({
  id,
  quantity,
  expirationDate,
}: PanelBatch): Promise<void> {
  const { data, errors } = await shopify.query<SetBatchFieldsData>(
    SET_BATCH_FIELDS_MUTATION,
    {
      variables: {
        id,
        metaobject: {
          fields: [
            { key: "quantity", value: String(quantity) },
            { key: "expiration_date", value: expirationDate },
          ],
        },
      },
    },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metaobjectUpdate?.userErrors,
  );
  if (messages.length > 0) {
    throw new Error(`Saving batch failed: ${messages.join("; ")}`);
  }
}

// Sets or deletes the product's freshness metafields; see
// planProductMetafieldWrites for which
async function saveFreshnessMetafields(
  variables: ReturnType<typeof saveProductFreshnessVariables>,
  action: string,
): Promise<void> {
  const { data, errors } = await shopify.query<SaveProductFreshnessData>(
    SAVE_PRODUCT_FRESHNESS_MUTATION,
    { variables },
  );

  const messages = collectErrorMessages(
    errors,
    data?.metafieldsSet?.userErrors,
    data?.metafieldsDelete?.userErrors,
  );
  if (messages.length > 0) {
    throw new Error(`${action} failed: ${messages.join("; ")}`);
  }
}

// What Shopify holds now, after a write that may or may not have landed;
// null when that can't be read either
async function readCurrent(productId: string): Promise<LoadedPanelData | null> {
  return loadPanelData(productId).catch(() => null);
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

interface SaveNotice {
  tone: "critical" | "warning";
  heading: string;
  message: string;
  // The list changed elsewhere, so the only way forward is a reload
  reload?: boolean;
}

function Extension({
  productId,
  timezone,
  initialBatches,
  initialListDigest,
  inventory,
  onReload,
}: {
  productId: string;
  timezone: string;
  initialBatches: PanelBatch[];
  initialListDigest: string | null;
  inventory: ProductInventory;
  onReload: () => Promise<void>;
}) {
  const today = getShopToday(timezone, new Date());

  const [batches, setBatches] = useState<PanelBatch[]>(initialBatches);
  // What Shopify holds, so a save writes only what changed since
  const [saved, setSaved] = useState<PanelBatch[]>(initialBatches);
  const [listDigest, setListDigest] = useState(initialListDigest);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveNotice | null>(null);
  // Saved batches the merchant removed; their metaobjects go on the next save
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  // Errors stay hidden until the first save attempt, then update live
  const [showErrors, setShowErrors] = useState(false);

  async function saveBatches() {
    setSaveError(null);
    setShowErrors(true);
    if (batches.some((batch) => hasErrors(validateBatch(batch)))) return;

    const listChangedNotice: SaveNotice = {
      tone: "critical",
      heading: "Batches weren't saved",
      message:
        "These batches changed since you opened them, so nothing was saved. Reload to see the current batches.",
      reload: true,
    };

    setSaving(true);
    try {
      const plan = planPanelSave(saved, batches);

      // Created by handle, so a retry reuses them instead of duplicating. Rows
      // that saved keep their id even if another failed, so removing one
      // later still deletes it.
      const creates = await Promise.allSettled(plan.creates.map(saveBatch));
      const created = applySavedIds(plan.creates, creates);
      const idByHandle = new Map(
        created.items.map((row) => [row.handle, row.id]),
      );
      const rows = batches.map((row) => ({
        ...row,
        id: idByHandle.get(row.handle) ?? row.id,
      }));
      setBatches(rows);
      if (created.errors.length > 0) throw created.errors[0];
      const newIds = created.items.map((row) => row.id);

      if (plan.listChanged && rows.length === 0) {
        // Deletes take no digest, so check the list is still the one loaded
        const current = await loadPanelData(productId);
        if (current.listDigest !== listDigest) {
          setSaveError(listChangedNotice);
          return;
        }
        await saveFreshnessMetafields(
          saveProductFreshnessVariables(productId, [], null),
          "Removing the batch list",
        );
        setListDigest(null);
      } else if (plan.listChanged) {
        const ids = rows.map((row) => row.id);
        try {
          setListDigest(await saveBatchList(productId, ids, listDigest));
        } catch (error) {
          const current = await readCurrent(productId);
          const linkedIds = current
            ? new Set(current.batches.map((batch) => batch.id))
            : null;
          if (error instanceof BatchListChangedError) {
            await Promise.allSettled(
              unlinkedCreates(newIds, linkedIds).map(deleteBatch),
            );
            setSaveError(listChangedNotice);
            return;
          }
          // A write that timed out may still have landed
          if (!current || !listLanded(ids, linkedIds)) throw error;
          setListDigest(current.listDigest);
        }
      }

      const updates = await Promise.allSettled(plan.updates.map(writeBatch));
      const updated = new Set(
        plan.updates
          .filter((_, index) => updates[index].status === "fulfilled")
          .map((row) => row.id),
      );
      const savedById = new Map(saved.map((row) => [row.id, row]));
      // Rows whose update failed still hold their old values in Shopify
      setSaved(
        rows.map((row) =>
          savedById.has(row.id) && !updated.has(row.id)
            ? savedById.get(row.id)!
            : row,
        ),
      );

      // The list is saved by now, so later problems are reported as partial
      const updateFailure = updates.find(
        (result) => result.status === "rejected",
      );
      let problem: SaveNotice | undefined = updateFailure && {
        tone: "critical",
        heading: "Some batches weren't saved",
        message: errorMessage(updateFailure.reason),
      };
      if (rows.length > 0) {
        try {
          // From what Shopify holds now, so a batch sold out or removed
          // elsewhere can't set the date
          const current = await loadPanelData(productId);
          await saveFreshnessMetafields(
            saveEarliestDateVariables(
              productId,
              getEarliestExpirationDate(current.batches),
            ),
            "Saving the earliest date",
          );
        } catch (error) {
          problem ??= {
            tone: "warning",
            heading: "Saved, but the earliest expiry date didn't update",
            message: errorMessage(error),
          };
        }
      }
      // Rows added after a successful save start without errors again
      if (!updateFailure) setShowErrors(false);

      // Delete last, so a failure can't leave the product referencing a
      // missing batch. Failed deletes stay queued for the next save.
      const deletes = await Promise.allSettled(removedIds.map(deleteBatch));
      setRemovedIds(failedItems(removedIds, deletes));

      const deleteFailure = deletes.find(
        (result) => result.status === "rejected",
      );
      if (deleteFailure) {
        problem ??= {
          tone: "warning",
          heading: "Saved, but a removed batch wasn't deleted",
          message: errorMessage(deleteFailure.reason),
        };
      }
      if (problem) setSaveError(problem);
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
  const unbatched = compareStock(batches, inventory).unbatchedStock;

  return (
    <s-admin-block
      heading="Freshness batches"
      collapsedSummary={`${batches.length} ${batches.length === 1 ? "batch" : "batches"}`}
    >
      <s-stack direction="block" gap="base">
        {saveError && (
          <s-banner heading={saveError.heading} tone={saveError.tone}>
            {saveError.message}
            {saveError.reload && (
              <s-button
                slot="secondary-actions"
                variant="secondary"
                onClick={onReload}
              >
                Reload
              </s-button>
            )}
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
                <s-text>Expiry date *</s-text>
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
                      label="Expiry date"
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

import "@shopify/ui-extensions/preact";
import {
  batchFreshnessOrNull,
  formatDaysRemaining,
  getEarliestExpirationDate,
  getShopToday,
  showsSoldOut,
  FRESHNESS_TONE,
} from "../../../shared/freshness";
import {
  type ProductInventory,
  formatInventoryMismatch,
  compareStock,
  formatUnbatchedStock,
  getInventoryMismatch,
} from "../../../shared/inventory";
import {
  listLanded,
  planPanelSave,
  unlinkedCreates,
} from "../../../shared/panel-save";
import {
  saveEarliestDateVariables,
  saveProductFreshnessVariables,
} from "../../../shared/product-metafields";
import { applySavedIds, failedItems } from "../../../shared/settled";
import { plural } from "../../../shared/plural";
import {
  MAX_QUANTITY,
  hasErrors,
  validateBatch,
} from "../../../shared/validation";
import {
  BatchListChangedError,
  type LoadedPanelData,
  type PanelBatch,
  PermanentLoadError,
  deleteBatch,
  loadPanelData,
  readCurrent,
  saveBatch,
  saveBatchList,
  saveFreshnessMetafields,
  writeBatch,
} from "./panel-api";
import { render } from "preact";
import { useRef, useState } from "preact/hooks";

export default async () => {
  await mountPanel(shopify.data.selected[0].id);
};

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

// s-date-field has a built-in 224px (14rem) min width, so on narrow blocks the
// status badge gets whatever is left and truncates. Accepted trade-off.
const ROW_COLUMNS =
  "@container (inline-size > 600px) 10rem 14rem 1fr auto, 5rem 14rem 1fr auto";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  // As of the last load or save
  const storedById = new Map(saved.map((row) => [row.id, row]));
  const mismatch = getInventoryMismatch(batches, inventory);
  const unbatched = compareStock(batches, inventory).unbatchedStock;

  return (
    <s-admin-block
      heading="Freshness batches"
      collapsedSummary={`${batches.length} ${plural(batches.length, "batch", "batches")}`}
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
                {/* Visual only: each field and badge reads on its own */}
                <s-text accessibilityVisibility="hidden">Quantity *</s-text>
                <s-text accessibilityVisibility="hidden">Expiry date *</s-text>
                <s-text accessibilityVisibility="hidden">Status</s-text>
              </s-grid>
              {batches.map((batch) => {
                const freshness = batchFreshnessOrNull(
                  batch.expirationDate,
                  today,
                );
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
                      required
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
                    {showsSoldOut(storedById.get(batch.id), batch) ? (
                      <s-badge>Sold out</s-badge>
                    ) : freshness ? (
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

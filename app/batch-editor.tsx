import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import type { BatchEditResult } from "./batch-edit.server";
import {
  type EditableBatch,
  MAX_NEW_BATCHES_PER_SAVE,
  type NewBatch,
  maxNewBatches,
  validateBatchEdit,
} from "../shared/batch-edit";
import {
  type Batch,
  FRESHNESS_TONE,
  computeBatchFreshness,
  formatDaysRemaining,
  isCalendarDate,
} from "../shared/freshness";
import {
  type ProductInventory,
  compareStock,
  matchesStock,
} from "../shared/inventory";
import { MAX_BATCHES } from "../shared/product-metafields";
import {
  MAX_QUANTITY,
  type BatchErrors,
  hasErrors,
} from "../shared/validation";

export const BATCH_EDITOR_ID = "batch-editor";

// One line per batch: quantity, date (s-date-field is at least 14rem), status, remove
const ROW_COLUMNS = "8rem 14rem 1fr auto";

export interface EditTarget {
  productId: string;
  title: string;
  // Picks the heading; the loaded batches decide the form
  hasBatches: boolean;
  // Changes on every open, so reopening the same product loads it again
  openedAt: number;
}

type Loaded =
  | { batches: EditableBatch[]; inventory: ProductInventory | null }
  | { message: string };
type Notice = { tone: "warning" | "critical"; message: string };

/** One modal for the dashboard, opened by a row's Edit or Add batches button. */
export function BatchEditor({
  target,
  today,
}: {
  target: EditTarget | null;
  today: string;
}) {
  const shopify = useAppBridge();
  const modal = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const load = useFetcher<Loaded>();
  const save = useFetcher<BatchEditResult | { message: string }>();

  // What the modal opened with, and the form's values
  const [opened, setOpened] = useState<EditableBatch[]>([]);
  const [edited, setEdited] = useState<EditableBatch[]>([]);
  const [added, setAdded] = useState<NewBatch[]>([]);
  const [errors, setErrors] = useState<Record<string, BatchErrors>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  // The current product's batches loaded, so rows can be added
  const [ready, setReady] = useState(false);
  // Read with the batches; a save doesn't change it
  const [inventory, setInventory] = useState<ProductInventory | null>(null);
  // Remounts the fields, since their value attributes only set a starting value
  const [formVersion, setFormVersion] = useState(0);

  function reset(batches: EditableBatch[]) {
    setOpened(batches);
    setEdited(batches);
    setAdded([]);
    setErrors({});
    setFormVersion((version) => version + 1);
  }

  // Each open, load result and save result is handled once, however often this re-renders
  const handled = useRef<{
    target?: unknown;
    loaded?: unknown;
    saved?: unknown;
  }>({});
  // The product the last save was for, so its result can't land on another
  const savedFor = useRef<{
    productId: string;
    edited: EditableBatch[];
    added: NewBatch[];
  }>();

  useEffect(() => {
    if (!target || handled.current.target === target) return;
    handled.current.target = target;
    setNotice(null);
    setReady(false);
    setInventory(null);
    reset([]);
    load.load(`/app/batches?productId=${encodeURIComponent(target.productId)}`);
  }, [target, load]);

  useEffect(() => {
    const loaded = load.data;
    if (load.state !== "idle" || !loaded || handled.current.loaded === loaded) {
      return;
    }
    handled.current.loaded = loaded;
    if ("batches" in loaded) {
      reset(loaded.batches);
      setInventory(loaded.inventory);
      setReady(true);
      // A product without batches opens with one row to fill in
      if (loaded.batches.length === 0) setAdded([newBatch()]);
    } else setNotice({ tone: "critical", message: loaded.message });
  }, [load.state, load.data]);

  useEffect(() => {
    const result = save.data;
    if (save.state !== "idle" || !result || handled.current.saved === result) {
      return;
    }
    handled.current.saved = result;
    const sent = savedFor.current;
    if (!sent || sent.productId !== target?.productId) return;
    if (!("kind" in result)) {
      setNotice({ tone: "critical", message: result.message });
      return;
    }
    switch (result.kind) {
      case "invalid":
        setErrors(result.errors);
        return;
      case "unavailable":
        setNotice({ tone: "critical", message: result.message });
        return;
      case "changed":
        // New rows go too: a save whose response was lost may have listed them
        reset(result.batches);
        setNotice({
          tone: "warning",
          message:
            "These batches changed since you opened them, so nothing was saved. They've been reloaded; make your changes again.",
        });
        return;
      case "unchanged":
        modal.current?.hideOverlay();
        return;
      case "saved": {
        const problems = saveProblems(
          result.failed.length,
          result.failedNew.length,
          result.dateFailed,
        );
        if (!problems) {
          shopify.toast.show("Batches saved");
          modal.current?.hideOverlay();
          return;
        }
        // Start from what Shopify holds, keeping the edits that didn't save
        reset(result.batches);
        setEdited(
          result.batches.map((batch) =>
            result.failed.includes(batch.id)
              ? (sent.edited.find(({ id }) => id === batch.id) ?? batch)
              : batch,
          ),
        );
        setAdded(
          sent.added.filter(({ handle }) => result.failedNew.includes(handle)),
        );
        setNotice({ tone: "warning", message: problems });
      }
    }
  }, [save.state, save.data, shopify, target]);

  function update(id: string, change: Partial<EditableBatch>) {
    setEdited((batches) =>
      batches.map((batch) =>
        batch.id === id ? { ...batch, ...change } : batch,
      ),
    );
  }

  function addRow() {
    setAdded((batches) => [...batches, newBatch()]);
  }

  function updateNew(handle: string, change: Partial<NewBatch>) {
    setAdded((batches) =>
      batches.map((batch) =>
        batch.handle === handle ? { ...batch, ...change } : batch,
      ),
    );
  }

  function removeNew(handle: string) {
    setAdded((batches) => batches.filter((batch) => batch.handle !== handle));
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== handle),
      ),
    );
  }

  function submit() {
    if (!target) return;
    const found = validateBatchEdit(edited, added);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return;
    savedFor.current = { productId: target.productId, edited, added };
    save.submit(
      { productId: target.productId, opened, edited, added },
      { method: "post", action: "/app/batches", encType: "application/json" },
    );
  }

  const loading = load.state !== "idle";
  const saving = save.state !== "idle";
  const rowCount = edited.length + added.length;
  const atAddLimit = added.length >= maxNewBatches(edited.length);
  // The dashboard row may be stale, so loaded batches decide once they're in
  const hasBatches = ready ? opened.length > 0 : target?.hasBatches !== false;
  const verb = hasBatches ? "Edit" : "Add";

  return (
    <s-modal
      ref={modal}
      id={BATCH_EDITOR_ID}
      heading={target ? `${verb} batches: ${target.title}` : `${verb} batches`}
    >
      <s-stack gap="base">
        {notice && <s-banner tone={notice.tone}>{notice.message}</s-banner>}
        {loading && <s-spinner accessibilityLabel="Loading batches" />}
        <s-stack key={formVersion} gap="small-200">
          {rowCount > 0 && (
            <s-grid gridTemplateColumns={ROW_COLUMNS} columnGap="base">
              <s-text>Quantity</s-text>
              <s-text>Expiry date</s-text>
              <s-text>Status</s-text>
            </s-grid>
          )}
          {edited.map((batch) => (
            <BatchRow
              key={batch.id}
              batch={batch}
              errors={errors[batch.id]}
              today={today}
              disabled={saving}
              onChange={(change) => update(batch.id, change)}
            />
          ))}
          {added.map((batch, index) => (
            <BatchRow
              key={batch.handle}
              batch={batch}
              errors={errors[batch.handle]}
              today={today}
              disabled={saving}
              onChange={(change) => updateNew(batch.handle, change)}
              onRemove={() => removeNew(batch.handle)}
              removeLabel={`Remove new batch ${index + 1}`}
            />
          ))}
        </s-stack>
        {ready && inventory && (
          <StockSummary
            // Rows with no quantity yet don't hide the unbatched count
            batches={[...edited, ...added].filter(
              ({ quantity }) => !Number.isNaN(quantity),
            )}
            inventory={inventory}
          />
        )}
        {ready && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-button
              icon="plus"
              disabled={saving || atAddLimit || undefined}
              onClick={addRow}
            >
              Add batch
            </s-button>
            {atAddLimit && (
              <s-text color="subdued">{addLimitNote(edited.length)}</s-text>
            )}
          </s-stack>
        )}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        loading={saving || undefined}
        disabled={loading || rowCount === 0 || undefined}
        onClick={submit}
      >
        Save
      </s-button>
      <s-button
        slot="secondary-actions"
        commandFor={BATCH_EDITOR_ID}
        command="--hide"
        disabled={saving || undefined}
      >
        Cancel
      </s-button>
    </s-modal>
  );
}

// The dashboard's In batches flags, live as the form changes
function StockSummary({
  batches,
  inventory,
}: {
  batches: Batch[];
  inventory: ProductInventory;
}) {
  const comparison = compareStock(batches, inventory);
  const { batchTotal, uncountedBatches, overStock, unbatchedStock } =
    comparison;
  const stock = inventory.tracksInventory
    ? `Stock ${inventory.totalInventory}`
    : "Stock not tracked";
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-text>
        {stock} · In batches {batchTotal}
      </s-text>
      {uncountedBatches > 0 && (
        <s-text color="subdued">({uncountedBatches} not counted)</s-text>
      )}
      {overStock !== null && <s-badge tone="warning">{overStock} over</s-badge>}
      {unbatchedStock !== null && (
        <s-badge tone="info">{unbatchedStock} unbatched</s-badge>
      )}
      {matchesStock(comparison, inventory, batches.length) && (
        <s-badge tone="success">Matches stock</s-badge>
      )}
    </s-stack>
  );
}

function addLimitNote(existing: number): string {
  return MAX_BATCHES - existing <= MAX_NEW_BATCHES_PER_SAVE
    ? `A product can have at most ${MAX_BATCHES} batches.`
    : `Save these ${MAX_NEW_BATCHES_PER_SAVE} first to add more.`;
}

function newBatch(): NewBatch {
  // NaN leaves the quantity field empty
  return { handle: crypto.randomUUID(), quantity: NaN, expirationDate: "" };
}

function BatchRow({
  batch,
  errors = {},
  today,
  disabled,
  onChange,
  onRemove,
  removeLabel,
}: {
  batch: Batch;
  errors?: BatchErrors;
  today: string;
  disabled: boolean;
  onChange: (change: Partial<Batch>) => void;
  // Only new rows; removing a saved batch is left to the product panel
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const freshness = isCalendarDate(batch.expirationDate)
    ? computeBatchFreshness(batch.expirationDate, today)
    : null;
  return (
    <s-grid
      gridTemplateColumns={ROW_COLUMNS}
      columnGap="base"
      // A field's error text makes it taller, so then the badge stays at the top
      alignItems={hasErrors(errors) ? "start" : "center"}
    >
      <s-number-field
        label="Quantity"
        labelAccessibilityVisibility="exclusive"
        value={Number.isNaN(batch.quantity) ? "" : String(batch.quantity)}
        min={1}
        max={MAX_QUANTITY}
        step={1}
        error={errors.quantity}
        disabled={disabled || undefined}
        onInput={({ currentTarget: { value } }) =>
          onChange({ quantity: value === "" ? NaN : Number(value) })
        }
      />
      <s-date-field
        label="Expiry date"
        labelAccessibilityVisibility="exclusive"
        value={batch.expirationDate}
        error={errors.expirationDate}
        disabled={disabled || undefined}
        onChange={(event) =>
          onChange({ expirationDate: event.currentTarget.value })
        }
      />
      <s-box>
        {freshness && (
          <s-badge tone={FRESHNESS_TONE[freshness.status]}>
            {formatDaysRemaining(freshness.daysRemaining)}
          </s-badge>
        )}
      </s-box>
      <s-box>
        {onRemove && (
          <s-button
            icon="delete"
            variant="tertiary"
            tone="critical"
            accessibilityLabel={removeLabel}
            disabled={disabled || undefined}
            onClick={onRemove}
          />
        )}
      </s-box>
    </s-grid>
  );
}

function saveProblems(
  failed: number,
  failedNew: number,
  dateFailed: boolean,
): string | null {
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(
      `${failed} ${failed === 1 ? "batch wasn't" : "batches weren't"} saved and kept the old values.`,
    );
  }
  if (failedNew > 0) {
    parts.push(
      `${failedNew} new ${failedNew === 1 ? "batch wasn't" : "batches weren't"} added.`,
    );
  }
  if (dateFailed) {
    parts.push("The product's earliest expiry date didn't update.");
  }
  return parts.length > 0 ? `${parts.join(" ")} Try again.` : null;
}

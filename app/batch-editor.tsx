import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import type { BatchEditResult } from "./batch-edit.server";
import { type EditableBatch, validateEdit } from "../shared/batch-edit";
import {
  FRESHNESS_TONE,
  computeBatchFreshness,
  formatDaysRemaining,
  isCalendarDate,
} from "../shared/freshness";
import {
  MAX_QUANTITY,
  type BatchErrors,
  hasErrors,
} from "../shared/validation";

export const BATCH_EDITOR_ID = "batch-editor";

// One line per batch: quantity, date (s-date-field is at least 14rem), status
const ROW_COLUMNS = "8rem 14rem auto";

export interface EditTarget {
  productId: string;
  title: string;
  // Changes on every open, so reopening the same product loads it again
  openedAt: number;
}

type Loaded = { batches: EditableBatch[] } | { message: string };
type Notice = { tone: "warning" | "critical"; message: string };

/** One modal for the dashboard, opened by a row's Edit batches button. */
export function BatchEditor({
  target,
  today,
}: {
  target: EditTarget | null;
  today: string;
}) {
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const modal = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const load = useFetcher<Loaded>();
  const save = useFetcher<BatchEditResult | { message: string }>();

  // What the modal opened with, and the form's values
  const [opened, setOpened] = useState<EditableBatch[]>([]);
  const [edited, setEdited] = useState<EditableBatch[]>([]);
  const [errors, setErrors] = useState<Record<string, BatchErrors>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  // Remounts the fields, since their value attributes only set a starting value
  const [formVersion, setFormVersion] = useState(0);

  function reset(batches: EditableBatch[]) {
    setOpened(batches);
    setEdited(batches);
    setErrors({});
    setFormVersion((version) => version + 1);
  }

  // Each open, load result and save result is handled once, however often this re-renders
  const handled = useRef<{
    target?: unknown;
    loaded?: unknown;
    saved?: unknown;
  }>({});

  useEffect(() => {
    if (!target || handled.current.target === target) return;
    handled.current.target = target;
    setNotice(null);
    reset([]);
    load.load(`/app/batches?productId=${encodeURIComponent(target.productId)}`);
  }, [target, load]);

  useEffect(() => {
    const loaded = load.data;
    if (load.state !== "idle" || !loaded || handled.current.loaded === loaded) {
      return;
    }
    handled.current.loaded = loaded;
    if ("batches" in loaded) reset(loaded.batches);
    else setNotice({ tone: "critical", message: loaded.message });
  }, [load.state, load.data]);

  useEffect(() => {
    const result = save.data;
    if (save.state !== "idle" || !result || handled.current.saved === result) {
      return;
    }
    handled.current.saved = result;
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
        revalidator.revalidate();
        const problems = saveProblems(result.failed.length, result.dateFailed);
        if (!problems) {
          shopify.toast.show("Batches saved");
          modal.current?.hideOverlay();
          return;
        }
        reset(result.batches);
        setNotice({ tone: "warning", message: problems });
      }
    }
  }, [save.state, save.data, revalidator, shopify]);

  function update(id: string, change: Partial<EditableBatch>) {
    setEdited((batches) =>
      batches.map((batch) =>
        batch.id === id ? { ...batch, ...change } : batch,
      ),
    );
  }

  function submit() {
    if (!target) return;
    const found: Record<string, BatchErrors> = {};
    for (const batch of edited) {
      const batchErrors = validateEdit(batch);
      if (hasErrors(batchErrors)) found[batch.id] = batchErrors;
    }
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) return;
    save.submit(
      { productId: target.productId, opened, edited },
      { method: "post", action: "/app/batches", encType: "application/json" },
    );
  }

  const loading = load.state !== "idle";
  const saving = save.state !== "idle";

  return (
    <s-modal
      ref={modal}
      id={BATCH_EDITOR_ID}
      heading={target ? `Edit batches: ${target.title}` : "Edit batches"}
    >
      <s-stack gap="base">
        {notice && <s-banner tone={notice.tone}>{notice.message}</s-banner>}
        {loading && <s-spinner accessibilityLabel="Loading batches" />}
        <s-stack key={formVersion} gap="small-200">
          {edited.length > 0 && (
            <s-grid gridTemplateColumns={ROW_COLUMNS} columnGap="base">
              <s-text>Quantity</s-text>
              <s-text>Expiry date</s-text>
              <s-text>Status</s-text>
            </s-grid>
          )}
          {edited.map((batch) => {
            const batchErrors = errors[batch.id] ?? {};
            const freshness = isCalendarDate(batch.expirationDate)
              ? computeBatchFreshness(batch.expirationDate, today)
              : null;
            return (
              <s-grid
                key={batch.id}
                gridTemplateColumns={ROW_COLUMNS}
                columnGap="base"
                alignItems="start"
              >
                <s-number-field
                  label="Quantity"
                  labelAccessibilityVisibility="exclusive"
                  value={String(batch.quantity)}
                  min={1}
                  max={MAX_QUANTITY}
                  step={1}
                  error={batchErrors.quantity}
                  disabled={saving || undefined}
                  onInput={(event) =>
                    update(batch.id, {
                      quantity: Number(event.currentTarget.value),
                    })
                  }
                />
                <s-date-field
                  label="Expiry date"
                  labelAccessibilityVisibility="exclusive"
                  value={batch.expirationDate}
                  error={batchErrors.expirationDate}
                  disabled={saving || undefined}
                  onChange={(event) =>
                    update(batch.id, {
                      expirationDate: event.currentTarget.value,
                    })
                  }
                />
                {freshness && (
                  <s-badge tone={FRESHNESS_TONE[freshness.status]}>
                    {formatDaysRemaining(freshness.daysRemaining)}
                  </s-badge>
                )}
              </s-grid>
            );
          })}
        </s-stack>
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        loading={saving || undefined}
        disabled={loading || edited.length === 0 || undefined}
        onClick={submit}
      >
        Save
      </s-button>
      <s-button
        slot="secondary-actions"
        commandFor={BATCH_EDITOR_ID}
        command="--hide"
      >
        Cancel
      </s-button>
    </s-modal>
  );
}

function saveProblems(failed: number, dateFailed: boolean): string | null {
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(
      `${failed} ${failed === 1 ? "batch wasn't" : "batches weren't"} saved and kept the old values.`,
    );
  }
  if (dateFailed) {
    parts.push("The product's earliest expiry date didn't update.");
  }
  return parts.length > 0 ? `${parts.join(" ")} Try again.` : null;
}

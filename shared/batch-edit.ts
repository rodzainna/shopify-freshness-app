import type { Batch } from "./freshness";
import { PRODUCT_GID } from "./product-gid";
import { type BatchErrors, hasErrors, validateBatch } from "./validation";

// Type literals rather than interfaces, so they can be sent as JSON
export type EditableBatch = {
  id: string;
  quantity: number;
  expirationDate: string;
};

export type BatchEditPlan =
  | { kind: "invalid"; errors: Record<string, BatchErrors> }
  // The batches changed since the editor opened, so nothing is written
  | { kind: "changed" }
  | { kind: "unchanged" }
  | { kind: "write"; updates: EditableBatch[] };

// The panel's rules; removing a batch is left to the panel
export function validateEdit(batch: Batch): BatchErrors {
  const errors = validateBatch(batch);
  if (Number.isInteger(batch.quantity) && batch.quantity < 1) {
    errors.quantity =
      "Must be at least 1. To remove a batch, use the product panel.";
  }
  return errors;
}

// The edits don't cover exactly the batches the editor opened with
export class MismatchedEditsError extends Error {
  constructor() {
    super("The edits don't match the batches that were opened");
    this.name = "MismatchedEditsError";
  }
}

export type BatchEditRequest = {
  productId: string;
  opened: EditableBatch[];
  edited: EditableBatch[];
};

/** The editor's request body, or null when it isn't shaped like one. */
export function parseBatchEditRequest(body: unknown): BatchEditRequest | null {
  if (!isRecord(body)) return null;
  const { productId, opened, edited } = body;
  if (typeof productId !== "string" || !PRODUCT_GID.test(productId)) {
    return null;
  }
  if (!isBatchList(opened) || !isBatchList(edited)) return null;
  return { productId, opened, edited };
}

function isBatchList(value: unknown): value is EditableBatch[] {
  return (
    Array.isArray(value) &&
    value.every(
      (batch) =>
        isRecord(batch) &&
        typeof batch.id === "string" &&
        typeof batch.quantity === "number" &&
        typeof batch.expirationDate === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decides what a dashboard save writes. `opened` is what the editor showed,
 * `current` is read again under the product's lock, `edited` is the form.
 *
 * @throws MismatchedEditsError if `edited` doesn't cover exactly the opened batches
 */
export function planBatchEdit(
  opened: EditableBatch[],
  current: EditableBatch[],
  edited: EditableBatch[],
): BatchEditPlan {
  if (!sameIds(opened, edited)) {
    throw new MismatchedEditsError();
  }

  const errors: Record<string, BatchErrors> = {};
  for (const batch of edited) {
    const batchErrors = validateEdit(batch);
    if (hasErrors(batchErrors)) errors[batch.id] = batchErrors;
  }
  if (Object.keys(errors).length > 0) return { kind: "invalid", errors };

  if (!sameBatches(opened, current)) return { kind: "changed" };

  const openedById = new Map(opened.map((batch) => [batch.id, batch]));
  const updates = edited.filter(
    (batch) => !sameValues(batch, openedById.get(batch.id)!),
  );
  return updates.length > 0
    ? { kind: "write", updates }
    : { kind: "unchanged" };
}

/** The batches once `written` has been applied to `current`. */
export function applyEdits(
  current: EditableBatch[],
  written: EditableBatch[],
): EditableBatch[] {
  const writtenById = new Map(written.map((batch) => [batch.id, batch]));
  return current.map((batch) => writtenById.get(batch.id) ?? batch);
}

// Each opened batch exactly once
function sameIds(opened: EditableBatch[], edited: EditableBatch[]): boolean {
  const openedIds = new Set(opened.map(({ id }) => id));
  const editedIds = new Set(edited.map(({ id }) => id));
  return (
    edited.length === editedIds.size &&
    editedIds.size === openedIds.size &&
    [...editedIds].every((id) => openedIds.has(id))
  );
}

// Same batches with the same values, in any order
function sameBatches(a: EditableBatch[], b: EditableBatch[]): boolean {
  const byId = new Map(a.map((batch) => [batch.id, batch]));
  return (
    a.length === b.length &&
    b.every((batch) => {
      const match = byId.get(batch.id);
      return match !== undefined && sameValues(batch, match);
    })
  );
}

function sameValues(a: Batch, b: Batch): boolean {
  return a.quantity === b.quantity && a.expirationDate === b.expirationDate;
}

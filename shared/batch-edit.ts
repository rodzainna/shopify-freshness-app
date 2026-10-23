import type { Batch } from "./freshness";
import { PRODUCT_GID } from "./product-gid";
import { MAX_BATCHES } from "./product-metafields";
import { type BatchErrors, hasErrors, validateBatch } from "./validation";

// Type literals rather than interfaces, so they can be sent as JSON
export type EditableBatch = {
  id: string;
  quantity: number;
  expirationDate: string;
};

// A batch added in the editor; its handle is the key Shopify stores it under
export type NewBatch = {
  handle: string;
  quantity: number;
  expirationDate: string;
};

export type BatchEditPlan =
  // Errors are keyed by batch id, or by handle for new batches
  | { kind: "invalid"; errors: Record<string, BatchErrors> }
  // The batches changed since the editor opened, so nothing is written
  | { kind: "changed" }
  // Over the batches a product can hold, or that one save may add
  | { kind: "tooMany"; limit: "product" | "save"; max: number }
  | { kind: "unchanged" }
  | { kind: "write"; updates: EditableBatch[]; additions: NewBatch[] };

// Keeps a save's lookups and creates well inside the product lock's TTL
export const MAX_NEW_BATCHES_PER_SAVE = 25;

// Lowercase v4 UUIDs, as crypto.randomUUID() makes them
const BATCH_HANDLE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isBatchHandle(value: string): boolean {
  return BATCH_HANDLE.test(value);
}

// The panel's rules; removing a batch is left to the panel
export function validateEdit(batch: Batch): BatchErrors {
  const errors = validateBatch(batch);
  if (Number.isInteger(batch.quantity) && batch.quantity < 1) {
    errors.quantity =
      "Must be at least 1. To remove a batch, use the product panel.";
  }
  return errors;
}

// The edits don't cover exactly the opened batches, or a new batch's handle is bad
export class MismatchedEditsError extends Error {
  constructor(message = "The edits don't match the batches that were opened") {
    super(message);
    this.name = "MismatchedEditsError";
  }
}

export type BatchEditRequest = {
  productId: string;
  opened: EditableBatch[];
  edited: EditableBatch[];
  added: NewBatch[];
};

// Batch ids are Shopify GIDs, so they can never equal a new batch's UUID handle
const METAOBJECT_GID = /^gid:\/\/shopify\/Metaobject\/\d+$/;

/** The editor's request body, or null when it isn't shaped like one. */
export function parseBatchEditRequest(body: unknown): BatchEditRequest | null {
  if (!isRecord(body)) return null;
  const { productId, opened, edited, added = [] } = body;
  if (typeof productId !== "string" || !PRODUCT_GID.test(productId)) {
    return null;
  }
  if (!isBatchList(opened) || !isBatchList(edited) || !isNewBatchList(added)) {
    return null;
  }
  return { productId, opened, edited, added };
}

function isBatchList(value: unknown): value is EditableBatch[] {
  return (
    Array.isArray(value) &&
    value.every(
      (batch) =>
        isRecord(batch) &&
        typeof batch.id === "string" &&
        METAOBJECT_GID.test(batch.id) &&
        hasBatchValues(batch),
    )
  );
}

function isNewBatchList(value: unknown): value is NewBatch[] {
  return (
    Array.isArray(value) &&
    // Refused before the lock is taken; the planner's check gives the message
    value.length <= MAX_NEW_BATCHES_PER_SAVE &&
    value.every(
      (batch) =>
        isRecord(batch) &&
        typeof batch.handle === "string" &&
        hasBatchValues(batch),
    ) &&
    uniqueUuidHandles(value)
  );
}

function hasBatchValues(batch: Record<string, unknown>): boolean {
  return (
    typeof batch.quantity === "number" &&
    typeof batch.expirationDate === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Errors by batch id; empty when every batch is valid. */
export function validateEdits(
  batches: EditableBatch[],
): Record<string, BatchErrors> {
  return collectErrors(batches, validateEdit, ({ id }) => id);
}

/** Errors by handle, with the panel's rules; empty when every batch is valid. */
export function validateNewBatches(
  batches: NewBatch[],
): Record<string, BatchErrors> {
  return collectErrors(batches, validateBatch, ({ handle }) => handle);
}

/** Errors for a whole save: opened batches by id, new ones by handle. */
export function validateBatchEdit(
  edited: EditableBatch[],
  added: NewBatch[],
): Record<string, BatchErrors> {
  return { ...validateEdits(edited), ...validateNewBatches(added) };
}

/** How many new batches one save can add to a product holding `existing`. */
export function maxNewBatches(existing: number): number {
  return Math.max(
    0,
    Math.min(MAX_NEW_BATCHES_PER_SAVE, MAX_BATCHES - existing),
  );
}

function collectErrors<T extends Batch>(
  batches: T[],
  validate: (batch: T) => BatchErrors,
  keyOf: (batch: T) => string,
): Record<string, BatchErrors> {
  const errors: Record<string, BatchErrors> = {};
  for (const batch of batches) {
    const batchErrors = validate(batch);
    if (hasErrors(batchErrors)) errors[keyOf(batch)] = batchErrors;
  }
  return errors;
}

/**
 * Decides what a dashboard save writes. `opened` is what the editor showed,
 * `current` is read again under the product's lock, `edited` is the form's
 * opened batches and `added` its new ones.
 *
 * @throws MismatchedEditsError if `edited` doesn't cover exactly the opened
 *   batches, or `added` has a handle that's repeated or not a UUID
 */
export function planBatchEdit(
  opened: EditableBatch[],
  current: EditableBatch[],
  edited: EditableBatch[],
  added: NewBatch[] = [],
): BatchEditPlan {
  if (!sameIds(opened, edited)) throw new MismatchedEditsError();
  if (!uniqueUuidHandles(added)) {
    throw new MismatchedEditsError(
      "Each new batch needs its own lowercase UUID handle",
    );
  }

  const errors = validateBatchEdit(edited, added);
  if (Object.keys(errors).length > 0) return { kind: "invalid", errors };

  if (!sameBatches(opened, current)) return { kind: "changed" };
  if (added.length > MAX_NEW_BATCHES_PER_SAVE) {
    return { kind: "tooMany", limit: "save", max: MAX_NEW_BATCHES_PER_SAVE };
  }
  if (current.length + added.length > MAX_BATCHES) {
    return { kind: "tooMany", limit: "product", max: MAX_BATCHES };
  }

  const openedById = new Map(opened.map((batch) => [batch.id, batch]));
  const updates = edited.filter(
    (batch) => !sameValues(batch, openedById.get(batch.id)!),
  );
  return updates.length > 0 || added.length > 0
    ? {
        kind: "write",
        updates,
        additions: added.map((batch) => ({ ...batch })),
      }
    : { kind: "unchanged" };
}

function uniqueUuidHandles(added: NewBatch[]): boolean {
  const seen = new Set<string>();
  for (const { handle } of added) {
    if (seen.has(handle) || !isBatchHandle(handle)) return false;
    seen.add(handle);
  }
  return true;
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

export function sameValues(a: Batch, b: Batch): boolean {
  return a.quantity === b.quantity && a.expirationDate === b.expirationDate;
}

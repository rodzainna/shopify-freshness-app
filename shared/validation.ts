import { type Batch, isCalendarDate } from "./freshness";

export type BatchErrors = Partial<Record<keyof Batch, string>>;

// Anything bigger is a typo, and keeps quantities safe to send as integers
export const MAX_QUANTITY = 1_000_000_000;

// Past dates are allowed: expired stock still exists until it's removed.
export function validateBatch(batch: Batch): BatchErrors {
  const errors: BatchErrors = {};

  // NaN is an empty field
  if (Number.isNaN(batch.quantity)) {
    errors.quantity = "Enter a quantity";
  } else if (!Number.isInteger(batch.quantity)) {
    errors.quantity = "Must be a whole number";
  } else if (batch.quantity < 1) {
    errors.quantity = "Must be at least 1";
  } else if (batch.quantity > MAX_QUANTITY) {
    errors.quantity = "Number is too large";
  }

  if (!batch.expirationDate) {
    errors.expirationDate = "Enter an expiry date";
  } else if (!isCalendarDate(batch.expirationDate)) {
    errors.expirationDate = "Enter a valid date";
  }

  return errors;
}

export function hasErrors(errors: BatchErrors): boolean {
  return Object.keys(errors).length > 0;
}

export type FreshnessStatus = "Fresh" | "Use Soon" | "Expired";

export interface BatchFreshness {
  status: FreshnessStatus;
  daysRemaining: number; // if today is Sep 13 and it expires Sep 15, it's 2 days
}

export interface Batch {
  quantity: number;
  expirationDate: string;
}

// How many milliseconds are in one day
// Used to convert a millisecond difference between two dates into days
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * @param dateString - a plain calendar date, "YYYY-MM-DD"
 * @returns count of milliseconds since January 1, 1970, 00:00:00 UTC
 *   for that date (e.g. "2026-09-15" -> 1789430400000)
 */
function parseDateOnly(dateString: string): number {
  if (!DATE_ONLY_PATTERN.test(dateString)) {
    throw new Error(`Expected a YYYY-MM-DD date string, got: "${dateString}"`);
  }

  const [year, month, day] = dateString.split("-").map(Number);
  const utcMs = Date.UTC(year, month - 1, day);

  const roundTrip = new Date(utcMs);

  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`"${dateString}" is not a real calendar date`);
  }

  return utcMs;
}

/**
 * We want to know the actual shop's date now/today
 *
 * @param timezone - the shop's IANA timezone, e.g. "Asia/Manila"
 * @param now - the current instant
 * @returns YYYY-MM-DD date format of the shop's date today
 * @throws RangeError if `timezone` isn't a real IANA timezone name —
 *   deliberately not caught here; an invalid shop timezone should fail
 *   loudly, not silently default to something wrong.
 */
export function getShopToday(timezone: string, now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(now);
}

/**
 * @param expirationDate - the batch's merchant-entered expiration date, "YYYY-MM-DD"
 * @param today - the shop-local "today", "YYYY-MM-DD" (see getShopToday)
 * @returns BatchFreshness: status and daysRemaining
 */
export function computeBatchFreshness(
  expirationDate: string,
  today: string,
): BatchFreshness {
  const daysRemaining = Math.round(
    (parseDateOnly(expirationDate) - parseDateOnly(today)) / MS_PER_DAY,
  );

  let status: FreshnessStatus;

  if (daysRemaining < 0) {
    status = "Expired";
  } else if (daysRemaining <= 3) {
    status = "Use Soon";
  } else {
    status = "Fresh";
  }

  return { status, daysRemaining };
}

export function computeAggregateFreshness(
  batches: Batch[],
  today: string,
): FreshnessStatus | "Not set" {
  const activeBatches = batches.filter((batch) => batch.quantity > 0);

  if (activeBatches.length === 0) {
    return "Not set";
  }

  const statuses = activeBatches.map(
    (batch) => computeBatchFreshness(batch.expirationDate, today).status,
  );

  if (statuses.includes("Expired")) return "Expired";
  if (statuses.includes("Use Soon")) return "Use Soon";
  return "Fresh";
}

/**
 * The product-level date the storefront shows. Only in-stock batches count,
 * matching computeAggregateFreshness: a sold-out batch shouldn't set it.
 *
 * @returns the soonest "YYYY-MM-DD" expiry, or null if no batch is in stock
 */
export function getEarliestExpirationDate(batches: Batch[]): string | null {
  const dates = batches
    .filter((batch) => batch.quantity > 0 && batch.expirationDate)
    .map((batch) => batch.expirationDate);

  // YYYY-MM-DD strings sort in calendar order, so no date parsing is needed
  return dates.length > 0 ? dates.sort()[0] : null;
}

export function formatDaysRemaining(daysRemaining: number): string {
  const days = Math.abs(daysRemaining);
  const amount = days > 99 ? `${Math.floor(days / 30)}mo` : `${days}d`;

  if (daysRemaining < -1) return `Expired ${amount} ago`;
  if (daysRemaining === -1) return "Expired yesterday";
  if (daysRemaining === 0) return "Expires today";
  if (daysRemaining === 1) return "Expires tomorrow";
  return `Expires in ${amount}`;
}

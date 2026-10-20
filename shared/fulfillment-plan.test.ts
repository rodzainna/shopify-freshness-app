import { describe, it, expect } from "vitest";

import {
  checkPlanBeforeRetry,
  earliestDateAfterPlan,
  planFulfillment,
} from "./fulfillment-plan";

const TODAY = "2026-10-20";

function batch(id: string, quantity: number, expirationDate: string) {
  return { id, quantity, expirationDate };
}

const SOON = batch("soon", 3, "2026-10-22");
const LATER = batch("later", 10, "2026-11-05");
const EXPIRED = batch("expired", 4, "2026-10-19");

describe("planFulfillment", () => {
  it("sets new quantities, deletes emptied batches and recomputes the date", () => {
    expect(planFulfillment([LATER, SOON], 5, TODAY)).toStrictEqual({
      plan: {
        updates: [{ id: "later", before: 10, after: 8 }],
        deletes: [{ id: "soon", before: 3 }],
        beforeBatchIds: ["later", "soon"],
        batchIds: ["later"],
        earliestExpirationDate: "2026-11-05",
      },
      shortfall: null,
    });
  });

  it("keeps the earliest date when the soonest batch isn't emptied", () => {
    const { plan } = planFulfillment([SOON, LATER], 1, TODAY);

    expect(plan.updates).toStrictEqual([{ id: "soon", before: 3, after: 2 }]);
    expect(plan.deletes).toStrictEqual([]);
    expect(plan.earliestExpirationDate).toBe("2026-10-22");
  });

  it("clears the earliest date when the last batch is emptied", () => {
    const { plan } = planFulfillment([SOON], 3, TODAY);

    expect(plan.batchIds).toStrictEqual([]);
    expect(plan.earliestExpirationDate).toBeNull();
  });

  it("uses each batch once when the list repeats an id", () => {
    const { plan, shortfall } = planFulfillment([SOON, SOON, LATER], 4, TODAY);

    expect(plan.beforeBatchIds).toStrictEqual(["soon", "later"]);
    expect(plan.deletes).toStrictEqual([{ id: "soon", before: 3 }]);
    expect(plan.updates).toStrictEqual([{ id: "later", before: 10, after: 9 }]);
    expect(shortfall).toBeNull();
  });

  it("still rewrites the list and date when nothing is decremented", () => {
    // The stored date may be stale after an edit outside the panel
    expect(planFulfillment([EXPIRED, LATER], 0, TODAY).plan).toStrictEqual({
      updates: [],
      deletes: [],
      beforeBatchIds: ["expired", "later"],
      batchIds: ["expired", "later"],
      earliestExpirationDate: "2026-10-19",
    });
  });

  describe("shortfall", () => {
    it("is an oversell when there's no stock behind it", () => {
      expect(planFulfillment([SOON], 5, TODAY).shortfall).toStrictEqual({
        reason: "oversell",
        shortfall: 2,
        expiredUnits: 0,
      });
    });

    it("is expired stock only when expired units cover all of it", () => {
      expect(
        planFulfillment([EXPIRED, SOON], 7, TODAY).shortfall,
      ).toStrictEqual({
        reason: "expired_stock_only",
        shortfall: 4,
        expiredUnits: 4,
      });
    });

    it("is an oversell when expired units cover only part of it", () => {
      expect(planFulfillment([EXPIRED], 5, TODAY).shortfall).toStrictEqual({
        reason: "oversell",
        shortfall: 5,
        expiredUnits: 4,
      });
    });

    it("never decrements expired stock", () => {
      const { plan } = planFulfillment([EXPIRED], 5, TODAY);

      expect(plan.updates).toStrictEqual([]);
      expect(plan.deletes).toStrictEqual([]);
      expect(plan.batchIds).toStrictEqual(["expired"]);
    });

    it("counts only in-stock expired batches", () => {
      const invalid = batch("invalid", -3, "2026-10-01");

      expect(
        planFulfillment([invalid, EXPIRED], 5, TODAY).shortfall,
      ).toStrictEqual({ reason: "oversell", shortfall: 5, expiredUnits: 4 });
    });
  });
});

describe("checkPlanBeforeRetry", () => {
  // Takes 5: "soon" (3) is emptied, "later" goes from 10 to 8
  const { plan } = planFulfillment([SOON, LATER], 5, TODAY);
  const laterAfter = batch("later", 8, "2026-11-05");

  it("is safe when nothing was applied yet", () => {
    expect(checkPlanBeforeRetry(plan, [SOON, LATER])).toBe("safe");
  });

  it("is safe when only the quantities were applied", () => {
    expect(checkPlanBeforeRetry(plan, [SOON, laterAfter])).toBe("safe");
  });

  it("is safe when the list was rewritten too", () => {
    expect(checkPlanBeforeRetry(plan, [laterAfter])).toBe("safe");
  });

  it("is changed when a batch quantity was edited", () => {
    const edited = batch("later", 6, "2026-11-05");

    expect(checkPlanBeforeRetry(plan, [SOON, edited])).toBe("changed");
  });

  it("is changed when a batch to delete was edited", () => {
    const edited = batch("soon", 1, "2026-10-22");

    expect(checkPlanBeforeRetry(plan, [edited, LATER])).toBe("changed");
  });

  it("is changed when a batch was added", () => {
    const added = batch("new", 2, "2026-12-01");

    expect(checkPlanBeforeRetry(plan, [SOON, LATER, added])).toBe("changed");
  });

  it("is changed when a batch was removed", () => {
    expect(checkPlanBeforeRetry(plan, [SOON])).toBe("changed");
  });

  it("is changed when the batches were reordered", () => {
    expect(checkPlanBeforeRetry(plan, [LATER, SOON])).toBe("changed");
  });

  it("ignores a repeated id, as the plan did", () => {
    expect(checkPlanBeforeRetry(plan, [SOON, SOON, LATER])).toBe("safe");
  });
});

describe("earliestDateAfterPlan", () => {
  const NEXT = batch("next", 2, "2026-11-01");
  // Takes 3: "soon" is emptied; "next" and "later" are untouched
  const { plan } = planFulfillment([SOON, NEXT, LATER], 3, TODAY);

  it("matches the plan's date when nothing changed", () => {
    expect(earliestDateAfterPlan(plan, [SOON, NEXT, LATER])).toBe(
      plan.earliestExpirationDate,
    );
  });

  it("is the same whether or not the plan was partly applied", () => {
    expect(earliestDateAfterPlan(plan, [NEXT, LATER])).toBe("2026-11-01");
  });

  it("skips an untouched batch that was sold out in the meantime", () => {
    const soldOut = batch("next", 0, "2026-11-01");

    expect(earliestDateAfterPlan(plan, [SOON, soldOut, LATER])).toBe(
      "2026-11-05",
    );
  });

  it("uses an untouched batch's edited date", () => {
    const redated = batch("next", 2, "2026-12-01");

    expect(earliestDateAfterPlan(plan, [SOON, redated, LATER])).toBe(
      "2026-11-05",
    );
  });
});

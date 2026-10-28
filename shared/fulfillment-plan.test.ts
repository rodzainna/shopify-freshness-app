import { describe, it, expect } from "vitest";

import {
  checkPlanApplied,
  checkPlanBeforeRetry,
  freshnessAfterPlan,
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
  it("sets new quantities and deletes emptied batches", () => {
    expect(planFulfillment([LATER, SOON], 5, TODAY)).toStrictEqual({
      plan: {
        updates: [{ id: "later", before: 10, after: 8 }],
        deletes: [{ id: "soon", before: 3 }],
      },
      shortfall: null,
    });
  });

  it("only decrements the soonest batch when it covers the quantity", () => {
    const { plan } = planFulfillment([SOON, LATER], 1, TODAY);

    expect(plan.updates).toStrictEqual([{ id: "soon", before: 3, after: 2 }]);
    expect(plan.deletes).toStrictEqual([]);
  });

  it("uses each batch once when the list repeats an id", () => {
    const { plan, shortfall } = planFulfillment([SOON, SOON, LATER], 4, TODAY);

    expect(plan.deletes).toStrictEqual([{ id: "soon", before: 3 }]);
    expect(plan.updates).toStrictEqual([{ id: "later", before: 10, after: 9 }]);
    expect(shortfall).toBeNull();
  });

  it("plans no changes when nothing is decremented", () => {
    expect(planFulfillment([EXPIRED, LATER], 0, TODAY).plan).toStrictEqual({
      updates: [],
      deletes: [],
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

  it("is safe when another batch was added", () => {
    const added = batch("new", 2, "2026-12-01");

    expect(checkPlanBeforeRetry(plan, [SOON, LATER, added])).toBe("safe");
  });

  it("is safe when an untouched batch was removed", () => {
    const NEXT = batch("next", 2, "2026-11-01");
    const { plan: withNext } = planFulfillment([SOON, NEXT, LATER], 3, TODAY);

    expect(checkPlanBeforeRetry(withNext, [SOON, LATER])).toBe("safe");
  });

  it("is changed when a batch it updates was removed", () => {
    expect(checkPlanBeforeRetry(plan, [SOON])).toBe("changed");
  });

  it("is safe when the batches were reordered", () => {
    expect(checkPlanBeforeRetry(plan, [LATER, SOON])).toBe("safe");
  });

  it("ignores a repeated id, as the plan did", () => {
    expect(checkPlanBeforeRetry(plan, [SOON, SOON, LATER])).toBe("safe");
  });
});

describe("checkPlanApplied", () => {
  // Takes 5: "soon" (3) is emptied, "later" goes from 10 to 8
  const { plan } = planFulfillment([SOON, LATER], 5, TODAY);
  const laterAfter = batch("later", 8, "2026-11-05");

  it("is safe right after the plan's quantities were written", () => {
    expect(checkPlanApplied(plan, [SOON, laterAfter])).toBe("safe");
  });

  it("is safe when the emptied batch is already gone", () => {
    expect(checkPlanApplied(plan, [laterAfter])).toBe("safe");
  });

  it("is changed when a decrement was undone", () => {
    expect(checkPlanApplied(plan, [SOON, LATER])).toBe("changed");
  });

  it("is changed when a batch to empty was restocked", () => {
    const restocked = batch("soon", 20, "2026-10-22");

    expect(checkPlanApplied(plan, [restocked, laterAfter])).toBe("changed");
  });

  it("ignores batches the plan doesn't touch", () => {
    const added = batch("new", 2, "2026-12-01");

    expect(checkPlanApplied(plan, [SOON, laterAfter, added])).toBe("safe");
  });
});

describe("freshnessAfterPlan", () => {
  // Takes 5: "soon" (3) is emptied, "later" goes from 10 to 8
  const { plan } = planFulfillment([SOON, LATER], 5, TODAY);
  const laterAfter = batch("later", 8, "2026-11-05");
  const PANEL = batch("panel", 4, "2026-10-30");

  it("drops the emptied batch and recomputes the date", () => {
    expect(freshnessAfterPlan(plan, [SOON, laterAfter])).toStrictEqual({
      batchIds: ["later"],
      earliestExpirationDate: "2026-11-05",
    });
  });

  it("keeps the soonest date when its batch isn't emptied", () => {
    const { plan: takeOne } = planFulfillment([SOON, LATER], 1, TODAY);
    const soonAfter = batch("soon", 2, "2026-10-22");

    expect(freshnessAfterPlan(takeOne, [soonAfter, LATER])).toStrictEqual({
      batchIds: ["soon", "later"],
      earliestExpirationDate: "2026-10-22",
    });
  });

  it("still recomputes the date when nothing is decremented", () => {
    // The stored date may be stale after an edit outside the panel
    const { plan: none } = planFulfillment([EXPIRED, LATER], 0, TODAY);

    expect(freshnessAfterPlan(none, [EXPIRED, LATER])).toStrictEqual({
      batchIds: ["expired", "later"],
      earliestExpirationDate: "2026-10-19",
    });
  });

  it("skips an untouched batch that was sold out in the meantime", () => {
    const soldOut = batch("panel", 0, "2026-10-30");

    expect(
      freshnessAfterPlan(plan, [SOON, laterAfter, soldOut])
        .earliestExpirationDate,
    ).toBe("2026-11-05");
  });

  it("uses an untouched batch's edited date", () => {
    const redated = batch("panel", 4, "2026-10-25");

    expect(
      freshnessAfterPlan(plan, [SOON, laterAfter, redated])
        .earliestExpirationDate,
    ).toBe("2026-10-25");
  });

  it("keeps a batch added meanwhile, in its place, and counts its date", () => {
    expect(freshnessAfterPlan(plan, [SOON, laterAfter, PANEL])).toStrictEqual({
      batchIds: ["later", "panel"],
      earliestExpirationDate: "2026-10-30",
    });
  });

  it("leaves out a batch removed meanwhile", () => {
    const { plan: twoKept } = planFulfillment([SOON, LATER, PANEL], 3, TODAY);

    expect(freshnessAfterPlan(twoKept, [SOON, LATER])).toStrictEqual({
      batchIds: ["later"],
      earliestExpirationDate: "2026-11-05",
    });
  });

  it("is the same when the plan's delete is already done", () => {
    expect(freshnessAfterPlan(plan, [laterAfter])).toStrictEqual({
      batchIds: ["later"],
      earliestExpirationDate: "2026-11-05",
    });
  });

  it("lists a repeated batch once, where it first appears", () => {
    expect(
      freshnessAfterPlan(plan, [laterAfter, PANEL, laterAfter]),
    ).toStrictEqual({
      batchIds: ["later", "panel"],
      earliestExpirationDate: "2026-10-30",
    });
  });

  it("is empty when every batch is gone", () => {
    const { plan: all } = planFulfillment([SOON], 3, TODAY);

    expect(freshnessAfterPlan(all, [SOON])).toStrictEqual({
      batchIds: [],
      earliestExpirationDate: null,
    });
  });
});

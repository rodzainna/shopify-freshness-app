import { describe, it, expect, vi } from "vitest";
import { shouldRevalidate } from "./app._index";

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));

type Args = Parameters<typeof shouldRevalidate>[0];
const revalidates = (args: Partial<Args>) =>
  shouldRevalidate({ defaultShouldRevalidate: true, ...args } as Args);

describe("dashboard revalidation", () => {
  // Saved, or changed by someone else: either way the rows are out of date
  it.each(["saved", "changed"])("reloads after a %s result", (kind) => {
    expect(
      revalidates({ formAction: "/app/batches", actionResult: { kind } }),
    ).toBe(true);
  });

  it.each(["invalid", "unchanged", "unavailable"])(
    "doesn't reload after a %s result",
    (kind) => {
      expect(
        revalidates({ formAction: "/app/batches", actionResult: { kind } }),
      ).toBe(false);
    },
  );

  it("doesn't reload after an error message", () => {
    expect(
      revalidates({
        formAction: "/app/batches",
        actionResult: { message: "Couldn't reach Shopify. Try again." },
      }),
    ).toBe(false);
  });

  it("leaves other navigations to React Router", () => {
    expect(revalidates({ defaultShouldRevalidate: false })).toBe(false);
    expect(revalidates({})).toBe(true);
  });
});

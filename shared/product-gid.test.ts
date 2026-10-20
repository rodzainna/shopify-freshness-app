import { describe, it, expect } from "vitest";
import { PRODUCT_GID, toProductGid } from "./product-gid";

describe("toProductGid", () => {
  it("builds a GID the lock accepts", () => {
    const gid = toProductGid(9658528694493);
    expect(gid).toBe("gid://shopify/Product/9658528694493");
    expect(PRODUCT_GID.test(gid)).toBe(true);
  });
});

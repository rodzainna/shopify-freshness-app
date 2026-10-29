import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-app-react-router/server";

import db from "./db.server";
import { prismaSessionStorage as storage } from "./session-storage.server";

const SHOP = "session-test.myshopify.com";
const ID = `offline_${SHOP}`;

// Expiring offline tokens: each auth brings a new token, refresh token and expiry dates
const offlineSession = (n: number) =>
  new Session({
    id: ID,
    shop: SHOP,
    state: "state",
    isOnline: false,
    accessToken: `test-token-${n}`,
    scope: n === 1 ? "read_products" : "read_products,write_products",
    expires: new Date(Date.UTC(2026, 0, n)),
    refreshToken: `test-refresh-${n}`,
    refreshTokenExpires: new Date(Date.UTC(2026, 1, n)),
  });

describe("session storage", () => {
  const clear = () => db.session.deleteMany({ where: { shop: SHOP } });
  // Before each test too, so a row left by an interrupted run can't skip the create
  beforeEach(clear);
  afterEach(clear);

  it("replaces every token field on repeat auth, keeping one session", async () => {
    await storage.storeSession(offlineSession(1));
    await expect(storage.storeSession(offlineSession(2))).resolves.toBe(true);

    const sessions = await storage.findSessionsByShop(SHOP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: ID,
      accessToken: "test-token-2",
      scope: "read_products,write_products",
      expires: new Date(Date.UTC(2026, 0, 2)),
      refreshToken: "test-refresh-2",
      refreshTokenExpires: new Date(Date.UTC(2026, 1, 2)),
    });
  });

  it("clears token fields the new auth doesn't have", async () => {
    await storage.storeSession(offlineSession(1));
    await storage.storeSession(
      new Session({
        id: ID,
        shop: SHOP,
        state: "state",
        isOnline: false,
        accessToken: "test-token-2",
      }),
    );

    const [stored] = await storage.findSessionsByShop(SHOP);
    expect(stored.accessToken).toBe("test-token-2");
    expect(stored.scope).toBeUndefined();
    expect(stored.refreshToken).toBeUndefined();
    expect(stored.refreshTokenExpires).toBeUndefined();
    expect(stored.expires).toBeUndefined();
  });
});

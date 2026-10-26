import { describe, it, expect } from "vitest";

import { isShopifySignIn, shopifyResponse } from "./shopify-response";

describe("shopifyResponse", () => {
  it("renders a thrown response's body, whatever its class is called", () => {
    // A plain object, like React Router's class once a production build renames it
    const thrown = {
      status: 401,
      statusText: "Unauthorized",
      internal: false,
      data: "<p>Reauthorizing</p>",
    };

    expect(shopifyResponse(thrown)?.props).toStrictEqual({
      dangerouslySetInnerHTML: { __html: "<p>Reauthorizing</p>" },
    });
  });

  it("never writes a parsed JSON body into the page", () => {
    const thrown = { status: 401, statusText: "", internal: false, data: {} };

    expect(shopifyResponse(thrown)?.props).toStrictEqual({
      dangerouslySetInnerHTML: { __html: "Handling response" },
    });
  });

  it("leaves thrown errors to the caller", () => {
    expect(shopifyResponse(new Error("Shopify unreachable"))).toBeNull();
  });

  it("tells sign-in apart from Shopify's HTTP errors", () => {
    expect(isShopifySignIn(302)).toBe(true);
    expect(isShopifySignIn(401)).toBe(true);
    expect(isShopifySignIn(503)).toBe(false);
    expect(isShopifySignIn(429)).toBe(false);
  });

  it("renders Shopify's other responses too, as its boundary did", () => {
    const unavailable = {
      status: 503,
      statusText: "",
      internal: false,
      data: {},
    };
    expect(shopifyResponse(unavailable)?.props).toStrictEqual({
      dangerouslySetInnerHTML: { __html: "Handling response" },
    });
  });
});

import { isRouteErrorResponse } from "react-router";

// Shopify's sign-in responses: redirects, an App Bridge redirect page (200) or a reauthorize
// 401. Its other thrown responses are HTTP errors, such as a 503 from the Admin API.
export function isShopifySignIn(status: number): boolean {
  return status < 400 || status === 401;
}

/**
 * What Shopify's `boundary.error` renders for a thrown response, found with React
 * Router's check instead of a class name that production builds minify.
 */
export function shopifyResponse(error: unknown) {
  if (!isRouteErrorResponse(error)) return null;
  const html =
    typeof error.data === "string" && error.data
      ? error.data
      : "Handling response";
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

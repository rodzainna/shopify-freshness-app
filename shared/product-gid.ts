// The one product key format: a numeric id and a GID would be two different locks.
export const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export function toProductGid(id: number): string {
  return `gid://shopify/Product/${id}`;
}

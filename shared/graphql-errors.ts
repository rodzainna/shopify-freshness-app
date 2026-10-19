interface WithMessage {
  message: string;
}

/**
 * Flattens a GraphQL response's failures into one list of messages.
 *
 * @param errors - top-level `errors`: the request itself failed
 * @param userErrors - each mutation's `userErrors`: Shopify rejected the input
 */
export function collectErrorMessages(
  errors: readonly WithMessage[] | undefined,
  ...userErrors: (readonly WithMessage[] | undefined)[]
): string[] {
  return [errors, ...userErrors].flatMap(
    (list) => list?.map((error) => error.message) ?? [],
  );
}

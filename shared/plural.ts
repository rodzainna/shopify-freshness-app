// The singular or plural wording for a count, e.g. plural(n, "batch", "batches")
export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

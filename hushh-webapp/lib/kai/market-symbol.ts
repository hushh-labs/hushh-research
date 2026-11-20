export function normalizeMarketSymbol(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase();
}

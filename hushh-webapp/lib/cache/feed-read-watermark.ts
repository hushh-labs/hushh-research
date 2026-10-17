export function feedIdAtOrBefore(id: string, watermark: string): boolean {
  try {
    return BigInt(id) <= BigInt(watermark);
  } catch {
    // Feed IDs are numeric today. Exact matching is the only safe fallback if
    // that contract ever changes; lexical ordering would mark unrelated rows.
    return id === watermark;
  }
}

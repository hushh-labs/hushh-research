/** Presentation only: a partial request does not establish a delivery failure. */
export function partialDocumentDeliveryState(counts: {
  total: unknown;
  available: unknown;
  pending: unknown;
}): "available" | "unavailable" | "checking" | "unknown" {
  const { total, available, pending } = counts;
  if (
    typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0 ||
    typeof available !== "number" || !Number.isSafeInteger(available) || available < 0 ||
    typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0 ||
    available + pending > total
  ) return "unknown";
  if (pending > 0) return "checking";
  return available === total ? "available" : "unavailable";
}

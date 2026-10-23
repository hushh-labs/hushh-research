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

/** Terminal search evidence, distinct from payment or Google grant authority. */
export type DocumentRequestOutcomeReason = "no_matching_files" | "matching_files_unshareable";
export function documentRequestEmptyOutcomeLabel(reason: unknown): string {
  if (reason === "matching_files_unshareable") return "Matching files could not be shared";
  if (reason === "no_matching_files") return "No matching files";
  return "No files were shared";
}

type ReceiptItem = { requestId: string; scopeRef: string };
type ExpectedBundle = {
  bundleId: string;
  personRef: string;
  purpose: string;
  items: ReceiptItem[];
};
type BundleItem = ReceiptItem & { status: string };
const STATUSES = new Set([
  "pending",
  "granted",
  "denied",
  "cancelled",
  "revoked",
  "expired",
]);

/** Validate authoritative bundle detail, never infer cleanup from a list page. */
export function validateCleanupBundle(
  payload: unknown,
  expected: ExpectedBundle,
) {
  if (!payload || typeof payload !== "object")
    throw new Error("Cleanup detail unavailable");
  const detail = payload as Record<string, unknown>;
  if (
    detail.bundleId !== expected.bundleId ||
    detail.personRef !== expected.personRef ||
    detail.purpose !== expected.purpose ||
    !Array.isArray(detail.items) ||
    detail.items.length !== expected.items.length ||
    typeof detail.cancelled !== "boolean"
  ) {
    throw new Error("Cleanup detail does not match the run-owned bundle");
  }
  const seen = new Set<string>();
  const items: BundleItem[] = detail.items.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid cleanup item");
    const row = item as Record<string, unknown>;
    if (
      typeof row.requestId !== "string" ||
      seen.has(row.requestId) ||
      typeof row.scopeRef !== "string" ||
      typeof row.status !== "string" ||
      !STATUSES.has(row.status) ||
      !expected.items.some(
        (receipt) =>
          receipt.requestId === row.requestId &&
          receipt.scopeRef === row.scopeRef,
      )
    ) {
      throw new Error("Cleanup item does not match the run-owned receipt");
    }
    seen.add(row.requestId);
    return {
      requestId: row.requestId,
      scopeRef: row.scopeRef,
      status: row.status,
    };
  });
  return { cancelled: detail.cancelled, items };
}

export function assertCleanupComplete(
  payload: unknown,
  expected: ExpectedBundle,
) {
  const detail = validateCleanupBundle(payload, expected);
  if (
    !detail.cancelled ||
    detail.items.some(
      (item) => item.status === "granted" || item.status === "pending",
    )
  ) {
    throw new Error(
      "Run-owned bundle still has access or pending work after cleanup",
    );
  }
}

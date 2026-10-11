export interface SourceReceipt {
  id: string;
  revision: number;
  createdAt: string | null;
  updatedAt: string;
  deletedAt: string | null;
}
function knownCreation(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const field of ["createdAt", "created_at", "savedAt", "ratedAt"]) {
    if (
      typeof row[field] === "string" &&
      !Number.isNaN(Date.parse(row[field] as string))
    )
      return row[field] as string;
  }
  return null;
}
/** Source identities and revisions only; removed values never enter receipts. */
export function sourceReceipts(
  previous: Record<string, SourceReceipt>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  now: string,
): Record<string, SourceReceipt> {
  const receipts = { ...previous };
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const prior = Object.hasOwn(previous, id) ? previous[id] : undefined;
    const exists = Object.hasOwn(after, id);
    if (prior && JSON.stringify(before[id]) === JSON.stringify(after[id]))
      continue;
    Object.defineProperty(receipts, id, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        id,
        revision: (prior?.revision ?? 0) + 1,
        createdAt:
          prior?.createdAt ??
          knownCreation(before[id]) ??
          (Object.hasOwn(before, id)
            ? null
            : (knownCreation(after[id]) ?? now)),
        updatedAt: now,
        deletedAt: exists ? null : now,
      },
    });
  }
  return receipts;
}

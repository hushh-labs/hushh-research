import { PKM_QUARANTINE_SEGMENT_ID } from "./upgrade-contracts";

/** Routing IDs never rename the keys inside an encrypted record. */
export function canonicalPkmSegmentId(segmentId: string): string {
  if (
    String(segmentId || "")
      .trim()
      .toLowerCase() === PKM_QUARANTINE_SEGMENT_ID
  ) {
    return PKM_QUARANTINE_SEGMENT_ID;
  }
  return (
    String(segmentId || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "root"
  );
}

/** Exact noncanonical keys and scalars live inside the encrypted root. */
export function pkmStorageSegmentId(key: string, value: unknown): string {
  const segmentId = canonicalPkmSegmentId(key);
  const container =
    value !== null && value !== undefined && typeof value === "object";
  return container && segmentId === key ? segmentId : "root";
}

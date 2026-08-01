const MAX_LOCATION_OPERATION_ID_LENGTH = 160;

function safePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._:-]/g, "-") || "unknown";
}
function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Build a server-safe idempotency key without truncating away the recipient.
 * Long upstream action ids retain a deterministic digest of the entire value,
 * so distinct recipients and actions do not collapse onto the same 160-byte
 * prefix.
 */
export function boundedLocationOperationId(...parts: string[]): string {
  const raw = parts.map(safePart).join(":");
  if (raw.length <= MAX_LOCATION_OPERATION_ID_LENGTH) return raw;
  const digest = `${hash32(raw, 0x811c9dc5)}${hash32(raw, 0x9e3779b1)}`;
  const suffix = `:${digest}`;
  return `${raw.slice(
    0,
    MAX_LOCATION_OPERATION_ID_LENGTH - suffix.length,
  )}${suffix}`;
}

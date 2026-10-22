/** Decode the established tool envelope only; callers retain validation and authority. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

export function unwrapToolResult(value: unknown): Record<string, unknown> | null {
  const record = parseRecord(value);
  if (!record) return null;

  for (const key of ["result", "content", "data"] as const) {
    const nested = parseRecord(record[key]);
    if (nested?.status || nested?.requestableScopes) return nested;
  }
  return record;
}

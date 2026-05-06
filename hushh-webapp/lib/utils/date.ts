export function parseDateOrNull(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatIsoDateOrFallback(
  value: unknown,
  fallback = ""
): string {
  const parsed = parseDateOrNull(value);

  return parsed ? parsed.toISOString() : fallback;
}
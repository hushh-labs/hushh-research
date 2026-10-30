const _rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const _UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/**
 * Format an epoch-ms timestamp as a short relative string ("2 hours ago",
 * "just now"). `nowMs` is passed in so callers stay reload-stable and testable
 * rather than depending on a hidden clock. Returns "" for null/undefined so a
 * caller can branch on emptiness (e.g. render "not yet synced").
 */
export function formatRelativeTime(
  epochMs: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return "";
  const deltaMs = epochMs - nowMs;
  const absSec = Math.abs(deltaMs) / 1000;
  if (absSec < 45) return "just now";
  for (const [unit, secs] of _UNITS) {
    if (absSec >= secs || unit === "second") {
      return _rtf.format(Math.round(deltaMs / 1000 / secs), unit);
    }
  }
  return "just now";
}

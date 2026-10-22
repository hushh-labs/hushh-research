/** Public Market query: exchange identity is independent of viewer timezone. */
export function marketInsightsQuery(
  options: { symbols?: string[]; daysBack?: number; pickSource?: string },
  clientTimezone: string | null | undefined,
): string {
  const query = new URLSearchParams();
  if (Array.isArray(options.symbols) && options.symbols.length > 0) {
    query.set("symbols", options.symbols.join(","));
  }
  if (typeof options.daysBack === "number" && Number.isFinite(options.daysBack)) {
    query.set("days_back", String(options.daysBack));
  }
  if (typeof options.pickSource === "string" && options.pickSource.trim()) {
    query.set("pick_source", options.pickSource.trim());
  }
  // This surface shows US indices regardless of the viewer's timezone.
  query.set("exchange", "US");
  if (clientTimezone) {
    query.set("tz", clientTimezone);
  }
  return query.toString() ? `?${query.toString()}` : "";
}

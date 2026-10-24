import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";

function hasUsefulOverviewValue(value: string | number | null | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return Boolean(text) && !["n/a", "na", "unknown", "unavailable", "none", "null", "--", "-"].includes(text);
}

export function withStableOverviewFromCache(
  nextPayload: KaiHomeInsightsV2,
  cachedPayload: KaiHomeInsightsV2 | null
): KaiHomeInsightsV2 {
  if (!cachedPayload?.market_overview?.length) return nextPayload;
  const rows = nextPayload.market_overview ?? [];
  const nextByIdentity = new Map(rows.map((row) => [row.symbol || row.label, row]));
  const restored = cachedPayload.market_overview.filter((row) => {
    const next = nextByIdentity.get(row.symbol || row.label);
    return hasUsefulOverviewValue(row.value) && (!next || !hasUsefulOverviewValue(next.value));
  });
  if (!restored.length) return nextPayload;
  const restoredByIdentity = new Map(restored.map((row) => [row.symbol || row.label, row]));
  return {
    ...nextPayload,
    market_overview: [
      ...rows.map((row) => {
        const cached = restoredByIdentity.get(row.symbol || row.label);
        return cached ? { ...cached, degraded: true } : row;
      }),
      ...restored.filter((row) => !nextByIdentity.has(row.symbol || row.label))
        .map((row) => ({ ...row, degraded: true })),
    ],
  };
}


import { describe, expect, it } from "vitest";
import { normalizePriceHistory, priceHistoryRanges, slicePriceHistory } from "@/lib/kai/price-history";
import { readKaiStockHistory } from "@/lib/services/kai-stock-history-read";

describe("Observed chart history", () => {
  it("keeps saved provenance and rejects malformed provider dates before rendering", async () => {
    const result = await readKaiStockHistory("owner", "TEST", "synthetic-token", async () => new Response(JSON.stringify({
      points: [{ t: 1792000000, p: 230 }, { t: 1792086400, p: 232 }, { t: 1e20, p: 233 }, { t: "bad", p: 240 }],
      source: "Recorded daily source", stale: true, cached: true, retrieved_at: "2026-10-20T20:00:00Z",
    })));
    expect(result.points).toHaveLength(2);
    expect(result).toMatchObject({ source: "Recorded daily source", stale: true, cached: true, retrievedAt: "2026-10-20T20:00:00Z" });
    const legacy = await readKaiStockHistory("owner", "TEST", "synthetic-token", async () => new Response(JSON.stringify({ points: [], stale: true, retrieved_at: null })));
    expect(legacy).toEqual({ points: [], stale: true, retrievedAt: null });
    expect((await readKaiStockHistory("owner", "CUSIP", "synthetic-token", async () => new Response(null, { status: 422 }))).unavailableReason).toBe("unsupported_symbol");
  });
  it("rejects invalid observations, deduplicates timestamps, and preserves a genuine zero balance", () => {
    expect(normalizePriceHistory([
      { date: "2026-10-03", value: 232 }, { date: "bad date", value: 123 },
      { date: "2026-10-01", value: 0 }, { date: "2026-10-02", value: NaN },
      { date: "2026-10-03", value: 233 }, { date: "2026-10-04", value: -1 },
    ])).toEqual([{ date: "2026-10-01", value: 0 }, { date: "2026-10-03", value: 233 }]);
  });
  it("offers only covered ranges and anchors them to the last observation, not today's date", () => {
    const data = [{ date: "2025-01-01", value: 100 }, { date: "2025-01-24", value: 110 }, { date: "2025-01-31", value: 112 }];
    expect(priceHistoryRanges(data)).toEqual(["1w", "1m"]);
    expect(slicePriceHistory(data, "1w")).toEqual(data.slice(1));
    expect(priceHistoryRanges(data.slice(-1))).toEqual([]);
    expect(priceHistoryRanges([{ date: "2025-01-01", value: 100 }, { date: "2025-02-01", value: 110 }])).toEqual([]);
  });
});

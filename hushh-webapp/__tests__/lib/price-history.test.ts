import { describe, expect, it } from "vitest";
import { normalizePriceHistory, priceHistoryRanges, slicePriceHistory } from "@/lib/kai/price-history";

describe("Observed chart history", () => {
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

import { describe, expect, it } from "vitest";
import { extractTickerMarketSnapshotFromKaiHome, marketSnapshotForTicker, pickPreferredMarketSnapshot, type TickerMarketSnapshot } from "@/lib/kai/market-snapshot";
import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";

const apple: TickerMarketSnapshot = { ticker: "AAPL", last_price: 200, change_pct: 1, observed_at: "2026-10-21T15:00:00Z", source: "fixture" };
const microsoft: TickerMarketSnapshot = { ticker: "MSFT", last_price: 400, change_pct: -1, observed_at: "2026-10-21T14:00:00Z", source: "fixture" };

describe("display quote identity", () => {
  it("discards the previous ticker even when its quote is newer or the next quote is missing", () => {
    expect(pickPreferredMarketSnapshot(apple, microsoft, "MSFT")).toEqual(microsoft);
    expect(pickPreferredMarketSnapshot(apple, null, "MSFT")).toBeNull();
    expect(pickPreferredMarketSnapshot(microsoft, apple, "MSFT")).toEqual(microsoft);
  });

  it("never renders a retained quote under another ticker while effects are pending", () => {
    expect(marketSnapshotForTicker(apple, "MSFT")).toBeNull();
    expect(marketSnapshotForTicker(apple, "aapl")).toBe(apple);
    expect(pickPreferredMarketSnapshot(apple, { ...apple, observed_at: "2026-10-21T14:00:00Z" }, "AAPL")).toBe(apple);
  });

  it("keeps a missing quote observation time distinct from response generation time", () => {
    const snapshot = extractTickerMarketSnapshotFromKaiHome({
      generated_at: "2026-10-21T16:00:00Z",
      watchlist: [{ symbol: "AAPL", price: 200, change_pct: 0, as_of: null }],
    } as unknown as KaiHomeInsightsV2, "aapl");
    expect(snapshot).toMatchObject({ ticker: "AAPL", last_price: 200, change_pct: 0, observed_at: null });
  });
});

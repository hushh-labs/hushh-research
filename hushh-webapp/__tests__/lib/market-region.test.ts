import { beforeEach, describe, expect, it } from "vitest";
import {
  marketFromHoldings,
  readSelectedMarketRegion,
  resolveMarketRegion,
  storeSelectedMarketRegion,
} from "@/lib/kai/market-region";

const indian = [{ symbol: "RELIANCE.NS" }, { symbol: "INFY", currency: "INR" }, { symbol: "AAPL", currency: "USD" }];
const american = [{ symbol: "AAPL", currency: "USD" }, { symbol: "MSFT", currency: "USD" }];

beforeEach(() => window.localStorage.clear());

describe("market region", () => {
  it("follows selected market, then portfolio, then account phone, then device language", () => {
    const everything = { holdings: american, phoneNumber: "+919876543210", localeTag: "en-IN" };
    expect(resolveMarketRegion({ ...everything, selected: "IN" })).toEqual({ region: "IN", source: "selected" });
    // A US portfolio outranks an Indian phone number and an Indian locale.
    expect(resolveMarketRegion(everything)).toEqual({ region: "US", source: "portfolio" });
    expect(resolveMarketRegion({ holdings: indian, phoneNumber: "+14155550123", localeTag: "en-US" })).toEqual({ region: "IN", source: "portfolio" });
    expect(resolveMarketRegion({ phoneNumber: "+919876543210", localeTag: "en-US" })).toEqual({ region: "IN", source: "account" });
    expect(resolveMarketRegion({ phoneNumber: "+14155550123", localeTag: "en-IN" })).toEqual({ region: "US", source: "account" });
    expect(resolveMarketRegion({ localeTag: "en-IN" })).toEqual({ region: "IN", source: "device" });
    expect(resolveMarketRegion({})).toEqual({ region: "US", source: "default" });
  });

  it("judges the portfolio by most of its holdings and ignores an empty one", () => {
    expect(marketFromHoldings([])).toBeNull();
    expect(marketFromHoldings(indian)).toBe("IN");
    expect(marketFromHoldings([{ symbol: "TCS.NS" }, { symbol: "AAPL" }])).toBe("US");
  });

  it("remembers the selection per person", () => {
    storeSelectedMarketRegion("user_a", "IN");
    expect(readSelectedMarketRegion("user_a")).toBe("IN");
    expect(readSelectedMarketRegion("user_b")).toBeNull();
  });
});

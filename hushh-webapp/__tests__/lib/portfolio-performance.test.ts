import { describe, expect, it } from "vitest";
import type { DashboardPosition } from "@/components/kai/views/dashboard-portfolio-model";
import { rankMovers, sinceBought, winnersLosers } from "@/lib/kai/portfolio-performance";

const position = (id: string, gainLoss: number | null, over: Partial<DashboardPosition> = {}): DashboardPosition => ({
  id, rawSymbol: id, displaySymbol: id, tickerSymbol: id, identifierType: "ticker", name: id,
  marketValue: 1000, costBasis: 900, quantity: 1, price: 1000, gainLoss, gainLossPct: null,
  estimatedAnnualIncome: null, estimatedYield: null, sector: null, assetType: null, assetBucket: "equity",
  isCashEquivalent: false, debateEligible: true, optimizeEligible: true, aliases: [], ...over,
});

describe("sinceBought", () => {
  it("sums reported gains against cost and says how many positions it covers", () => {
    const result = sinceBought([position("A", 100, { costBasis: 400 }), position("B", -50, { costBasis: 600 }), position("C", null, { costBasis: 0 })]);
    expect(result).toEqual({ gain: 50, pct: 5, covered: 2, eligible: 3 });
  });

  it("is null when no position reports a gain, and ignores cash", () => {
    expect(sinceBought([position("A", null), position("CASH", 5, { isCashEquivalent: true })])).toBeNull();
  });
});

describe("rankMovers", () => {
  it("ranks by dollar amount, drops flat and cash, and caps each side", () => {
    const { gains, losses } = rankMovers([
      position("A", 10), position("B", 300), position("C", 200), position("D", 50),
      position("E", -400), position("F", -20), position("FLAT", 0), position("CASH", 900, { isCashEquivalent: true }),
    ], 3);
    expect(gains.map((p) => p.id)).toEqual(["B", "C", "D"]);
    expect(losses.map((p) => p.id)).toEqual(["E", "F"]);
  });
});

describe("winnersLosers", () => {
  it("maps the five bands to down, flat and up totals", () => {
    const summary = winnersLosers([
      { band: "< -10%", count: 2 }, { band: "-10% to -2%", count: 3 }, { band: "-2% to +2%", count: 4 },
      { band: "+2% to +10%", count: 5 }, { band: "> +10%", count: 6 },
    ]);
    expect([summary.down, summary.flat, summary.up, summary.total]).toEqual([5, 4, 11, 20]);
  });
});

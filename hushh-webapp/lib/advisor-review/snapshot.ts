import { advisorSnapshotSchema, type AdvisorSnapshot } from "./contract";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import type { FinanceSource } from "@/lib/finance-sharing/contract";

/** Named Finance fields only: no account numbers, credentials, transactions or unrelated memory. */
export async function captureAdvisorSnapshot(
  context: FinanceShareContext,
  source: FinanceSource,
): Promise<AdvisorSnapshot> {
  const saved = await readSavedFinance(context, source, true);
  const profile = saved.profile;
  requireFinanceSession(context);
  const holdings = saved.portfolio.holdings || [];
  if (holdings.length > 2000)
    throw new Error(
      "This portfolio has more than 2,000 positions. A complete snapshot cannot be prepared yet.",
    );
  if (
    holdings.some(
      (h) =>
        !Number.isFinite(h.market_value) ||
        h.market_value < 0 ||
        h.is_short ||
        h.is_short_position ||
        h.is_liability_position,
    )
  ) {
    throw new Error(
      "This source includes positions that cannot be represented accurately in this snapshot.",
    );
  }
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return advisorSnapshotSchema.parse({
    schema: "advisor-finance-snapshot-v1",
    capturedAt: new Date().toISOString(),
    source: source.kind,
    period: saved.model.hero.statementPeriod ?? null,
    total: saved.model.hero.totalValue,
    cash: number(
      saved.portfolio.account_summary?.cash_balance ??
        saved.portfolio.cash_balance,
    ),
    holdings: holdings.map((h) => ({
      symbol: h.symbol || "",
      name: h.name || h.symbol,
      value: h.market_value,
      quantity: number(h.quantity),
      costBasis: number(h.cost_basis),
      sector: h.sector || null,
      assetType: h.asset_type || h.asset_class || null,
    })),
    allocation: saved.model.allocation,
    history: saved.model.quality.historyReady ? saved.model.history : [],
    profile: {
      horizon: profile?.preferences.investment_horizon ?? null,
      risk: profile?.preferences.risk_profile ?? null,
      drawdown: profile?.preferences.drawdown_response ?? null,
      volatility: profile?.preferences.volatility_preference ?? null,
    },
    nonce: Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
  });
}

export function snapshotInformation(snapshot: AdvisorSnapshot) {
  const { nonce: _nonce, capturedAt: _capturedAt, ...information } = snapshot;
  return information;
}

import type { DashboardViewModel } from "./dashboard-data-mapper";
import type { PortfolioData } from "@/components/kai/types/portfolio";

export interface PortfolioDisplayFacts {
  cash: number | null;
  invested: number | null;
  change: number | null;
  changePct: number | null;
}

export function overviewFacts(model: DashboardViewModel, portfolio?: PortfolioData | null): PortfolioDisplayFacts {
  const positions = model.canonicalModel.positions;
  const summary = portfolio?.account_summary;
  const cash = positions.some(position => position.isCashEquivalent)
    ? model.canonicalModel.totals.cashValue
    : finiteAmount(summary?.cash_balance) ?? finiteAmount(portfolio?.cash_balance);
  const invested = positions.length ? positions.filter(position => !position.isCashEquivalent).reduce((total, position) => total + position.marketValue, 0) : null;
  const beginning = finiteAmount(summary?.beginning_value);
  const change = finiteAmount(summary?.change_in_value) ?? (beginning === null ? null : model.hero.totalValue - beginning);
  return { cash, invested, change, changePct: beginning !== null && beginning > 0 && change !== null ? change / beginning * 100 : null };
}

function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


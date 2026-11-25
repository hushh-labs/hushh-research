import type { DashboardViewModel } from "./dashboard-data-mapper";

export function topPortfolioWeights(model: DashboardViewModel) {
  const total = model.hero.totalValue;
  if (!(total > 0) || !Number.isFinite(total)) return [];
  const weights = new Map<string, { name: string; value: number }>();
  for (const position of model.canonicalModel.positions) {
    if (!Number.isFinite(position.marketValue) || position.marketValue <= 0)
      continue;
    const name = position.name || position.displaySymbol || "Unnamed holding";
    const key = position.displaySymbol || name;
    const previous = weights.get(key);
    weights.set(key, {
      name,
      value: (previous?.value ?? 0) + position.marketValue,
    });
  }
  return [...weights.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(({ name, value }) => ({ name, percent: (value / total) * 100 }))
    .filter(({ percent }) => percent > 0 && percent <= 100);
}

export function portfolioDownsideFacts(model?: DashboardViewModel) {
  const total = model?.hero.totalValue ?? 0;
  const positions = model?.canonicalModel.positions ?? [];
  const stocks = new Map<string, { name: string; value: number }>();
  for (const position of positions) {
    if (!position.tickerSymbol || !Number.isFinite(position.marketValue) || position.marketValue <= 0 ||
        position.assetBucket !== "equity" || position.isCashEquivalent ||
        !/^(common stock|preferred stock|stocks?|equit(?:y|ies))$/i.test(position.assetType?.trim() ?? "")) continue;
    const key = position.tickerSymbol;
    stocks.set(key, { name: position.name || key, value: (stocks.get(key)?.value ?? 0) + position.marketValue });
  }
  const largest = [...stocks.values()].sort((a, b) => b.value - a.value)[0];
  const stockWeight = largest ? largest.value / total : 0;
  const stock = largest && stockWeight >= 0.15 && stockWeight <= 1 ? largest : undefined;
  const buckets = model?.canonicalModel.allocation ?? [];
  const bucketCoverage = buckets.reduce((sum, { value }) => sum + value, 0) / total;
  const investedBuckets = buckets.filter(({ key }) =>
    key === "equity" || key === "fixed_income" || key === "real_asset");
  const investedValue = investedBuckets.reduce((sum, { value }) => sum + value, 0);
  const investedWeight = investedValue / total;
  const hasCompleteBalances = bucketCoverage >= 0.99 && bucketCoverage <= 1.01
    && positions.every(({ marketValue }) => Number.isFinite(marketValue) && marketValue >= 0);
  const canShowInvestedScenario = hasCompleteBalances && investedWeight > 0 && investedWeight <= 1;
  return {
    stock,
    investedValue,
    hasCompleteBalances,
    canShowInvestedScenario,
    weight: stock ? stockWeight : investedWeight,
    subject: stock?.name ?? investedBuckets.map(({ label }) => label).join(", "),
    assumptions: stock
      ? "Assumes all other holdings stay flat."
      : "Assumes these investments fall together and everything else stays flat.",
  };
}

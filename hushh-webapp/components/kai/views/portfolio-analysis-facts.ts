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

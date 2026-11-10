import { topPortfolioWeights } from "@/components/kai/views/portfolio-analysis-facts";
import { getInvestingPersona, portfolioPlanningSignals } from "@/lib/kai/investing-persona";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { financeDigest, type FinanceSource } from "./contract";
import { readSavedFinance } from "./saved-source";

export async function readPortfolioReviewInput(
  context: FinanceShareContext,
  source: FinanceSource,
) {
  const { model, profile, sourceFence } = await readSavedFinance(
    context,
    source,
    true,
  );
  const preferences = profile.preferences;
  const { horizon, lossCapacity } = portfolioPlanningSignals(preferences);
  const top = topPortfolioWeights(model);
  const total = model.hero.totalValue;
  const allocation = model.allocation
    .flatMap(({ name, value }) =>
      total > 0 && value > 0 && value <= total
        ? [{ name: name.slice(0, 60), percent: (value / total) * 100 }]
        : [],
    )
    .slice(0, 8);
  const allocationCoverage = allocation.reduce(
    (sum, row) => sum + row.percent,
    0,
  );
  const payload = {
    allow_model_processing: true,
    position_count: model.hero.holdingsCount,
    top_positions: top.map((row) => ({ ...row, name: row.name.slice(0, 60) })),
    allocation,
    history_available: model.quality.historyReady,
    persona: getInvestingPersona(preferences).kind,
    horizon,
    loss_capacity: lossCapacity,
    assessable:
      top.length > 0 &&
      allocationCoverage >= 99 &&
      allocationCoverage <= 101 &&
      model.canonicalModel.positions.every(
        (row) => Number.isFinite(row.marketValue) && row.marketValue >= 0,
      ) &&
      horizon !== null &&
      lossCapacity !== null,
  };
  const digest = await financeDigest(
    JSON.stringify([
      "portfolio-review-v1",
      sourceFence,
      payload,
      total,
      model.canonicalModel.positions.map((row) => [row.id, row.marketValue]),
      model.history,
    ]),
  );
  return { payload, digest, sourceFence, model, preferences };
}

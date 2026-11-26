"use client";

import { useState } from "react";
import { PortfolioSourceDetails } from "@/components/agent/finance-portfolio-source-details";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { PortfolioAllocationBar } from "@/components/kai/charts/portfolio-allocation-bar";
import { PortfolioHistoryChart } from "@/components/kai/charts/portfolio-history-chart";
import { PerformanceStrip } from "@/components/kai/performance/performance-strip";
import { asRecord } from "@/lib/agent/tool-result-envelope";
import { formatSavedPortfolioMoney } from "@/lib/kai/market-value-format";
import type { SinceBought } from "@/lib/kai/portfolio-performance";
import { normalizePriceHistory } from "@/lib/kai/price-history";

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readSinceBought(value: unknown): SinceBought | null {
  const gain = asRecord(value);
  const totalGain = amount(gain?.gain);
  const covered = count(gain?.covered);
  const eligible = count(gain?.eligible);
  if (totalGain === null || covered === null || eligible === null || covered < 1 || covered > eligible) return null;
  return { gain: totalGain, pct: amount(gain?.pct), covered, eligible };
}

function PortfolioAllocation({ snapshot, currency }: { snapshot: Record<string, unknown>; currency: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 6) return null;
  const rows = snapshot.rows.flatMap(value => {
    const row = asRecord(value);
    const name = row?.name;
    const valueHeld = amount(row?.value);
    return typeof name === "string" && name.trim() && name.length <= 80 && valueHeld !== null && valueHeld > 0
      ? [{ name, value: valueHeld }]
      : [];
  });
  const total = amount(snapshot.totalValue);
  if (!rows.length || rows.length !== snapshot.rows.length || total === null || total <= 0) return null;
  return (
    <PortfolioAllocationBar
      embedded
      data={rows}
      totalValue={total}
      selectedName={rows.some(row => row.name === selected) ? selected : null}
      onSelectionChange={setSelected}
      description="Select a category to highlight it."
      formatValue={value => formatSavedPortfolioMoney(value, currency)}
    />
  );
}

export default function A2uiPortfolioRead({
  component, value,
}: {
  component: "PortfolioAllocation" | "PortfolioPerformance" | "PortfolioSources";
  value: unknown;
}) {
  const snapshot = asRecord(value);
  if (component === "PortfolioSources") {
    if (snapshot?.kind === "plaid") return <PortfolioSourceDetails source={{ kind: "plaid" }} />;
    if (snapshot?.kind !== "statement") return <PortfolioSourceDetails source={null} />;
    return <PortfolioSourceDetails source={{
      kind: "statement",
      fileName: typeof snapshot.fileName === "string" ? snapshot.fileName : null,
      importedAt: typeof snapshot.importedAt === "string" ? snapshot.importedAt : null,
    }} />;
  }
  const currency = snapshot?.currency;
  if (!snapshot || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (component === "PortfolioAllocation") return <PortfolioAllocation snapshot={snapshot} currency={currency} />;
  const valueHeld = amount(snapshot.value);
  const invested = amount(snapshot.invested);
  const cash = amount(snapshot.cash);
  const sinceBought = readSinceBought(snapshot.sinceBought);
  const history = Array.isArray(snapshot.history) ? normalizePriceHistory(snapshot.history.flatMap(value => {
    const point = asRecord(value);
    const observation = amount(point?.value);
    return typeof point?.date === "string" && observation !== null ? [{ date: point.date, value: observation }] : [];
  })) : [];
  const hasSummary = valueHeld !== null || invested !== null || cash !== null || sinceBought !== null;
  if (!hasSummary && history.length < 2) return null;
  return (
    <div className="space-y-2">
      {hasSummary ? <PerformanceStrip
        value={valueHeld}
        invested={invested}
        cash={cash}
        sinceBought={sinceBought}
        period="Since purchase"
        formatValue={value => formatSavedPortfolioMoney(value, currency)}
      /> : null}
      {sinceBought && sinceBought.covered < sinceBought.eligible ? (
        <p className="ui-text-row-description">
          Since-purchase figures cover {sinceBought.covered} of {sinceBought.eligible} positions.
        </p>
      ) : null}
      {history.length >= 2 ? (
        <SurfaceCard>
          <SurfaceCardContent className="p-4">
            <PortfolioHistoryChart
              data={history}
              height={220}
              currency={currency}
              formatValue={(value, compact) => formatSavedPortfolioMoney(value, currency, compact)}
            />
          </SurfaceCardContent>
        </SurfaceCard>
      ) : null}
    </div>
  );
}

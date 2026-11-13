"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Building2, PieChart, Wallet } from "@/components/icons";
import { DataTable } from "@/components/app-ui/data-table";
import { Accordion } from "@/components/ui/accordion";
import { PortfolioReviewSummary } from "@/components/kai/cards/portfolio-review-summary";
import { PortfolioReviewSection, PortfolioReviewHoldingsPanel } from "./portfolio-review-layout";
import type { LiveHoldingPreview } from "@/lib/kai/import/live-holdings-preview";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";

function Bar({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block h-3 rounded bg-muted motion-safe:animate-pulse", className)} />;
}

type PreviewRow = { id: string; holding?: LiveHoldingPreview };
const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : null;

function Label({ holding }: PreviewRow) {
  return <span className={cn("block min-w-0 space-y-1", holding && "motion-step-enter")}>
    {holding ? <>
      <span className="block truncate ui-text-row-label-emphasized">{holding.symbol || holding.name}</span>
      <span className="block truncate ui-text-row-description text-muted-foreground">{holding.name}</span>
    </> : <><Bar className="w-12" /><Bar className="h-2.5 w-24" /></>}
  </span>;
}

// The ready table's column contract and responsive card layout. Preview values
// have no currency/price/cost-basis contract, so those cells stay unknown.
const columns: ColumnDef<PreviewRow>[] = [
  { id: "entries", header: "Entries", cell: () => <span className="flex min-h-11 items-center"><Bar className="w-14" /></span> },
  { id: "holding", header: "Holding", cell: ({ row }) => <Label {...row.original} /> },
  { id: "shares", header: "Shares @ Price", cell: ({ row }) => <span className="ui-text-row-description tabular-nums">{number(row.original.holding?.quantity) ?? <Bar className="w-14" />}</span> },
  { id: "value", header: () => <span className="block text-right">Market value</span>, cell: () => <Bar className="ml-auto w-16" /> },
  { id: "gain", header: () => <span className="block text-right">Gain / Loss</span>, cell: () => <Bar className="ml-auto w-16" /> },
];

export function ImportReviewPlaceholder({ rows = [], total }: { rows?: readonly LiveHoldingPreview[]; total?: number | null }) {
  const data: PreviewRow[] = rows.map((holding, index) => ({ id: `${holding.symbol ?? "holding"}-${index}`, holding }));
  const remaining = rows.length === 0 ? 4 : typeof total === "number" ? Math.max(0, Math.min(2, total - rows.length)) : 2;
  for (let index = 0; index < remaining; index++) data.push({ id: `pending-${index}` });
  return <div aria-busy="true" className="space-y-4">
    <PortfolioReviewSummary loading totalValue={0} unrealizedGainLoss={0} holdingCount={0} riskBucket="" cashBalance={0} />
    <Accordion type="multiple" className="w-full min-w-0 space-y-3">
      <PortfolioReviewSection pending value="account" title="Account Information" icon={<Building2 className="size-4" aria-hidden="true" />} />
      <PortfolioReviewSection pending value="allocation" title="Asset Allocation" icon={<PieChart className="size-4" aria-hidden="true" />} />
      <PortfolioReviewSection pending value="income" title="Income Summary" icon={<Wallet className="size-4" aria-hidden="true" />} />
    </Accordion>
    <PortfolioReviewHoldingsPanel actions={<span aria-hidden="true" className="flex min-h-11 w-28 items-center"><Bar className="w-full" /></span>}>
      <div className="flex flex-col gap-3">
        <Bar className="h-11 w-full" />
        <section aria-label={rows.length ? "Holdings found so far" : "Finding holdings"}>
          <Bar className="mb-3 h-10 w-full" />
          <DataTable columns={columns} data={data} enableSearch={false} tableClassName={financeStyles.reviewTable}
            paginate={false} density="compact" renderMobileCard={row => (
              <article className="motion-step-enter grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border py-2">
                <Label {...row} />
                <span className="grid min-h-24 justify-items-end gap-1 text-right">
                  <Bar className="w-16" />
                  <span className="ui-text-row-description tabular-nums text-muted-foreground">{number(row.holding?.quantity) ?? <Bar className="w-14" />}</span>
                  <Bar className="w-12" /><span aria-hidden="true" className="min-h-11 w-20" />
                </span>
              </article>
            )} />
        </section>
      </div>
    </PortfolioReviewHoldingsPanel>
  </div>;
}

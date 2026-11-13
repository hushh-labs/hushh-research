"use client";

import { useMemo } from "react";
import { extractionPreviewRows, formatImportNumber, type ImportExtractionProgress } from "@/lib/kai/import/extraction-progress";
import type { PortfolioImportExtractionRow } from "@/lib/streaming/kai-stream-types";
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

type PreviewRow = { id: string; holding?: PortfolioImportExtractionRow; currency?: string | null };
const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : null;

function Label({ holding }: PreviewRow) {
  return <span className={cn("block min-w-0 space-y-1", holding && "motion-step-enter")}>
    {holding ? <>
      <span className="block truncate ui-text-row-label-emphasized">{holding.symbol || holding.ticker || holding.symbol_cusip || holding.cusip || holding.security_id || holding.name || holding.description}</span>
      <span className="block truncate ui-text-row-description text-muted-foreground">{holding.name || holding.description}</span>
    </> : <><Bar className="w-12" /><Bar className="h-2.5 w-24" /></>}
  </span>;
}

// Source rows remain separate, even when two entries refer to the same security.
const columns: ColumnDef<PreviewRow>[] = [
  { id: "entries", header: "Entries", cell: () => <span className="flex min-h-11 items-center"><Bar className="w-14" /></span> },
  { id: "holding", header: "Holding", cell: ({ row }) => <Label {...row.original} /> },
  { id: "shares", header: "Shares @ Price", cell: ({ row }) => <span className="ui-text-row-description tabular-nums">{number(row.original.holding?.quantity) ?? <Bar className="w-14" />}<span className="block text-muted-foreground">{formatImportNumber(row.original.holding?.price, row.original.currency)}</span></span> },
  { id: "value", header: () => <span className="block text-right">Market value</span>, cell: ({ row }) => <span className="block text-right ui-text-row-label tabular-nums">{formatImportNumber(row.original.holding?.market_value, row.original.currency) ?? <Bar className="ml-auto w-16" />}</span> },
  { id: "gain", header: () => <span className="block text-right">Gain / Loss</span>, cell: ({ row }) => <span className="block text-right ui-text-row-description tabular-nums">{formatImportNumber(row.original.holding?.unrealized_gain_loss, row.original.currency) ?? <Bar className="ml-auto w-16" />}</span> },
];

function ReadOnlyFacts({ facts }: { facts: Record<string, string | number | null | undefined> }) {
  const entries = Object.entries(facts).filter(([, value]) => value != null && value !== "");
  if (!entries.length) return null;
  return <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{entries.map(([label, value]) => <div key={label} className="min-w-0">
    <dt className="ui-text-row-description text-muted-foreground">{label}</dt><dd className="ui-text-row-label break-words motion-step-enter">{value}</dd>
  </div>)}</dl>;
}

export function ImportReviewPlaceholder({ rows = [], total, extraction }: { rows?: readonly LiveHoldingPreview[]; total?: number | null; extraction?: ImportExtractionProgress | null }) {
  const sourceRows = useMemo<PortfolioImportExtractionRow[]>(() => extraction ? extractionPreviewRows(extraction) : rows.map((row, index) => ({ ...row, source_id: `legacy:${index}` })), [extraction, rows]);
  const facts = extraction?.facts;
  const currency = facts?.currency || facts?.statement_details?.currency;
  const account = facts?.statement_details;
  const summary = facts?.portfolio_summary;
  const data: PreviewRow[] = sourceRows.map(holding => ({ id: holding.source_id, holding, currency: holding.currency || currency }));
  const remaining = sourceRows.length === 0 ? 4 : typeof total === "number" ? Math.max(0, Math.min(2, total - sourceRows.length)) : 2;
  for (let index = 0; index < remaining; index++) data.push({ id: `pending-${index}` });
  return <div aria-busy="true" className="space-y-4">
    <PortfolioReviewSummary loading totalValue={0} unrealizedGainLoss={0} holdingCount={0} riskBucket="" cashBalance={0} preview={extraction ? {
      totalValue: facts?.total_value ?? summary?.ending_value, cashBalance: facts?.cash_balance,
      positionsFound: extraction.foundCount, currency,
    } : undefined} />
    <Accordion type="multiple" className="w-full min-w-0 space-y-3">
      <PortfolioReviewSection pending value="account" title="Account Information" icon={<Building2 className="size-4" aria-hidden="true" />} pendingContent={<ReadOnlyFacts facts={{ Institution: account?.institution_name, Account: account?.account_name, "Account number": account?.account_number, Type: account?.account_type, "Period start": account?.statement_period_start, "Period end": account?.statement_period_end }} />} />
      <PortfolioReviewSection pending value="allocation" title="Asset Allocation" icon={<PieChart className="size-4" aria-hidden="true" />} />
      <PortfolioReviewSection pending value="income" title="Income Summary" icon={<Wallet className="size-4" aria-hidden="true" />} pendingContent={<ReadOnlyFacts facts={{ Income: formatImportNumber(summary?.income, currency), Fees: formatImportNumber(summary?.fees, currency) }} />} />
    </Accordion>
    <PortfolioReviewHoldingsPanel actions={<span aria-hidden="true" className="flex min-h-11 w-28 items-center"><Bar className="w-full" /></span>}>
      <div className="flex flex-col gap-3">
        <Bar className="h-11 w-full" />
        <section aria-label={sourceRows.length ? "Holdings found so far" : "Finding holdings"}>
          <Bar className="mb-3 h-10 w-full" />
          {extraction && extraction.foundCount > extraction.retainedCount ? <p className="ui-text-row-description text-muted-foreground">Showing the first {extraction.retainedCount.toLocaleString()} of {extraction.foundCount.toLocaleString()} entries found. All entries will be available when checking finishes.</p> : null}
          <DataTable columns={columns} data={data} enableSearch={false} tableClassName={financeStyles.reviewTable}
            paginate={data.length > 10} density="compact" renderMobileCard={row => (
              <article className="motion-step-enter grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border py-2">
                <Label {...row} />
                <span className="grid min-h-24 justify-items-end gap-1 text-right">
                  <span className="ui-text-row-label tabular-nums">{formatImportNumber(row.holding?.market_value, row.currency) ?? <Bar className="w-16" />}</span>
                  <span className="ui-text-row-description tabular-nums text-muted-foreground">{number(row.holding?.quantity) ?? <Bar className="w-14" />}</span>
                  <span className="ui-text-row-description tabular-nums">{formatImportNumber(row.holding?.unrealized_gain_loss, row.currency) ?? <Bar className="w-12" />}</span><span aria-hidden="true" className="min-h-11 w-20" />
                </span>
              </article>
            )} />
        </section>
      </div>
    </PortfolioReviewHoldingsPanel>
  </div>;
}

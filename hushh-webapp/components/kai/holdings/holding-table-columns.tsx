"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { cn } from "@/lib/utils";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { toHoldingViewModel, type HoldingsListItem } from "./holding-view-model";
import { HoldingGainLoss } from "./holding-gain-loss";

const money = (value: number | null, currency?: string) => value === null ? "—" : formatCurrency(value, currency);
const numeric = "block whitespace-nowrap text-right text-sm tabular-nums";

/** Table and detail use the same statement values, missing-value and gain rules. */
export function holdingTableColumns(total: number, onEntries?: (id: string) => void): ColumnDef<HoldingsListItem>[] {
  const columns: ColumnDef<HoldingsListItem>[] = [
    {
      accessorKey: "symbol", header: "Holding",
      cell: ({ row }) => {
        const holding = row.original;
        return <div className={cn("flex w-40 min-w-0 items-center gap-2", holding.pending_delete && "opacity-60")}>
          <SymbolAvatar symbol={holding.symbol} name={holding.name} isCash={holding.is_cash_equivalent} size="sm" />
          <div className="min-w-0">
            <span className={cn("block truncate font-semibold", holding.pending_delete && "line-through")}>{holding.symbol}</span>
            <span title={holding.name} className="block truncate text-xs text-muted-foreground">{holding.name || "Unnamed security"}</span>
            {holding.entries && holding.entries.length > 1 ? <span className="block text-xs text-muted-foreground">{holding.entries.length} entries</span> : null}
            {holding.is_cash_equivalent ? <span className="text-xs text-emerald-600 dark:text-emerald-400">Cash</span> : null}
            {holding.pending_delete ? <span className="text-xs text-rose-600 dark:text-rose-400">Pending delete</span> : null}
          </div>
        </div>;
      },
    },
    { id: "shares", header: () => <span className={numeric}>Shares</span>, cell: ({ row }) =>
      <span className={numeric}>{toHoldingViewModel(row.original, total).shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span> },
    { accessorKey: "price", header: () => <span className={numeric}>Price</span>, cell: ({ row }) =>
      <span className={numeric}>{money(toHoldingViewModel(row.original, total).currentPrice, row.original.currency || row.original.iso_currency_code)}</span> },
    { accessorKey: "market_value", header: () => <span className={numeric}>Market value</span>, cell: ({ row }) =>
      <span className={cn(numeric, "font-semibold")}>{money(toHoldingViewModel(row.original, total).marketValue, row.original.currency || row.original.iso_currency_code)}</span> },
    { id: "weight", header: () => <span className={numeric}>Weight</span>, cell: ({ row }) =>
      <span className={cn(numeric, "text-muted-foreground")}>{toHoldingViewModel(row.original, total).portfolioWeightPct.toFixed(1)}%</span> },
    { id: "gain_loss", header: () => <span className={numeric}>Gain / loss</span>, cell: ({ row }) =>
      <HoldingGainLoss className={numeric} holding={toHoldingViewModel(row.original, total)} /> },
  ];
  if (onEntries) columns.unshift({ id: "entries", header: "Entries", cell: ({ row }) =>
    <ShellActionSurface variant="pill" className="h-11 text-sm sm:text-sm" onClick={event => {
      event.stopPropagation(); onEntries(row.original.client_id);
    }}>Manage entries</ShellActionSurface> });
  return columns;
}

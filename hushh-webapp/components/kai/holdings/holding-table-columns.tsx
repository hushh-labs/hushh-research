"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { toHoldingViewModel, type HoldingsListItem } from "./holding-view-model";

const money = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 2,
}).format(value);
const numeric = "block whitespace-nowrap text-right text-sm tabular-nums";

/** Table and detail use the same statement values, missing-value and gain rules. */
export function holdingTableColumns(total: number): ColumnDef<HoldingsListItem>[] {
  return [
    {
      accessorKey: "symbol", header: "Holding",
      cell: ({ row }) => {
        const holding = row.original;
        return <div className={cn("flex w-40 min-w-0 items-center gap-2", holding.pending_delete && "opacity-60")}>
          <SymbolAvatar symbol={holding.symbol} name={holding.name} isCash={holding.is_cash_equivalent} size="sm" />
          <div className="min-w-0">
            <span className={cn("block truncate font-semibold", holding.pending_delete && "line-through")}>{holding.symbol}</span>
            <span title={holding.name} className="block truncate text-xs text-muted-foreground">{holding.name || "Unnamed security"}</span>
            {holding.is_cash_equivalent ? <span className="text-xs text-emerald-600 dark:text-emerald-400">Cash</span> : null}
            {holding.pending_delete ? <span className="text-xs text-rose-600 dark:text-rose-400">Pending delete</span> : null}
          </div>
        </div>;
      },
    },
    { id: "shares", header: () => <span className={numeric}>Shares</span>, cell: ({ row }) =>
      <span className={numeric}>{toHoldingViewModel(row.original, total).shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span> },
    { accessorKey: "price", header: () => <span className={numeric}>Price</span>, cell: ({ row }) =>
      <span className={numeric}>{money(toHoldingViewModel(row.original, total).currentPrice)}</span> },
    { accessorKey: "market_value", header: () => <span className={numeric}>Market value</span>, cell: ({ row }) =>
      <span className={cn(numeric, "font-semibold")}>{money(toHoldingViewModel(row.original, total).marketValue)}</span> },
    { id: "weight", header: () => <span className={numeric}>Weight</span>, cell: ({ row }) =>
      <span className={cn(numeric, "text-muted-foreground")}>{toHoldingViewModel(row.original, total).portfolioWeightPct.toFixed(1)}%</span> },
    { id: "gain_loss", header: () => <span className={numeric}>Gain / loss</span>, cell: ({ row }) => {
      const gain = toHoldingViewModel(row.original, total).gainLossValue;
      return <span className={cn(numeric, gain === null || row.original.pending_delete ? "text-muted-foreground" : gain >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
        {gain === null ? "—" : `${gain > 0 ? "+" : gain < 0 ? "−" : ""}${money(Math.abs(gain))}`}
      </span>;
    } },
  ];
}

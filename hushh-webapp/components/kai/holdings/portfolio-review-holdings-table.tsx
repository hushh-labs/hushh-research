"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/app-ui/data-table";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { MoreHorizontal } from "@/components/icons";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import type { Holding } from "@/components/kai/types/portfolio";
import type { HoldingPosition } from "@/lib/kai/holding-positions";
import { isCashEquivalentHolding } from "@/lib/kai/holding-validation";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { cn } from "@/lib/utils";
import { HoldingGainLoss } from "./holding-gain-loss";
import { toHoldingViewModel, type HoldingsListItem } from "./holding-view-model";

type ReviewPosition = HoldingPosition<HoldingsListItem>;

function positionSide(holding: Holding): "long" | "short" | "liability" {
  if (holding.position_side === "long" || holding.position_side === "short" || holding.position_side === "liability") {
    return holding.position_side;
  }
  if (holding.is_liability_position) return "liability";
  if (holding.is_short_position) return "short";
  if (isCashEquivalentHolding(holding) && holding.market_value < 0) return "liability";
  return holding.quantity < 0 || holding.market_value < 0 ? "short" : "long";
}

export function PortfolioReviewHoldingsTable({
  positions,
  totalValue,
  onManageEntries,
}: {
  positions: ReviewPosition[];
  totalValue: number;
  onManageEntries: (positionId: string) => void;
}) {
  useMarketCurrency();

  const columns: ColumnDef<ReviewPosition>[] = [
    {
      accessorKey: "symbol",
      header: "Holdings",
      cell: ({ row: { original: position } }) => {
        const side = positionSide(position);
        return (
          <div className="min-w-0">
            <p title={position.symbol} className={cn("font-semibold truncate", position.pending_delete && "line-through")}>{position.symbol}</p>
            <p title={position.name} className="truncate text-muted-foreground">
              {position.name || "Unnamed security"}{side === "long" ? "" : " · " + side}
            </p>
            {position.entries.length > 1 ? (
              <p className="text-muted-foreground">{position.entries.length} entries</p>
            ) : null}
            {position.pending_delete ? <p className="text-rose-600 dark:text-rose-400">Pending removal</p> : null}
          </div>
        );
      },
    },
    {
      id: "position",
      header: "Share Price",
      cell: ({ row: { original: position } }) => {
        const quantity = Math.abs(position.quantity);
        return (
          <>
            <p>{position.price_unavailable ? "—" : formatCurrency(position.price, position.currency || position.iso_currency_code)}</p>
            <p className="text-muted-foreground">
              {quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} {quantity === 1 ? "share" : "shares"}
            </p>
          </>
        );
      },
    },
    {
      accessorKey: "market_value",
      header: "Market Value",
      cell: ({ row: { original: position } }) => (
        <span className="font-semibold">{formatCurrency(position.market_value, position.currency || position.iso_currency_code)}</span>
      ),
    },
    {
      accessorKey: "unrealized_gain_loss",
      header: "Gain / Loss",
      cell: ({ row: { original: position } }) => (
        <div className="flex items-center justify-end gap-1 sm:gap-2">
          <HoldingGainLoss holding={toHoldingViewModel(position, totalValue)} className="min-w-0 font-semibold" />
          <ShellActionSurface
            variant="icon"
            className="size-11 border-transparent bg-transparent shadow-none hover:bg-transparent"
            contentClassName="size-8 rounded-full bg-[color:var(--app-glass-surface)] text-foreground group-hover/shell-action:bg-[color:var(--app-shell-surface-bg-hover)]"
            aria-label={"Manage entries for " + (position.symbol || "holding")}
            aria-haspopup="dialog"
            onClick={() => onManageEntries(position.client_id)}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </ShellActionSurface>
        </div>
      ),
    },
  ];

  return (
    <section aria-label="Holdings results">
      <DataTable
        columns={columns}
        tableClassName={financeStyles.reviewTable}
        data={positions}
        globalSearchKeys={["symbol", "name"]}
        searchPlaceholder="Search holdings"
        paginate={false}
        density="compact"
      />
    </section>
  );
}

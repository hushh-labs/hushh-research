"use client";

import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import type { HoldingMobileCardViewModel } from "@/components/kai/holdings/holding-mobile-card";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { StockHistoryPanel, type StockHistoryLoader } from "@/components/kai/charts/stock-history-panel";
import { HoldingEntryList } from "./holding-entry-list";

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatObservationDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not supplied by source";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: value.length === 10 ? "UTC" : undefined }).format(new Date(value));
}

interface HoldingDetailsDrawerProps {
  open: boolean;
  holding: HoldingMobileCardViewModel | null;
  canManageHoldings?: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: () => void;
  onToggleDelete?: () => void;
  loadHistory?: StockHistoryLoader;
  entries?: HoldingMobileCardViewModel[];
  onEditEntry?: (id: string) => void;
  onToggleDeleteEntry?: (id: string) => void;
  onAddEntry?: () => void;
}

function DetailRow({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className={financeStyles.fact}>
      <dt>{label}</dt>
      <dd className={valueClassName}>{value}</dd>
    </div>
  );
}

export function HoldingDetailsDrawer({
  open,
  holding,
  canManageHoldings = true,
  onOpenChange,
  onEdit,
  onToggleDelete,
  loadHistory,
  entries,
  onEditEntry,
  onToggleDeleteEntry,
  onAddEntry,
}: HoldingDetailsDrawerProps) {
  const gainLossPct = holding?.gainLossPct ?? null;
  const gainLossTone =
    gainLossPct === null
      ? "text-foreground"
      : gainLossPct > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : gainLossPct < 0
      ? "text-rose-600 dark:text-rose-400"
      : "text-foreground";

  const gainLossValue = holding
    ? `${formatCurrency(holding.gainLossValue)} (${formatSignedPercent(holding.gainLossPct)})`
    : "—";

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={cn(financeStyles.detail, "border-border/70 bg-background")}>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <DrawerHeader className="flex-row items-center gap-3 px-5 pb-2 text-left">
            {holding ? <SymbolAvatar symbol={holding.symbol} name={holding.name} isCash={holding.isCash} size="lg" /> : null}
            <div className="min-w-0">
            <DrawerTitle className="ui-text-navigation-title text-left text-foreground">
              {holding?.symbol || "Holding Details"}
            </DrawerTitle>
            <DrawerDescription className="app-body-text app-title-subtitle-gap text-left text-muted-foreground">
              {holding?.name || "Select a holding"}
            </DrawerDescription>
            </div>
          </DrawerHeader>

          <div className="px-5 py-4">
            <p className={financeStyles.description}>Market value</p>
            <p className={financeStyles.value}>{formatCurrency(holding?.marketValue ?? null)}</p>
            <p className={cn("mt-2 text-sm tabular-nums", gainLossTone)}>{gainLossValue} · Unrealized gain / loss</p>
          </div>

          {holding && !holding.isCash && holding.identifierType !== "cusip" && /^[A-Z][A-Z0-9.-]{0,15}$/.test(holding.symbol) ? <div className="px-5 pb-4">
            <StockHistoryPanel symbol={holding.symbol} loadHistory={loadHistory} active={open} />
          </div> : null}
          <dl className={cn(financeStyles.facts, "px-5 pb-3")}>
            <DetailRow label="Shares" value={holding ? formatShares(holding.shares) : "—"} />
            <DetailRow label="Average Price" value={formatCurrency(holding?.averagePrice ?? null)} />
            <DetailRow label={holding?.valuationKind === "statement" ? "Statement price" : "Reported price"} value={formatCurrency(holding?.currentPrice ?? null)} />
            <DetailRow label="Cost basis" value={formatCurrency(holding?.costBasis ?? null)} />
            <DetailRow
              label="Portfolio Weight"
              value={holding ? `${holding.portfolioWeightPct.toFixed(2)}%` : "—"}
            />
            <DetailRow label="Sector" value={holding?.sector || "Unclassified"} />
            <DetailRow label="Valuation source" value={holding?.source || "Not supplied by source"} />
            <DetailRow label={holding?.valuationKind === "statement" ? "Statement as of" : "Price as of"} value={formatObservationDate(holding?.quoteAsOf || holding?.statementAsOf)} />
          </dl>
          {entries ? <HoldingEntryList entries={entries} editable={canManageHoldings}
            onEdit={onEditEntry} onToggleDelete={onToggleDeleteEntry} onAdd={onAddEntry} /> : null}
        </div>

        {canManageHoldings && onEdit && onToggleDelete ? (
          <DrawerFooter className="border-t border-border/60 bg-background/80 pb-[calc(1rem+var(--app-safe-area-bottom-effective))]">
            <div className="grid grid-cols-2 gap-2">
              <MorphyButton
                variant="none"
                effect="fade"
                size="sm"
                fullWidth
                className="app-button-text app-button-black"
                disabled={!holding || holding.pendingDelete}
                onClick={onEdit}
              >
                Edit Holding
              </MorphyButton>
              <MorphyButton
                variant="none"
                effect="fade"
                size="sm"
                fullWidth
                className="app-button-text app-button-black"
                disabled={!holding}
                onClick={onToggleDelete}
              >
                {holding?.pendingDelete ? "Restore" : "Delete"}
              </MorphyButton>
            </div>
          </DrawerFooter>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

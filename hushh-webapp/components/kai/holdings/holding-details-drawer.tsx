"use client";

import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import type { HoldingMobileCardViewModel } from "@/components/kai/holdings/holding-mobile-card";

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

interface HoldingDetailsDrawerProps {
  open: boolean;
  holding: HoldingMobileCardViewModel | null;
  canManageHoldings?: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onToggleDelete: () => void;
}

function DetailRow({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 px-3 py-2.5">
      <p className="app-label-text uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("app-body-text mt-1 font-semibold text-foreground", valueClassName)}>{value}</p>
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
      <DrawerContent className="border-border/70 bg-background/95 backdrop-blur-lg">
        <DrawerHeader className="px-5 pb-2 text-left">
          <DrawerTitle className="app-card-title text-left text-foreground">
            {holding?.symbol || "Holding Details"}
          </DrawerTitle>
          <DrawerDescription className="app-body-text app-title-subtitle-gap text-left text-muted-foreground">
            {holding?.name || "Select a holding"}
          </DrawerDescription>
        </DrawerHeader>

        <div className="grid max-h-[60svh] gap-2 overflow-y-auto px-5 pb-3 sm:grid-cols-2">
          <DetailRow label="Ticker" value={holding?.symbol || "—"} />
          <DetailRow label="Company Name" value={holding?.name || "—"} />
          <DetailRow label="Shares" value={holding ? formatShares(holding.shares) : "—"} />
          <DetailRow label="Average Price" value={formatCurrency(holding?.averagePrice ?? null)} />
          <DetailRow label="Current Price" value={formatCurrency(holding?.currentPrice ?? null)} />
          <DetailRow label="Market Value" value={formatCurrency(holding?.marketValue ?? null)} />
          <DetailRow label="Gain / Loss" value={gainLossValue} valueClassName={gainLossTone} />
          <DetailRow
            label="Portfolio Weight"
            value={holding ? `${holding.portfolioWeightPct.toFixed(2)}%` : "—"}
          />
          <DetailRow label="Sector" value={holding?.sector || "Unclassified"} />
        </div>

        <DrawerFooter className="border-t border-border/60 bg-background/80 pb-[calc(1rem+var(--app-safe-area-bottom-effective))]">
          <div className="grid grid-cols-2 gap-2">
            <MorphyButton
              variant="none"
              effect="fade"
              size="sm"
              fullWidth
              className="app-button-text app-button-black"
              disabled={!canManageHoldings || !holding || holding.pendingDelete}
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
              disabled={!canManageHoldings || !holding}
              onClick={onToggleDelete}
            >
              {holding?.pendingDelete ? "Restore" : "Delete"}
            </MorphyButton>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

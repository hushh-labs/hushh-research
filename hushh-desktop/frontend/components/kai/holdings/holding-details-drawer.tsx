"use client";

import { useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";
import type { HoldingMobileCardViewModel } from "@/components/kai/holdings/holding-mobile-card";

// =============================================================================
// HELPERS
// =============================================================================

const formatters = {
  currency: (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  },
  signedPercent: (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  },
  shares: (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return "—";
    return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
};

// =============================================================================
// COMPONENTS
// =============================================================================

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
}: {
  open: boolean;
  holding: HoldingMobileCardViewModel | null;
  canManageHoldings?: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onToggleDelete: () => void;
}) {
  const { gainLossTone, gainLossValue } = useMemo(() => {
    const pct = holding?.gainLossPct;
    const tone = pct == null ? "text-foreground" : pct > 0 ? "text-emerald-600 dark:text-emerald-400" : pct < 0 ? "text-rose-600 dark:text-rose-400" : "text-foreground";
    const val = holding
      ? `${formatters.currency(holding.gainLossValue)} (${formatters.signedPercent(pct)})`
      : "—";
    return { gainLossTone: tone, gainLossValue: val };
  }, [holding]);

  const isPending = !!holding?.pendingDelete;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-border/70 bg-background/95 backdrop-blur-lg">
        <DrawerHeader className="sticky top-0 z-10 bg-background/80 px-5 pb-2 text-left backdrop-blur-md">
          {isPending && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-600">
              <Icon icon={AlertCircle} size="sm" />
              This holding is marked for deletion.
            </div>
          )}
          <DrawerTitle className="app-card-title text-foreground">{holding?.symbol ?? "Holding Details"}</DrawerTitle>
          <DrawerDescription className="app-body-text app-title-subtitle-gap text-left text-muted-foreground">
            {holding?.name ?? "Select a holding"}
          </DrawerDescription>
        </DrawerHeader>

        <div className={cn("grid max-h-[60svh] gap-2 overflow-y-auto px-5 pb-3 sm:grid-cols-2", isPending && "pointer-events-none opacity-60 grayscale")}>
          <DetailRow label="Ticker" value={holding?.symbol ?? "—"} />
          <DetailRow label="Company Name" value={holding?.name ?? "—"} />
          <DetailRow label="Shares" value={formatters.shares(holding?.shares)} />
          <DetailRow label="Average Price" value={formatters.currency(holding?.averagePrice)} />
          <DetailRow label="Current Price" value={formatters.currency(holding?.currentPrice)} />
          <DetailRow label="Market Value" value={formatters.currency(holding?.marketValue)} />
          <DetailRow label="Gain / Loss" value={gainLossValue} valueClassName={gainLossTone} />
          <DetailRow label="Portfolio Weight" value={holding ? `${holding.portfolioWeightPct.toFixed(2)}%` : "—"} />
          <DetailRow label="Sector" value={holding?.sector ?? "Unclassified"} />
        </div>

        <DrawerFooter className="border-t border-border/60 bg-background/80 pb-[calc(1rem+var(--app-safe-area-bottom-effective))]">
          {!canManageHoldings && (
            <p className="mb-2 text-center text-[10px] text-muted-foreground">Management disabled for read-only portfolios.</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <MorphyButton
              variant="none" effect="fade" size="sm" fullWidth
              className={cn("app-button-text", isPending ? "bg-muted text-muted-foreground" : "app-button-black")}
              disabled={!canManageHoldings || !holding || isPending}
              onClick={onEdit}
            >
              Edit Holding
            </MorphyButton>
            <MorphyButton
              variant="none" effect="fade" size="sm" fullWidth
              className={cn("app-button-text", isPending ? "bg-emerald-600 text-white" : "app-button-black")}
              disabled={!canManageHoldings || !holding}
              onClick={onToggleDelete}
            >
              {isPending ? "Restore Holding" : "Delete Holding"}
            </MorphyButton>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
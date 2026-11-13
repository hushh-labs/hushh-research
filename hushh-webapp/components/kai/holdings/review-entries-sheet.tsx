"use client";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { HoldingEntryList } from "./holding-entry-list";
import type { HoldingMobileCardViewModel } from "./holding-mobile-card";

import { useMarketCurrency } from "@/lib/kai/use-market-currency";
/**
 * The entries of one position while a statement import is being reviewed: each
 * entry's shares, value, cost basis and acquisition date, with Edit, Remove and
 * Add entry. Edits and removals are staged by the review screen and nothing is
 * saved from here.
 */
export function ReviewEntriesSheet({
  open,
  position,
  entries,
  onOpenChange,
  onEditEntry,
  onToggleDeleteEntry,
  onAddEntry,
}: {
  open: boolean;
  position: HoldingMobileCardViewModel | null;
  entries: HoldingMobileCardViewModel[];
  onOpenChange: (open: boolean) => void;
  onEditEntry: (id: string) => void;
  onToggleDeleteEntry: (id: string) => void;
  onAddEntry: () => void;
}) {
  useMarketCurrency();
  const shares = position?.shares.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? "0";
  const summary = `${shares} ${position?.shares === 1 ? "share" : "shares"} across ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  return (
    <AdaptiveDetailSurface open={open} onOpenChange={onOpenChange}
      title="Manage entries" description={position ? `${position.name} · ${position.symbol}` : "Holding"}
      leading={position ? <SymbolAvatar symbol={position.symbol} name={position.name} isCash={position.isCash} size="lg" /> : undefined}
      surfaceClassName={financeStyles.detail} mobilePresentation="sheet" showMobileCloseButton
      desktopMaxWidthClassName="sm:!max-w-[32.5rem]"
      footer={<ShellActionSurface variant="pill" className="min-h-11" onClick={() => onOpenChange(false)}>Done</ShellActionSurface>}>
      <div className="px-5 pb-2">
        <p className={financeStyles.value}>{position ? formatCurrency(position.marketValue, position.currency) : "—"}</p>
        <p className="ui-text-row-description mt-1 text-muted-foreground">{summary}</p>
      </div>
      <HoldingEntryList entries={entries} editable onEdit={onEditEntry} onToggleDelete={onToggleDeleteEntry} onAdd={onAddEntry} />
    </AdaptiveDetailSurface>
  );
}

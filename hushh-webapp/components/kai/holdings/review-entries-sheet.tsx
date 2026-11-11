"use client";

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { XIcon } from "@/components/icons";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import { formatCurrency } from "@/lib/kai/market-value-format";
import { cn } from "@/lib/utils";
import { HoldingEntryList } from "./holding-entry-list";
import type { HoldingMobileCardViewModel } from "./holding-mobile-card";

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
  const shares = position?.shares.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? "0";
  const summary = `${shares} ${position?.shares === 1 ? "share" : "shares"} across ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={cn(financeStyles.detail, "border-border/70 bg-background")}>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <DrawerHeader className="flex-row items-center gap-3 px-5 pb-2 text-left">
            {position ? <SymbolAvatar symbol={position.symbol} name={position.name} isCash={position.isCash} size="lg" /> : null}
            <div className="min-w-0 flex-1">
              <DrawerTitle className="ui-text-navigation-title text-left text-foreground">
                {position?.symbol || "Holding"}
              </DrawerTitle>
              <DrawerDescription className="app-body-text app-title-subtitle-gap text-left text-muted-foreground">
                {position?.name || "Unnamed security"}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <ShellActionSurface variant="icon" className="h-11 w-11" aria-label="Close">
                <XIcon className="size-4" aria-hidden="true" />
              </ShellActionSurface>
            </DrawerClose>
          </DrawerHeader>
          <div className="px-5 pb-2">
            <p className={financeStyles.value}>{position ? formatCurrency(position.marketValue, position.currency) : "—"}</p>
            <p className="ui-text-row-description mt-1 text-muted-foreground">{summary}</p>
          </div>
          <HoldingEntryList
            entries={entries}
            editable
            onEdit={onEditEntry}
            onToggleDelete={onToggleDeleteEntry}
            onAdd={onAddEntry}
          />
        </div>
        <DrawerFooter className="border-t border-border/60 bg-background/80 pb-[calc(1rem+var(--app-safe-area-bottom-effective))]">
          <DrawerClose asChild>
            <ShellActionSurface variant="pill" className="min-h-11 w-full justify-center">Done</ShellActionSurface>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

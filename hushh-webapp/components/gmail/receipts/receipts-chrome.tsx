"use client";

import type { ComponentType, ReactNode } from "react";

import { Clock, CreditCard, FileText, Home, Landmark, Phone, Receipt, Wifi, Zap } from "@/components/icons";
import { cn } from "@/lib/utils";
import mailStyles from "../mail-workspace.module.css";
import styles from "./receipts.module.css";

export type ReceiptsView = "all" | "recurring";

const ICONS: Record<string, { Icon: ComponentType<{ className?: string; weight?: "regular" | "duotone" }>; tone: string }> = {
  electricity: { Icon: Zap, tone: "bg-amber-500/12 text-amber-700 dark:text-amber-300" },
  rent: { Icon: Home, tone: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300" },
  wifi: { Icon: Wifi, tone: "bg-blue-500/12 text-blue-700 dark:text-blue-300" },
  tv: { Icon: CreditCard, tone: "bg-purple-500/12 text-purple-700 dark:text-purple-300" },
  deposit: { Icon: Landmark, tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  recharge: { Icon: Phone, tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  bill: { Icon: FileText, tone: "bg-slate-500/12 text-slate-700 dark:text-slate-300" },
};

export const BILL_ICON_CHOICES: Array<{ value: string; label: string }> = [
  { value: "electricity", label: "Electricity" },
  { value: "rent", label: "Rent" },
  { value: "wifi", label: "Wi-Fi or internet" },
  { value: "tv", label: "TV or streaming" },
  { value: "recharge", label: "Mobile recharge" },
  { value: "deposit", label: "Savings deposit" },
  { value: "bill", label: "Other bill" },
];

export function BillIcon({ icon, className }: { icon: string; className?: string }) {
  const { Icon, tone } = ICONS[icon] ?? { Icon: Receipt, tone: ICONS.bill!.tone };
  return (
    <span aria-hidden="true" className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]", tone, className)} data-slot="bill-icon">
      <Icon className="size-[18px]" weight="regular" />
    </span>
  );
}

export function ReceiptsHeader({
  view, onViewChange, trailingLabel, onTrailing, headingId, children,
}: {
  view: ReceiptsView;
  onViewChange: (view: ReceiptsView) => void;
  /** "Activity" on All receipts, "History" on Recurring. */
  trailingLabel: string;
  onTrailing: () => void;
  headingId: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-4" data-testid="receipts-header">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className={cn(styles.pageTitle, "text-foreground")}>Receipts</h2>
        <button
          type="button"
          onClick={onTrailing}
          className={cn(mailStyles.utilityAction, "inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-[14px] font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]")}
        >
          <Clock aria-hidden="true" className="size-[18px]" />
          {trailingLabel}
        </button>
      </div>
      <div role="tablist" aria-label="Receipts view" className="flex gap-6 border-b border-transparent">
        {([["all", "All receipts"], ["recurring", "Recurring"]] as const).map(([value, label]) => {
          const selected = view === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              id={`receipts-view-${value}`}
              aria-selected={selected}
              aria-controls={`receipts-panel-${value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onViewChange(value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  onViewChange(value === "all" ? "recurring" : "all");
                  window.requestAnimationFrame(() => document.getElementById(`receipts-view-${value === "all" ? "recurring" : "all"}`)?.focus());
                }
              }}
              className={cn(
                "relative min-h-11 border-b-2 px-0 pb-1 pt-2 text-[15px] leading-[22px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
                selected ? "border-[color:var(--app-accent)] text-[color:var(--app-accent)]" : "border-transparent text-muted-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

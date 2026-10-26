"use client";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import type { HoldingMobileCardViewModel } from "./holding-mobile-card";

const money = (value: number | null | undefined) => value == null ? "Unavailable" :
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export function HoldingEntryList({ entries, editable, onEdit, onToggleDelete, onAdd }: {
  entries: HoldingMobileCardViewModel[];
  editable: boolean;
  onEdit?: (id: string) => void;
  onToggleDelete?: (id: string) => void;
  onAdd?: () => void;
}) {
  return <section aria-label="Your entries" className="px-5 pb-5">
    <div className="flex min-h-11 items-center justify-between gap-3">
      <h3 className="text-sm font-medium">Your entries <span className="text-muted-foreground">({entries.length})</span></h3>
      {editable && onAdd ? <ShellActionSurface variant="pill" className="h-11 text-sm sm:text-sm" onClick={onAdd}>Add entry</ShellActionSurface> : null}
    </div>
    <ul className="divide-y divide-border">
      {entries.map((entry, index) => <li key={entry.id} className="py-3" data-pending-delete={entry.pendingDelete || undefined}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">Entry {index + 1}{entry.pendingDelete ? " · Pending removal" : ""}</p>
            <p className="text-muted-foreground">{entry.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares · {money(entry.marketValue)} value</p>
            <p className="text-muted-foreground">Cost basis {money(entry.costBasis)}</p>
            <p className="text-muted-foreground">{entry.acquisitionDate && /^\d{4}-\d{2}-\d{2}$/.test(entry.acquisitionDate)
              ? `Acquired ${entry.acquisitionDate}` : "Acquisition date not supplied"}</p>
          </div>
          {editable ? <div className="flex flex-wrap gap-2">
            {onEdit ? <ShellActionSurface variant="pill" className="h-11 text-sm sm:text-sm" disabled={entry.pendingDelete}
              aria-label={`Edit entry ${index + 1}`} onClick={() => onEdit(entry.id)}>Edit</ShellActionSurface> : null}
            {onToggleDelete ? <ShellActionSurface variant="pill" className="h-11 text-sm sm:text-sm"
              aria-label={`${entry.pendingDelete ? "Restore" : "Remove"} entry ${index + 1}`}
              onClick={() => onToggleDelete(entry.id)}>{entry.pendingDelete ? "Restore" : "Remove"}</ShellActionSurface> : null}
          </div> : null}
        </div>
      </li>)}
    </ul>
  </section>;
}

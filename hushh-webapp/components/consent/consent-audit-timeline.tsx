"use client";

import { useMemo, useState } from "react";
import { Clock3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { cn } from "@/lib/utils";

type ConsentAuditEventType = "all" | "granted" | "updated" | "revoked" | "expired";

const FILTERS: Array<{ value: ConsentAuditEventType; label: string }> = [
  { value: "all", label: "All" },
  { value: "granted", label: "Granted" },
  { value: "updated", label: "Updated" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

const TYPE_STYLES: Record<Exclude<ConsentAuditEventType, "all">, string> = {
  granted: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  updated: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  revoked: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  expired: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

interface ConsentAuditTimelineProps {
  entries: ConsentCenterEntry[];
  selectedId?: string | null;
  onSelect: (entry: ConsentCenterEntry) => void;
  resolveCounterpartLabel: (entry: ConsentCenterEntry) => string;
  summarizeEntry: (entry: ConsentCenterEntry) => string;
}

function resolveEventType(entry: ConsentCenterEntry): Exclude<ConsentAuditEventType, "all"> {
  const status = String(entry.status || "").toLowerCase();
  const action = String(entry.action || "").toLowerCase();

  if (status.includes("revok") || action.includes("revok") || status === "denied") {
    return "revoked";
  }
  if (status.includes("expir") || action.includes("expir")) {
    return "expired";
  }
  if (action.includes("update") || action.includes("scope") || Boolean(entry.is_scope_upgrade)) {
    return "updated";
  }
  return "granted";
}

function formatEventDate(entry: ConsentCenterEntry) {
  const value = entry.issued_at || entry.expires_at;
  if (!value) return "Timestamp unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Timestamp unavailable";
  return date.toLocaleString();
}

function entryKey(entry: ConsentCenterEntry) {
  return entry.request_id || entry.id;
}

export function ConsentAuditTimeline({
  entries,
  selectedId,
  onSelect,
  resolveCounterpartLabel,
  summarizeEntry,
}: ConsentAuditTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<ConsentAuditEventType>("all");
  const filteredEntries = useMemo(
    () =>
      activeFilter === "all"
        ? entries
        : entries.filter((entry) => resolveEventType(entry) === activeFilter),
    [activeFilter, entries]
  );

  return (
    <div className="space-y-4 px-2 py-2">
      <div className="flex flex-col gap-3 px-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Consent audit timeline</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Real consent history from the active access ledger.
          </p>
        </div>
        <Badge className="w-fit border-border/70 bg-background/80 text-muted-foreground">
          {entries.length} logged
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2 px-2" aria-label="Filter consent audit timeline">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => setActiveFilter(filter.value)}
            className={cn(
              "rounded-[var(--app-card-radius-compact)] border px-3 py-1.5 text-xs font-medium transition-colors",
              activeFilter === filter.value
                ? "border-sky-500/24 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                : "border-border/70 bg-background/80 text-muted-foreground hover:bg-muted/60"
            )}
            aria-pressed={activeFilter === filter.value}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {filteredEntries.length === 0 ? (
        <div className="mx-2 rounded-[var(--app-card-radius-compact)] border border-dashed border-border/70 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No matching consent history</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Change the filter or wait for the next consent decision to be recorded.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEntries.map((entry) => {
            const type = resolveEventType(entry);
            const selected = selectedId === entry.id || selectedId === entry.request_id;
            return (
              <button
                key={entryKey(entry)}
                type="button"
                onClick={() => onSelect(entry)}
                className={cn(
                  "group relative w-full rounded-[var(--app-card-radius-compact)] border px-4 py-3 text-left transition-colors",
                  selected
                    ? "border-sky-500/24 bg-sky-500/7"
                    : "border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 hover:bg-[color:var(--app-card-surface-compact)]"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground">
                    <Clock3 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {resolveCounterpartLabel(entry)}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatEventDate(entry)}</p>
                      </div>
                      <Badge className={cn("capitalize", TYPE_STYLES[type])}>{type}</Badge>
                    </div>
                    <p className="line-clamp-2 text-sm leading-6 text-foreground/80">
                      {summarizeEntry(entry)}
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {entry.scope ? (
                        <span className="rounded-full bg-muted/70 px-2.5 py-1">
                          {entry.scope_description || entry.scope}
                        </span>
                      ) : null}
                      {entry.counterpart_email ? (
                        <span className="rounded-full bg-muted/70 px-2.5 py-1">
                          {entry.counterpart_email}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

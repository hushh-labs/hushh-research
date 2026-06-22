"use client";

import { useMemo, useState } from "react";
import { Clock3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { cn } from "@/lib/utils";

type ConsentAuditEventType =
  | "all"
  | "granted"
  | "updated"
  | "revoked"
  | "expired";

const FILTERS: Array<{ value: ConsentAuditEventType; label: string }> = [
  { value: "all", label: "All" },
  { value: "granted", label: "Granted" },
  { value: "updated", label: "Updated" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

const TYPE_STYLES: Record<Exclude<ConsentAuditEventType, "all">, string> = {
  granted:
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  updated: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  revoked: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  expired:
    "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

interface ConsentAuditTimelineProps {
  entries: ConsentCenterEntry[];
  selectedId?: string | null;
  onSelect: (entry: ConsentCenterEntry) => void;
  resolveCounterpartLabel: (entry: ConsentCenterEntry) => string;
  summarizeEntry: (entry: ConsentCenterEntry) => string;
}

type ConsentTrail = NonNullable<ConsentCenterEntry["consent_trails"]>[number];
type ConsentTrailEvent = NonNullable<ConsentTrail["events"]>[number];
type TimedConsentItem = {
  issued_at?: number | string | null;
  expires_at?: number | string | null;
};

function resolveEventType(
  entry: ConsentCenterEntry | ConsentTrail | ConsentTrailEvent,
): Exclude<ConsentAuditEventType, "all"> {
  const status = String(entry.status || "").toLowerCase();
  const action = String(entry.action || "").toLowerCase();

  if (
    status.includes("revok") ||
    action.includes("revok") ||
    status === "denied"
  ) {
    return "revoked";
  }
  if (status.includes("expir") || action.includes("expir")) {
    return "expired";
  }
  if (
    action.includes("update") ||
    action.includes("scope") ||
    ("is_scope_upgrade" in entry && Boolean(entry.is_scope_upgrade))
  ) {
    return "updated";
  }
  return "granted";
}

function historyEvents(entry: ConsentCenterEntry) {
  const trailEvents =
    entry.consent_trails?.flatMap((trail) =>
      trail.events && trail.events.length > 0 ? trail.events : [trail],
    ) || [];
  return trailEvents.length > 0 ? trailEvents : [entry];
}

function entryMatchesFilter(
  entry: ConsentCenterEntry,
  filter: ConsentAuditEventType,
) {
  if (filter === "all") return true;
  return historyEvents(entry).some((event) => resolveEventType(event) === filter);
}

function formatEventDate(entry: TimedConsentItem) {
  const value = entry.issued_at || entry.expires_at;
  if (!value) return "Timestamp unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Timestamp unavailable";
  return date.toLocaleString();
}

function getEventIsoDate(entry: TimedConsentItem): string | null {
  const value = entry.issued_at || entry.expires_at;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function eventTimeMs(entry: TimedConsentItem) {
  const value = entry.issued_at || entry.expires_at;
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function sortedTrailEvents(trail: ConsentTrail): ConsentTrailEvent[] {
  return [...(trail.events || [])].sort((a, b) => eventTimeMs(b) - eventTimeMs(a));
}

function sortedConsentTrails(entry: ConsentCenterEntry): ConsentTrail[] {
  return [...(entry.consent_trails || [])].sort((a, b) => {
    const aLatest = Math.max(
      eventTimeMs(a),
      ...sortedTrailEvents(a).map((event) => eventTimeMs(event)),
    );
    const bLatest = Math.max(
      eventTimeMs(b),
      ...sortedTrailEvents(b).map((event) => eventTimeMs(event)),
    );
    return bLatest - aLatest;
  });
}

function trailLabel(trail: ConsentTrail) {
  return trail.scope_description || trail.scope || "General consent";
}

function eventLabel(event: ConsentTrailEvent) {
  const action = String(event.action || event.status || "event")
    .replace(/_/g, " ")
    .toLowerCase();
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function entryKey(entry: ConsentCenterEntry, index: number) {
  return [
    entry.kind,
    entry.id,
    entry.request_id,
    entry.action,
    entry.status,
    entry.issued_at,
    entry.expires_at,
    index,
  ]
    .filter((part) => {
      if (part === undefined || part === null) return false;
      return String(part).trim().length > 0;
    })
    .map(String)
    .join(":");
}

export function ConsentAuditTimeline({
  entries,
  selectedId,
  onSelect,
  resolveCounterpartLabel,
  summarizeEntry,
}: ConsentAuditTimelineProps) {
  const [activeFilter, setActiveFilter] =
    useState<ConsentAuditEventType>("all");
  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) => entryMatchesFilter(entry, activeFilter)),
    [activeFilter, entries],
  );

  return (
    <div className="space-y-4 px-2 py-2">
      <div className="flex flex-col gap-3 px-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Consent audit timeline
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Real consent history from the active access ledger.
          </p>
        </div>
        <Badge className="w-fit border-border/70 bg-background/80 text-muted-foreground">
          {entries.length} logged
        </Badge>
      </div>

      <div
        className="flex flex-wrap gap-2 px-2"
        aria-label="Filter consent audit timeline"
      >
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => setActiveFilter(filter.value)}
            className={cn(
              "rounded-[var(--app-card-radius-compact)] border px-3 py-1.5 text-xs font-medium transition-colors",
              activeFilter === filter.value
                ? "border-sky-500/24 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                : "border-border/70 bg-background/80 text-muted-foreground hover:bg-muted/60",
            )}
            aria-pressed={activeFilter === filter.value}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {filteredEntries.length === 0 ? (
        <div className="mx-2 rounded-[var(--app-card-radius-compact)] border border-dashed border-border/70 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">
            No matching consent history
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Change the filter or wait for the next consent decision to be
            recorded.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEntries.map((entry, index) => {
            const type = resolveEventType(entry);
            const selected =
              selectedId === entry.id ||
              selectedId === entry.request_id ||
              selectedId === entry.latest_request_id ||
              Boolean(
                selectedId &&
                  entry.consent_trails?.some(
                    (trail) =>
                      trail.latest_request_id === selectedId ||
                      trail.request_ids?.includes(selectedId) ||
                      trail.events?.some(
                        (event) =>
                          event.id === selectedId || event.request_id === selectedId,
                      ),
                  ),
              );
            const isoDate = getEventIsoDate(entry);
            const trailCount = entry.trail_count || entry.consent_trails?.length || 0;
            const eventCount =
              entry.event_count ||
              entry.consent_trails?.reduce(
                (total, trail) =>
                  total + (trail.event_count || trail.events?.length || 0),
                0,
              ) ||
              0;
            const trails = sortedConsentTrails(entry);
            return (
              <button
                key={entryKey(entry, index)}
                type="button"
                onClick={() => onSelect(entry)}
                aria-pressed={selected}
                aria-label={`${resolveCounterpartLabel(entry)}, ${type} consent, ${formatEventDate(entry)}`}
                className={cn(
                  "group relative w-full rounded-[var(--app-card-radius-compact)] border px-4 py-3 text-left transition-colors",
                  selected
                    ? "border-sky-500/24 bg-sky-500/7"
                    : "border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 hover:bg-[color:var(--app-card-surface-compact)]",
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
                        <p className="text-xs text-muted-foreground">
                          {isoDate ? (
                            <time dateTime={isoDate}>{formatEventDate(entry)}</time>
                          ) : (
                            formatEventDate(entry)
                          )}
                        </p>
                      </div>
                      <Badge className={cn("capitalize", TYPE_STYLES[type])}>
                        {type}
                      </Badge>
                    </div>
                    <p className="line-clamp-2 text-sm leading-6 text-foreground/80">
                      {summarizeEntry(entry)}
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {trailCount > 0 ? (
                        <span className="rounded-full bg-muted/70 px-2.5 py-1">
                          {trailCount} lifecycle
                          {trailCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {eventCount > 0 ? (
                        <span className="rounded-full bg-muted/70 px-2.5 py-1">
                          {eventCount} event{eventCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
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
                    {trails.length > 0 ? (
                      <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
                        {trails.slice(0, 4).map((trail, trailIndex) => {
                          const events = sortedTrailEvents(trail);
                          const trailType = resolveEventType(trail);
                          const trailIsoDate = getEventIsoDate(trail);
                          const visibleEvents = events.slice(0, 4);
                          const totalEvents =
                            trail.event_count || events.length || 0;
                          return (
                            <div
                              key={
                                trail.id ||
                                trail.trail_key ||
                                trail.latest_request_id ||
                                `${entry.id}:${trailIndex}`
                              }
                              className="rounded-[var(--app-card-radius-compact)] border border-border/60 bg-background/70 p-3"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-foreground">
                                    Lifecycle {trailIndex + 1}
                                  </p>
                                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                    {trailLabel(trail)}
                                  </p>
                                </div>
                                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                                  <Badge
                                    className={cn(
                                      "capitalize",
                                      TYPE_STYLES[trailType],
                                    )}
                                  >
                                    {trailType}
                                  </Badge>
                                  <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                                    {totalEvents} event
                                    {totalEvents === 1 ? "" : "s"}
                                  </span>
                                </div>
                              </div>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {trailIsoDate ? (
                                  <time dateTime={trailIsoDate}>
                                    {formatEventDate(trail)}
                                  </time>
                                ) : (
                                  formatEventDate(trail)
                                )}
                              </p>
                              {visibleEvents.length > 0 ? (
                                <div className="mt-3 space-y-0">
                                  {visibleEvents.map((event, eventIndex) => {
                                    const eventIsoDate = getEventIsoDate(event);
                                    const eventType = resolveEventType(event);
                                    return (
                                      <div
                                        key={`${event.request_id || event.id || trailIndex}-${event.action || event.status}-${event.issued_at || eventIndex}`}
                                        className="grid grid-cols-[18px_1fr] gap-2"
                                      >
                                        <div className="flex flex-col items-center">
                                          <span
                                            className={cn(
                                              "mt-1 h-2.5 w-2.5 rounded-full border",
                                              TYPE_STYLES[eventType],
                                            )}
                                          />
                                          {eventIndex < visibleEvents.length - 1 ? (
                                            <span className="min-h-5 flex-1 border-l border-border/70" />
                                          ) : null}
                                        </div>
                                        <div className="pb-2 text-xs last:pb-0">
                                          <p className="font-medium text-foreground/85">
                                            {eventLabel(event)}
                                          </p>
                                          <p className="mt-0.5 text-muted-foreground">
                                            {event.scope_description ||
                                              event.scope ||
                                              "Consent event"}
                                            {" · "}
                                            {eventIsoDate ? (
                                              <time dateTime={eventIsoDate}>
                                                {formatEventDate(event)}
                                              </time>
                                            ) : (
                                              formatEventDate(event)
                                            )}
                                          </p>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
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

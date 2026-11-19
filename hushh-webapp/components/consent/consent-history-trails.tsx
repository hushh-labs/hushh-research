"use client";

import type { ReactNode } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { formatRequestedAt } from "@/lib/consent/consent-owner-copy";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import { cn } from "@/lib/utils";

export type ConsentTrailRecord = NonNullable<ConsentCenterEntry["consent_trails"]>[number];
export type ConsentTrailEventRecord = NonNullable<ConsentTrailRecord["events"]>[number];

export type ConsentHistoryTrailEvent = {
  key: string;
  label: string;
  detail?: string | null;
  tone?: string | null;
};

export type ConsentHistoryTrailItem = {
  key: string;
  eyebrow?: string | null;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  statusLabel: string;
  statusTone?: string | null;
  actions?: ReactNode;
  events?: readonly ConsentHistoryTrailEvent[];
  eventsTestId?: string;
};

/** The owner's words for each step, never the protocol's ("Consent granted"). */
const LIFECYCLE_EVENT_LABELS: Record<string, string> = {
  CONSENT_GRANTED: "Allowed",
  CONSENT_DENIED: "Declined",
  REVOKED: "Stopped sharing",
  CANCELLED: "Withdrawn",
  TIMEOUT: "Expired",
  REQUESTED: "Requested",
  INVITE_SENT: "Invite sent",
  EXPORT_READ: "Opened",
};

export function formatLifecycleEventLabel(event: {
  action?: string | null;
  status?: string | null;
}) {
  const action = String(event.action || "")
    .trim()
    .toUpperCase();
  const named = LIFECYCLE_EVENT_LABELS[action];
  if (named) return named;
  const value = String(event.action || event.status || "Consent event")
    .replaceAll("_", " ")
    .toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function consentHistoryStatusToAction(status?: string | null): string | null {
  switch (String(status || "").trim().toLowerCase()) {
    case "approved":
    case "active":
    case "granted":
    case "shared":
      return "CONSENT_GRANTED";
    case "denied":
    case "declined":
      return "CONSENT_DENIED";
    case "revoked":
    case "ended":
    case "stopped":
      return "REVOKED";
    case "cancelled":
    case "withdrawn":
      return "CANCELLED";
    case "expired":
    case "timeout":
      return "TIMEOUT";
    case "pending":
    case "request_pending":
    case "waiting":
      return "REQUESTED";
    default:
      return null;
  }
}

export function consentHistoryBadgeClassName(status?: string | null) {
  switch (String(status || "").trim().toLowerCase()) {
    case "approved":
    case "active":
    case "granted":
    case "shared":
    case "allowed":
    case "consent_granted":
      return "border-transparent bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";
    case "pending":
    case "request_pending":
    case "waiting":
    case "requested":
      return "border-transparent bg-amber-500/10 text-amber-800 dark:text-amber-200";
    case "denied":
    case "declined":
    case "revoked":
    case "ended":
    case "stopped":
    case "stopped sharing":
    case "cancelled":
    case "withdrawn":
    case "expired":
    case "timeout":
    default:
      return "border-transparent bg-[color:var(--app-secondary-surface)] text-[color:var(--app-secondary-label)]";
  }
}

export function formatConsentHistoryStatus(status?: string | null) {
  const normalized = String(status || "pending").toLowerCase();
  const labels: Record<string, string> = {
    revoked: "Ended",
    cancelled: "Withdrawn",
    pending: "Waiting",
    request_pending: "Waiting",
    accepted: "Accepted",
  };
  return labels[normalized] || normalized.replaceAll("_", " ");
}

function eventTimeMs(value?: string | number | null) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function trailTimeMs(trail: ConsentTrailRecord) {
  return Math.max(
    eventTimeMs(trail.issued_at || trail.expires_at),
    ...(trail.events || []).map((event) =>
      eventTimeMs(event.issued_at || event.expires_at),
    ),
  );
}

export function sortedConsentTrails(entry: ConsentCenterEntry) {
  return [...(entry.consent_trails || [])].sort(
    (left, right) => trailTimeMs(right) - trailTimeMs(left),
  );
}

export function sortedTrailEvents(trail: ConsentTrailRecord) {
  return [...(trail.events || [])].sort(
    (left, right) =>
      eventTimeMs(right.issued_at || right.expires_at) -
      eventTimeMs(left.issued_at || left.expires_at),
  );
}

export function buildConsentTrailEventItems(
  events: readonly ConsentTrailEventRecord[],
  keyPrefix: string,
): ConsentHistoryTrailEvent[] {
  return events.map((event, eventIndex) => ({
    key: `${event.request_id || event.id || keyPrefix}-${event.action || event.status}-${event.issued_at || eventIndex}`,
    label: formatLifecycleEventLabel(event),
    detail:
      [
        event.scope_description ||
          (event.scope ? humanizeConsentScope(event.scope) : null),
        formatRequestedAt(event.issued_at || event.expires_at),
      ]
        .filter(Boolean)
        .join(" · ") || "Event recorded",
    tone: event.status || event.action || null,
  }));
}

export function ConsentHistoryEventTrail({
  events,
  testId,
  className,
}: {
  events: readonly ConsentHistoryTrailEvent[];
  testId?: string;
  className?: string;
}) {
  if (events.length === 0) return null;
  return (
    <div className={cn("space-y-0", className)} data-testid={testId}>
      {events.map((event, eventIndex) => (
        <div key={event.key} className="grid grid-cols-[18px_1fr] gap-2">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                "mt-1 h-2.5 w-2.5 rounded-full border",
                consentHistoryBadgeClassName(event.tone ?? event.label),
              )}
            />
            {eventIndex < events.length - 1 ? (
              <span className="min-h-6 flex-1 border-l border-border/70" />
            ) : null}
          </div>
          <div className="pb-3 text-xs last:pb-0">
            <div className="font-medium text-foreground/85">{event.label}</div>
            {event.detail ? (
              <div className="mt-0.5 leading-5 text-muted-foreground">
                {event.detail}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Canonical consent and information-request history trail list shared by
 * Consent Center History and Person Profile Request history.
 */
export function ConsentHistoryTrails({
  items,
  embedded = false,
  title,
  description,
  footer,
  className,
}: {
  items: readonly ConsentHistoryTrailItem[];
  embedded?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <SettingsGroup
      embedded={embedded}
      title={title}
      description={description}
      className={className}
    >
      <div className="divide-y divide-[color:var(--app-card-border-standard)]/45 px-[var(--settings-row-px)]">
        {items.map((item) => (
          <div key={item.key} className="py-[var(--settings-row-py)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {item.eyebrow ? (
                  <div
                    data-consent-role="fact-label"
                    className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground"
                  >
                    {item.eyebrow}
                  </div>
                ) : null}
                <div
                  data-consent-role="row-title"
                  className={cn(
                    item.eyebrow ? "mt-1" : undefined,
                    "text-sm font-semibold leading-5 text-foreground",
                  )}
                >
                  {item.title}
                </div>
                {item.subtitle ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.subtitle}
                  </p>
                ) : null}
                {item.meta ? (
                  <div
                    data-consent-role="helper"
                    className="mt-1 text-xs text-muted-foreground"
                  >
                    {item.meta}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Badge
                  data-consent-role="status"
                  className={cn(
                    "capitalize",
                    consentHistoryBadgeClassName(item.statusTone ?? item.statusLabel),
                  )}
                >
                  {item.statusLabel}
                </Badge>
                {item.actions}
              </div>
            </div>

            {item.events && item.events.length > 0 ? (
              <ConsentHistoryEventTrail
                events={item.events}
                testId={item.eventsTestId}
                className="mt-4"
              />
            ) : null}
          </div>
        ))}
      </div>
      {footer ? (
        <div className="border-t border-[color:var(--app-card-border-standard)]/45 px-[var(--settings-row-px)] py-3">
          {footer}
        </div>
      ) : null}
    </SettingsGroup>
  );
}

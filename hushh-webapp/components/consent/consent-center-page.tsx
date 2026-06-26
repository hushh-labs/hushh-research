"use client";

import { AsyncActionStatus } from "@/components/system/async-action-status";
import { SessionExpiryRecovery } from "@/components/system/session-expiry-recovery";
import { StaleCacheTimestamp } from "@/components/system/stale-cache-timestamp";
import Link from "next/link";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  ExternalLink,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { AccessibilityStatusAnnouncer } from "@/components/system/accessibility-status-announcer";
import { ApiRetryState } from "@/components/system/api-retry-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import {
  useConsentActions,
  useOneLocationConsentActions,
  type ConsentActionState,
  type ConsentMutationDetail,
  type PendingConsent,
} from "@/lib/consent";

import { HandshakeTimeline } from "@/components/consent/handshake-timeline";
import {
  humanizeConsentScope,
  resolveConsentRequesterLabel,
  resolveConsentSupportingCopy,
} from "@/lib/consent/consent-display";
import {
  emailHelperConsentSummary,
  emailHelperWorkflowHref,
  isEmailHelperConsent,
} from "@/lib/consent/email-helper-consent";
import {
  isLocationConsent,
  locationConsentSummary,
  locationConsentWorkflowHref,
} from "@/lib/consent/location-consent";
import { normalizeInternalAppHref } from "@/lib/consent/consent-sheet-route";

import {
  CONSENT_CENTER_PAGE_SIZE,
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterEntry,
  type ConsentCenterPageListResponse,
  type ConsentCenterMode,
  type ConsentCenterPageSummary,
  type ConsentCenterResponse,
  type PendingConsentLookupItem,
} from "@/lib/services/consent-center-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaClientWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

type ConsentTab = "requests" | "active" | "history" | "relationships";
type ConsentManagerMode = ConsentCenterMode;
type PendingNotificationAction = "review" | "approve" | "deny" | null;
type ConsentTrail = NonNullable<ConsentCenterEntry["consent_trails"]>[number];
type ConsentTrailEvent = NonNullable<ConsentTrail["events"]>[number];

const DURATION_OPTIONS = [
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "2160", label: "90 days" },
];

function normalizeTab(value: string | null): ConsentTab {
  if (value === "active") return "active";
  if (value === "history" || value === "previous") return "history";
  if (value === "relationships") return "relationships";
  return "requests";
}

function normalizeNotificationAction(
  value: string | null,
): PendingNotificationAction {
  if (value === "review" || value === "approve" || value === "deny") {
    return value;
  }
  return null;
}

function resolveConsentTab(
  searchParams: URLSearchParams | ReadonlyURLSearchParams,
): ConsentTab {
  const tabParam = searchParams.get("tab");
  if (tabParam) {
    return normalizeTab(tabParam);
  }

  const viewParam = searchParams.get("view");
  if (
    viewParam === "pending" ||
    viewParam === "active" ||
    viewParam === "previous" ||
    viewParam === "history" ||
    viewParam === "relationships"
  ) {
    return normalizeTab(viewParam);
  }

  return "requests";
}

function formatStatus(status?: string | null) {
  return String(status || "pending").replaceAll("_", " ");
}

function formatDate(value?: string | number | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function formatRelative(value?: string | number | null) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const deltaMs = timestamp - Date.now();
  if (deltaMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(deltaMs / (60 * 1000));
  if (totalMinutes < 60) return `${totalMinutes} min left`;
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours} hr left`;
  return `${Math.ceil(totalHours / 24)} days left`;
}

function eventTimeMs(value?: string | number | null) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function trailTimeMs(trail: ConsentTrail) {
  return Math.max(
    eventTimeMs(trail.issued_at || trail.expires_at),
    ...(trail.events || []).map((event) =>
      eventTimeMs(event.issued_at || event.expires_at),
    ),
  );
}

function sortedConsentTrails(entry: ConsentCenterEntry) {
  return [...(entry.consent_trails || [])].sort(
    (left, right) => trailTimeMs(right) - trailTimeMs(left),
  );
}

function sortedTrailEvents(trail: ConsentTrail) {
  return [...(trail.events || [])].sort(
    (left, right) =>
      eventTimeMs(right.issued_at || right.expires_at) -
      eventTimeMs(left.issued_at || left.expires_at),
  );
}

function parseDurationHours(value?: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatDurationHours(value?: number | string | null) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function durationOptionsFor(requestedDurationHours?: number | string | null) {
  const maxHours = Number(requestedDurationHours);
  if (!Number.isFinite(maxHours) || maxHours <= 0) return DURATION_OPTIONS;
  const options = DURATION_OPTIONS.filter(
    (option) => Number(option.value) <= maxHours,
  );
  const requestedValue = String(maxHours);
  if (!options.some((option) => option.value === requestedValue)) {
    options.push({
      value: requestedValue,
      label: formatDurationHours(maxHours) || `${maxHours} hours`,
    });
  }
  return options.sort(
    (left, right) => Number(left.value) - Number(right.value),
  );
}

function isAuthConsentLoadError(error?: string | null) {
  const normalized = String(error || "").toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("missing authorization") ||
    normalized.includes("invalid firebase") ||
    normalized.includes("session") ||
    normalized.includes("sign in")
  );
}

function badgeClassName(status?: string | null) {
  switch (String(status || "").toLowerCase()) {
    case "approved":
    case "active":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
    case "request_pending":
      return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "denied":
    case "revoked":
    case "cancelled":
      return "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "expired":
      return "border-border/70 bg-background/80 text-muted-foreground";
    default:
      return "border-border/70 bg-background/80 text-muted-foreground";
  }
}

function isRevocableConsentStatus(status?: string | null) {
  return ["active", "approved", "granted"].includes(
    String(status || "").toLowerCase(),
  );
}

function lifecycleLabel(index: number) {
  return `Lifecycle ${index + 1}`;
}

function formatLifecycleEventLabel(event: ConsentTrailEvent) {
  const value = String(event.action || event.status || "Consent event")
    .replaceAll("_", " ")
    .toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function entrySummary(entry: ConsentCenterEntry) {
  if (entry.consent_trails && entry.consent_trails.length > 0) {
    const trailCount = entry.trail_count || entry.consent_trails.length;
    const eventCount =
      entry.event_count ||
      entry.consent_trails.reduce(
        (total, trail) => total + (trail.event_count || trail.events?.length || 0),
        0,
      );
    return `${eventCount} consent event${eventCount === 1 ? "" : "s"} across ${trailCount} lifecycle${trailCount === 1 ? "" : "s"}.`;
  }
  if (isEmailHelperConsent(entry.metadata)) {
    return emailHelperConsentSummary(entry.metadata);
  }
  if (isLocationConsent(entry.metadata, entry.scope)) {
    return locationConsentSummary(entry.metadata);
  }
  return resolveConsentSupportingCopy({
    scope: entry.scope,
    scopeDescription: entry.scope_description,

    reason: entry.reason,
    additionalAccessSummary: entry.additional_access_summary,
    kind: entry.kind,
    isScopeUpgrade: entry.is_scope_upgrade,
    existingGrantedScopes: entry.existing_granted_scopes,
  });
}

function consentEntryMatchesSelectedId(
  entry: ConsentCenterEntry,
  selectedId: string,
) {
  if (entry.id === selectedId || entry.request_id === selectedId) return true;
  if (entry.latest_request_id === selectedId) return true;
  if (entry.identifier_request_ids?.includes(selectedId)) return true;
  return Boolean(
    entry.consent_trails?.some(
      (trail) =>
        trail.id === selectedId ||
        trail.latest_request_id === selectedId ||
        trail.request_ids?.includes(selectedId) ||
        trail.events?.some(
          (event) => event.id === selectedId || event.request_id === selectedId,
        ),
    ),
  );
}

function consentEntryMatchesScope(entry: ConsentCenterEntry, scope: string) {
  if (entry.scope === scope) return true;
  return Boolean(
    entry.consent_trails?.some(
      (trail) =>
        trail.scope === scope ||
        trail.events?.some((event) => event.scope === scope),
    ),
  );
}

function applyConsentMutationToList(
  data: ConsentCenterPageListResponse,
  detail: ConsentMutationDetail,
): ConsentCenterPageListResponse {
  const requestId = detail.requestId?.trim();
  const scope = detail.scope?.trim();
  const nextItems = data.items.filter((entry) => {
    if (
      requestId &&
      (detail.action === "approve" || detail.action === "deny") &&
      consentEntryMatchesSelectedId(entry, requestId)
    ) {
      return false;
    }
    if (
      scope &&
      detail.action === "revoke" &&
      consentEntryMatchesScope(entry, scope)
    ) {
      return false;
    }
    return true;
  });
  if (nextItems.length === data.items.length) return data;
  return {
    ...data,
    items: nextItems,
    total: Math.max(0, data.total - (data.items.length - nextItems.length)),
  };
}

function applyConsentMutationToSummary(
  data: ConsentCenterPageSummary,
  detail: ConsentMutationDetail,
): ConsentCenterPageSummary {
  const counts = { ...data.counts };
  if (detail.action === "approve") {
    counts.pending = Math.max(0, counts.pending - 1);
    counts.active = Math.max(0, counts.active + 1);
  } else if (detail.action === "deny") {
    counts.pending = Math.max(0, counts.pending - 1);
    counts.previous = Math.max(0, counts.previous + 1);
  } else if (detail.action === "revoke") {
    counts.active = Math.max(0, counts.active - 1);
    counts.previous = Math.max(0, counts.previous + 1);
  }
  return { ...data, counts };
}

function relationshipSortValue(entry: ConsentCenterEntry) {
  const candidates = [entry.issued_at, entry.expires_at]
    .map((value) => (value ? new Date(value).getTime() : 0))
    .filter((value) => Number.isFinite(value));
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function relationshipPriority(entry: ConsentCenterEntry) {
  if (
    entry.kind === "active_grant" ||
    entry.status === "active" ||
    entry.status === "approved"
  ) {
    return 3;
  }
  if (
    entry.kind === "incoming_request" ||
    entry.kind === "outgoing_request" ||
    entry.status === "pending" ||
    entry.status === "request_pending"
  ) {
    return 2;
  }
  if (entry.kind === "invite") {
    return 1;
  }
  return 0;
}

function buildRelationshipEntries(
  center: ConsentCenterResponse | null,
): ConsentCenterEntry[] {
  if (!center) return [];

  const grouped = new Map<string, ConsentCenterEntry[]>();
  const sourceEntries = [
    ...center.incoming_requests,
    ...center.outgoing_requests,
    ...center.active_grants,
    ...center.history,
    ...center.invites,
  ];

  for (const entry of sourceEntries) {
    const counterpartKey = `${entry.counterpart_type}:${entry.counterpart_id || entry.counterpart_email || entry.counterpart_label || entry.id}`;
    const bucket = grouped.get(counterpartKey) || [];
    bucket.push(entry);
    grouped.set(counterpartKey, bucket);
  }

  const resolved: ConsentCenterEntry[] = [];
  for (const [key, entries] of grouped.entries()) {
    const sorted = [...entries].sort((left, right) => {
      const priorityDelta =
        relationshipPriority(right) - relationshipPriority(left);
      if (priorityDelta !== 0) return priorityDelta;
      return relationshipSortValue(right) - relationshipSortValue(left);
    });
    const primary = sorted[0];
    if (!primary) continue;
    const scopeLabels = Array.from(
      new Set(
        entries
          .map((entry) => entry.scope_description || entry.scope)
          .filter(Boolean),
      ),
    );
    resolved.push({
      ...primary,
      id: `relationship:${key}`,
      additional_access_summary:
        scopeLabels.length > 0
          ? `${scopeLabels.length} scope${scopeLabels.length === 1 ? "" : "s"} shared in this relationship`
          : primary.additional_access_summary,
    });
  }

  return resolved.sort(
    (left, right) => relationshipSortValue(right) - relationshipSortValue(left),
  );
}

function filterRelationshipEntries(
  entries: ConsentCenterEntry[],
  query: string,
): ConsentCenterEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) => {
    const haystack = [
      resolveCounterpartLabel(entry),
      entry.counterpart_email,
      entry.counterpart_secondary_label,
      entry.scope,
      entry.scope_description,
      entry.additional_access_summary,
      entry.reason,
      entry.relationship_status,
      entry.relationship_state,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function resolveCounterpartLabel(entry: ConsentCenterEntry) {
  return resolveConsentRequesterLabel({
    counterpartLabel: entry.counterpart_label,
    counterpartEmail: entry.counterpart_email,
    counterpartSecondaryLabel: entry.counterpart_secondary_label,
    counterpartId: entry.counterpart_id,
  });
}

function toPendingConsent(
  entry: ConsentCenterEntry,
  durationHours?: number,
): PendingConsent {
  const issuedAt =
    typeof entry.issued_at === "number" ? entry.issued_at : Date.now();
  const approvalTimeoutAt =
    typeof entry.approval_timeout_at === "number"
      ? entry.approval_timeout_at
      : entry.expires_at && typeof entry.expires_at === "number"
        ? entry.expires_at
        : undefined;

  return {
    id: entry.request_id || entry.id,
    developer: resolveCounterpartLabel(entry),
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt: issuedAt,
    approvalTimeoutAt,
    reason: entry.reason || undefined,
    requestUrl: entry.request_url || undefined,
    isScopeUpgrade: Boolean(entry.is_scope_upgrade),
    existingGrantedScopes: entry.existing_granted_scopes || undefined,
    additionalAccessSummary: entry.additional_access_summary || undefined,
    durationHours,
    metadata: entry.metadata || undefined,
  };
}

function pendingLookupItemToConsentEntry(
  item: PendingConsentLookupItem,
): ConsentCenterEntry {
  const requesterLabel =
    item.requester_label || item.developer || item.agent_id || "Requester";
  return {
    id: item.request_id,
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    scope: item.scope,
    scope_description: item.scope_description || null,
    counterpart_type: "developer",
    counterpart_id: item.agent_id || item.developer || requesterLabel,
    counterpart_label: requesterLabel,
    counterpart_image_url: item.requester_image_url || null,
    counterpart_website_url: item.requester_website_url || null,
    request_id: item.request_id,
    issued_at: item.issued_at || null,
    expires_at: item.poll_timeout_at || null,
    approval_timeout_at: item.poll_timeout_at || null,
    request_url: item.request_url || null,
    reason: item.reason || null,
    is_scope_upgrade: item.is_scope_upgrade || null,
    existing_granted_scopes: item.existing_granted_scopes || null,
    additional_access_summary: item.additional_access_summary || null,
    metadata: {
      ...(item.metadata || {}),
      ...(item.bundle_id ? { bundle_id: item.bundle_id } : {}),
      ...(item.bundle_label ? { bundle_label: item.bundle_label } : {}),
      ...(item.bundle_scope_count
        ? { bundle_scope_count: item.bundle_scope_count }
        : {}),
    },
  };
}

function ConsentCounterpartAvatar({ entry }: { entry: ConsentCenterEntry }) {
  const kind =
    entry.counterpart_type === "ria"
      ? "ria"
      : entry.counterpart_type === "developer"
        ? "developer"
        : "investor";
  const Icon = kind === "ria" ? Building2 : UserRound;
  const label = resolveCounterpartLabel(entry);
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
  return (
    <div
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border",
        kind === "ria"
          ? "border-sky-500/15 bg-sky-500/6 text-sky-700"
          : kind === "developer"
            ? "border-violet-500/15 bg-violet-500/6 text-violet-700"
            : "border-emerald-500/15 bg-emerald-500/6 text-emerald-700",
      )}
    >
      {initials ? (
        <span className="text-xs font-semibold">{initials}</span>
      ) : (
        <Icon className="h-4 w-4" />
      )}
    </div>
  );
}

function ConsentEntryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ConsentCenterEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const isIdentifierHistory =
    entry.kind === "history" && Boolean(entry.consent_trails?.length);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative w-full overflow-hidden rounded-[var(--app-card-radius-compact)] border px-4 py-3 text-left transition-colors",
        selected
          ? "border-sky-500/24 bg-sky-500/7"
          : "border-[color:var(--app-card-border-standard)]/50 bg-[color:var(--app-card-surface-compact)]/55 hover:bg-[color:var(--app-card-surface-compact)]",
      )}
    >
      <div className="flex items-start gap-3">
        <ConsentCounterpartAvatar entry={entry} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-foreground">
              {resolveCounterpartLabel(entry)}
            </p>
            <Badge
              className={cn(
                "shrink-0 capitalize",
                badgeClassName(entry.status),
              )}
            >
              {formatStatus(entry.status)}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {entry.counterpart_email ||
              entry.counterpart_secondary_label ||
              "Hussh connection"}
          </p>
        </div>
      </div>
      {isIdentifierHistory ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {entry.issued_at ? (
            <span className="rounded-full bg-muted/70 px-2.5 py-1">
              Latest {formatDate(entry.issued_at)}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/80">
            {entrySummary(entry)}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {entry.scope ? (
              <span>{entry.scope_description || entry.scope}</span>
            ) : null}
            {entry.expires_at ? (
              <span>{formatRelative(entry.expires_at)}</span>
            ) : null}
            {entry.issued_at ? <span>{formatDate(entry.issued_at)}</span> : null}
          </div>
        </>
      )}
      <MaterialRipple variant="none" effect="fade" className="z-0" />
    </button>
  );
}

function ConsentHistoryLifecycleDetails({
  entry,
  onRevokeScope,
  activeAction,
  isScopeBusy,
}: {
  entry: ConsentCenterEntry;
  onRevokeScope: (scope: string) => void;
  activeAction: ConsentActionState | null;
  isScopeBusy: (scope?: string | null) => boolean;
}) {
  const trails = sortedConsentTrails(entry);
  if (trails.length === 0) return null;

  return (
    <SettingsGroup
      embedded
      title="Consent history"
      description="Lifecycle details for this identifier. Each scope trail stays separate and ordered by latest activity."
    >
      <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        {trails.map((trail, trailIndex) => {
          const events = sortedTrailEvents(trail);
          const status = trail.status || trail.action || "history";
          const latestDate = formatDate(trail.issued_at || trail.expires_at);
          const scopeLabel =
            trail.scope_description ||
            (trail.scope ? humanizeConsentScope(trail.scope) : "Consent scope");
          const canRevoke =
            Boolean(trail.scope) && isRevocableConsentStatus(trail.status);
          const revokeBusy = isScopeBusy(trail.scope);
          return (
            <div
              key={
                trail.id ||
                trail.trail_key ||
                trail.latest_request_id ||
                `${entry.id}:${trailIndex}`
              }
              className="rounded-[var(--app-card-radius-compact)] border border-border/70 bg-background/70 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {lifecycleLabel(trailIndex)}
                  </div>
                  <div className="mt-1 text-sm font-semibold leading-5 text-foreground">
                    {scopeLabel}
                  </div>
                  {latestDate ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Latest {latestDate}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Badge className={cn("capitalize", badgeClassName(status))}>
                    {formatStatus(status)}
                  </Badge>
                  {canRevoke ? (
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={revokeBusy}
                      onClick={() => onRevokeScope(String(trail.scope))}
                    >
                      {revokeBusy && activeAction?.kind === "revoke"
                        ? "Revoking..."
                        : "Revoke"}
                    </Button>
                  ) : null}
                </div>
              </div>

              {events.length > 0 ? (
                <div className="mt-4 space-y-0">
                  {events.map((event, eventIndex) => {
                    const eventStatus = event.status || event.action;
                    return (
                      <div
                        key={`${event.request_id || event.id || trailIndex}-${event.action || event.status}-${event.issued_at || eventIndex}`}
                        className="grid grid-cols-[18px_1fr] gap-2"
                      >
                        <div className="flex flex-col items-center">
                          <span
                            className={cn(
                              "mt-1 h-2.5 w-2.5 rounded-full border",
                              badgeClassName(eventStatus),
                            )}
                          />
                          {eventIndex < events.length - 1 ? (
                            <span className="min-h-6 flex-1 border-l border-border/70" />
                          ) : null}
                        </div>
                        <div className="pb-3 text-xs last:pb-0">
                          <div className="font-medium text-foreground/85">
                            {formatLifecycleEventLabel(event)}
                          </div>
                          <div className="mt-0.5 leading-5 text-muted-foreground">
                            {[
                              event.scope_description ||
                                (event.scope
                                  ? humanizeConsentScope(event.scope)
                                  : null),
                              formatDate(event.issued_at || event.expires_at),
                            ]
                              .filter(Boolean)
                              .join(" · ") || "Event recorded"}
                          </div>
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
    </SettingsGroup>
  );
}

function ConsentEntryDetail({
  actor,
  entry,
  onApprove,
  onDeny,
  onRevoke,
  onRevokeScope,
  activeAction,
  isRequestBusy,
  isScopeBusy,
}: {
  actor: ConsentCenterActor;
  entry: ConsentCenterEntry | null;
  onApprove: (entry: ConsentCenterEntry, durationHours?: number) => void;
  onDeny: (entry: ConsentCenterEntry) => void;
  onRevoke: (entry: ConsentCenterEntry) => void;
  onRevokeScope: (scope: string) => void;
  activeAction: ConsentActionState | null;
  isRequestBusy: (requestId?: string | null) => boolean;
  isScopeBusy: (scope?: string | null) => boolean;
}) {
  const requestedDurationHours =
    typeof entry?.metadata?.expiry_hours === "number" ||
    typeof entry?.metadata?.expiry_hours === "string"
      ? entry.metadata.expiry_hours
      : null;
  const defaultDuration = String(Number(requestedDurationHours) || 24);
  const [selectedDuration, setSelectedDuration] = useState(defaultDuration);
  useEffect(() => {
    setSelectedDuration(defaultDuration);
  }, [defaultDuration, entry?.id]);

  if (!entry) {
    return (
      <SettingsGroup
        embedded
        title="Select a request"
        description="Choose an item from the list to review its details and available actions."
      >
        <SettingsRow
          title="Nothing selected yet"
          description="Pending, active, and previous items open here."
        />
      </SettingsGroup>
    );
  }

  const requestRoute =
    actor === "ria" && entry.counterpart_id
      ? buildRiaClientWorkspaceRoute(entry.counterpart_id, { tab: "access" })
      : null;
  const emailHelperHref = isEmailHelperConsent(entry.metadata)
    ? normalizeInternalAppHref(emailHelperWorkflowHref(entry.metadata))
    : null;
  const locationHref = isLocationConsent(entry.metadata, entry.scope)
    ? normalizeInternalAppHref(locationConsentWorkflowHref(entry.metadata))
    : null;

  const approvedDurationLabel =
    formatDurationHours(selectedDuration) ||
    formatDurationHours(requestedDurationHours);
  const durationOptions = durationOptionsFor(requestedDurationHours);
  const hasGroupedHistory =
    entry.kind === "history" && Boolean(entry.consent_trails?.length);
  const entryRequestId = entry.request_id || entry.id;
  const requestBusy = isRequestBusy(entryRequestId);
  const approveBusy =
    requestBusy &&
    activeAction?.kind === "approve" &&
    activeAction.requestId === entryRequestId;
  const denyBusy =
    requestBusy &&
    activeAction?.kind === "deny" &&
    activeAction.requestId === entryRequestId;
  const revokeBusy = entry.scope ? isScopeBusy(entry.scope) : false;
  const detailItems = [
    ["Status", formatStatus(entry.status)],
    [
      "Email or identity",
      entry.counterpart_email ||
        entry.counterpart_secondary_label ||
        "Available in technical details",
    ],
    [
      "Scope",
      entry.scope ? humanizeConsentScope(entry.scope) : "Not provided",
    ],
    ["Requested at", formatDate(entry.issued_at) || "Unavailable"],
    [
      "Expires",
      formatDate(entry.expires_at) ||
        formatRelative(entry.expires_at) ||
        "No expiry",
    ],
    requestedDurationHours
      ? [
          "Requested duration",
          formatDurationHours(requestedDurationHours) || "Unavailable",
        ]
      : null,
    entry.chain_request_count && entry.chain_request_count > 1
        ? [
            "Request trail",
            `${entry.chain_request_count} request events in this scope chain`,
          ]
        : null,
    entry.reason ? ["Reason", entry.reason] : null,
  ].filter((item): item is [string, string] => Boolean(item));

  return (
    <div className="space-y-4">
      <SettingsGroup
        embedded
        title="Decision"
        description="Approve or reject first. Details stay below for review before you decide."
      >
        {entry.kind === "incoming_request" && entry.status === "pending" ? (
          <>
            <SettingsRow
              title="Decision"
              description={
                approvedDurationLabel
                  ? `Allow access for ${approvedDurationLabel}, or reject the request.`
                  : "Allow or reject this access request."
              }
              trailing={
                <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
                  <Button
                    variant="blue-gradient"
                    effect="fill"
                    size="sm"
                    disabled={requestBusy}
                    onClick={() =>
                      onApprove(entry, parseDurationHours(selectedDuration))
                    }
                    data-voice-control-id="consent_approve"
                  >
                    {approveBusy ? "Allowing..." : "Allow"}
                  </Button>
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    disabled={requestBusy}
                    onClick={() => onDeny(entry)}
                    data-voice-control-id="consent_deny"
                  >
                    {denyBusy ? "Rejecting..." : "Don't allow"}
                  </Button>
                </div>
              }
              stackTrailingOnMobile
            />
            <SettingsRow
              title="Access duration"
              description={
                approvedDurationLabel
                  ? `Approval will expire after ${approvedDurationLabel}.`
                  : "Choose how long this approval should stay active."
              }
              trailing={
                <Select
                  value={selectedDuration}
                  onValueChange={setSelectedDuration}
                  disabled={requestBusy}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Duration" />
                  </SelectTrigger>
                  <SelectContent>
                    {durationOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
              stackTrailingOnMobile
            />
          </>
        ) : (
          <SettingsRow
            title="No pending decision"
            description="This entry is not waiting for an allow or reject decision."
          />
        )}
        {emailHelperHref ? (
          <SettingsRow
            title="Email reply"
            description="Review the email request, access approval, and draft in one place."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={emailHelperHref}>Open Email</Link>
              </Button>
            }
          />
        ) : null}
        {locationHref ? (
          <SettingsRow
            title="Location sharing"
            description="Review this location request, active access, and expiry in One Location."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={locationHref}>Open Location</Link>
              </Button>
            }
          />
        ) : null}
      </SettingsGroup>


      <SettingsGroup
        embedded
        title="Request details"
        description={entrySummary(entry)}
      >
        <div className="grid gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)] sm:grid-cols-2">
          {detailItems.map(([label, value]) => (
            <div key={label} className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {label}
              </div>
              <div className="text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                {value}
              </div>
            </div>
          ))}
        </div>

        {entry.kind === "active_grant" && entry.scope ? (
          <SettingsRow
            title="Revoke active access"
            description="Immediately stop this grant and keep the audit trail intact."
            trailing={
              <Button
                variant="none"
                effect="fade"
                size="sm"
                disabled={revokeBusy}
                onClick={() => onRevoke(entry)}
                data-voice-control-id="consent_revoke"
              >
                {revokeBusy ? "Revoking..." : "Revoke"}
              </Button>
            }
          />
        ) : null}

        {entry.request_url ? (
          <SettingsRow
            title="Open request link"
            description="Jump to the original request or disclosure surface."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link
                  href={
                    normalizeInternalAppHref(entry.request_url) ||
                    entry.request_url
                  }
                  data-voice-control-id="consent_open_request"
                >
                  Open
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            }
          />
        ) : null}

        {requestRoute ? (
          <SettingsRow
            title="Open client workspace"
            description="Review the dedicated client workspace, including access state, account branches, Kai parity, and the explorer view."
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link href={requestRoute}>Open client</Link>
              </Button>
            }
          />
        ) : null}
      </SettingsGroup>

      {hasGroupedHistory ? (
        <ConsentHistoryLifecycleDetails
          entry={entry}
          onRevokeScope={onRevokeScope}
          activeAction={activeAction}
          isScopeBusy={isScopeBusy}
        />
      ) : null}

      {entry.technical_identity?.user_id || entry.request_id || entry.scope ? (
        <SettingsGroup
          embedded
          title="Technical details"
          description="Stable identifiers stay available here without cluttering the primary review flow."
        >
          {entry.technical_identity?.user_id ? (
            <SettingsRow
              title="User ID"
              description={entry.technical_identity.user_id}
            />
          ) : null}
          {entry.request_id ? (
            <SettingsRow title="Request ID" description={entry.request_id} />
          ) : null}
          {entry.scope ? (
            <SettingsRow title="Scope ID" description={entry.scope} />
          ) : null}
        </SettingsGroup>
      ) : null}

      {!hasGroupedHistory &&
      entry.consent_chain &&
      entry.consent_chain.length > 1 ? (
        <SettingsGroup
          embedded
          title="Scope trail"
          description="Recent events for this requester and scope."
        >
          {entry.consent_chain.slice(0, 6).map((event) => (
            <SettingsRow
              key={`${event.request_id || event.id}-${event.action || event.status}`}
              title={formatStatus(event.status || event.action)}
              description={
                [
                  event.scope ? humanizeConsentScope(event.scope) : null,
                  formatDate(event.issued_at),
                ]
                  .filter(Boolean)
                  .join(" · ") || "Event recorded"
              }
            />
          ))}
        </SettingsGroup>
      ) : null}

      {/* Consent handshake timeline (Issue #122) */}
      {!hasGroupedHistory &&
      entry.counterpart_id &&
      entry.counterpart_type !== "self" ? (
        <SettingsGroup
          embedded
          title="Consent timeline"
          description="Full history of consent changes with this connection."
        >
          <div className="px-1 py-2">
            <HandshakeTimeline
              counterpartId={entry.counterpart_id}
              counterpartLabel={resolveCounterpartLabel(entry)}
              actor={actor}
            />
          </div>
        </SettingsGroup>
      ) : null}
    </div>
  );
}

export function ConsentCenterPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { getVaultOwnerToken, isVaultUnlocked } = useVault();
  const {
    activeControlId: activeVoiceControlId,
    lastInteractedControlId: lastVoiceControlId,
  } = useVoiceSurfaceControlTracking();
  const explicitActor = searchParams.get("actor");
  const explicitView = searchParams.get("view");
  const riaOutgoingCompatibilityRoute =
    explicitActor === "ria" && explicitView === "outgoing";
  const actor: ConsentCenterActor = riaOutgoingCompatibilityRoute
    ? "ria"
    : "investor";
  const apiActor: ConsentCenterActor | undefined =
    riaOutgoingCompatibilityRoute ? "ria" : undefined;
  const consentScopeKey = apiActor === "ria" ? "ria" : "one";
  const mode: ConsentManagerMode = "consents";
  const tab = resolveConsentTab(searchParams);
  const managerView: "incoming" | "outgoing" =
    riaOutgoingCompatibilityRoute ? "outgoing" : "incoming";
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const selectedId =
    searchParams.get("requestId") || searchParams.get("selected");
  const notificationAction = normalizeNotificationAction(
    searchParams.get("notificationAction"),
  );
  // Decouple the detail panel's visible open/close from the URL navigation.
  // Closing via setParam() -> router.replace() forces an App Router re-render of
  // this heavy route, which made the close button (and approve/deny dismissal)
  // feel laggy. We close the panel locally first, then sync the URL in a
  // transition so the navigation never blocks the close animation.
  const [panelCloseRequested, setPanelCloseRequested] = useState(false);
  const [, startPanelUrlSync] = useTransition();
  const isPanelOpen = Boolean(selectedId) && !panelCloseRequested;
  const [searchValue, setSearchValue] = useState(searchParams.get("q") || "");
  const deferredQuery = useDeferredValue(searchValue.trim());
  const [mutationTick, setMutationTick] = useState(0);
  const retryConsentCenter = () => {
    setMutationTick((value) => value + 1);
  };
  const summaryCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(user.uid, `${consentScopeKey}:${mode}`)
    : "consent_center_summary_guest";
  const listSurface =
    tab === "requests" ? "pending" : tab === "history" ? "previous" : "active";
  const listCacheKey = user?.uid
    ? CACHE_KEYS.CONSENT_CENTER_LIST(
        user.uid,
        `${consentScopeKey}:${mode}`,
        listSurface,
        deferredQuery,
        page,
        CONSENT_CENTER_PAGE_SIZE,
      )
    : "consent_center_list_guest";
  const [retainedSummary, setRetainedSummary] = useState<{
    key: string;
    data: ConsentCenterPageSummary;
  } | null>(null);
  const [retainedList, setRetainedList] = useState<{
    key: string;
    data: ConsentCenterPageListResponse;
  } | null>(null);
  const [locallyHandledRequestIds, setLocallyHandledRequestIds] = useState<
    Set<string>
  >(() => new Set());
  const [locallyRevokedScopes, setLocallyRevokedScopes] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const current = searchParams.get("q") || "";
    if (current !== searchValue) {
      setSearchValue(current);
    }
  }, [searchParams, searchValue]);

  useEffect(() => {
    if (searchParams.get("mode") !== "connections") return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("mode");
    const query = next.toString();
    router.replace(query ? `${ROUTES.CONSENTS}?${query}` : ROUTES.CONSENTS, {
      scroll: false,
    });
  }, [router, searchParams]);

  useEffect(() => {
    if (!explicitActor && !explicitView) return;
    if (riaOutgoingCompatibilityRoute) return;

    const next = new URLSearchParams(searchParams.toString());
    next.delete("actor");
    next.delete("view");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [
    explicitActor,
    explicitView,
    pathname,
    riaOutgoingCompatibilityRoute,
    router,
    searchParams,
  ]);

  const {
    handleApprove,
    handleDeny,
    handleRevoke,
    activeAction: genericActiveAction,
    isRequestBusy: isGenericRequestBusy,
    isScopeBusy: isGenericScopeBusy,
  } = useConsentActions({
    userId: user?.uid,
  });

  // One Location rows in the Access Manager are end-to-end encrypted and must go
  // through the dedicated One Location endpoints + envelope publish, NOT the
  // generic developer-consent flow. This hook mirrors the One Location page's
  // Activity actions so Allow / Don't allow / Revoke behave identically on both
  // surfaces (see lib/consent/use-one-location-consent-actions.ts).
  const {
    handleApprove: handleLocationApprove,
    handleDeny: handleLocationDeny,
    handleRevoke: handleLocationRevoke,
    activeAction: locationActiveAction,
    isRequestBusy: isLocationRequestBusy,
    isScopeBusy: isLocationScopeBusy,
  } = useOneLocationConsentActions({
    userId: user?.uid,
  });

  const activeAction = genericActiveAction ?? locationActiveAction;
  const isRequestBusy = useCallback(
    (requestId?: string | null) =>
      isGenericRequestBusy(requestId) || isLocationRequestBusy(requestId),
    [isGenericRequestBusy, isLocationRequestBusy],
  );
  const isScopeBusy = useCallback(
    (scope?: string | null) =>
      isGenericScopeBusy(scope) || isLocationScopeBusy(scope),
    [isGenericScopeBusy, isLocationScopeBusy],
  );

  // Route a consent entry to the correct backend pipeline. Location rows
  // (`metadata.request_source` starts with `one_location`, or a location-family
  // scope) use the One Location hook; everything else uses the generic flow.
  const isLocationEntry = useCallback(
    (entry: ConsentCenterEntry) =>
      isLocationConsent(entry.metadata, entry.scope),
    [],
  );
  const approveEntry = useCallback(
    (entry: ConsentCenterEntry, durationHours?: number) => {
      if (isLocationEntry(entry)) {
        void handleLocationApprove(entry, durationHours);
        return;
      }
      void handleApprove(toPendingConsent(entry, durationHours));
    },
    [handleApprove, handleLocationApprove, isLocationEntry],
  );
  const denyEntry = useCallback(
    (entry: ConsentCenterEntry) => {
      if (isLocationEntry(entry)) {
        void handleLocationDeny(entry);
        return;
      }
      void handleDeny(entry.request_id || entry.id);
    },
    [handleDeny, handleLocationDeny, isLocationEntry],
  );
  const revokeEntry = useCallback(
    (entry: ConsentCenterEntry) => {
      if (isLocationEntry(entry)) {
        void handleLocationRevoke(entry);
        return;
      }
      if (!entry.scope) return;
      void handleRevoke(entry.scope);
    },
    [handleLocationRevoke, handleRevoke, isLocationEntry],
  );

  const idTokenLoader = async () => user?.getIdToken();


  const summaryResource = useStaleResource({
    cacheKey: summaryCacheKey,
    refreshKey: `${consentScopeKey}:${mode}:${mutationTick}`,
    enabled: Boolean(user?.uid),
    load: async (options) => {
      const idToken = await idTokenLoader();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        actor: apiActor,
        mode,
        force: Boolean(options?.force) || mutationTick > 0,
      });
    },
  });

  const centerResource = useStaleResource({
    cacheKey: user?.uid
      ? CACHE_KEYS.CONSENT_CENTER(user.uid, `${actor}:${managerView}`)
      : "consent_center_guest",
    refreshKey: `${actor}:${managerView}:${mutationTick}`,
    enabled: Boolean(user?.uid && tab === "relationships"),
    load: async (options) => {
      const idToken = await idTokenLoader();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.getCenter({
        idToken,
        userId: user.uid,
        actor,
        view: managerView,
        force: Boolean(options?.force) || mutationTick > 0,
      });
    },
  });

  const listResource = useStaleResource({
    cacheKey: listCacheKey,
    refreshKey: `${consentScopeKey}:${mode}:${listSurface}:${deferredQuery}:${page}:${mutationTick}`,
    enabled: Boolean(user?.uid && tab !== "relationships"),
    load: async (options) => {
      const idToken = await idTokenLoader();
      if (!user?.uid || !idToken) {
        throw new Error("Sign in to review consents");
      }
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
        actor: apiActor,
        mode,
        surface: listSurface,
        q: deferredQuery,
        page,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: Boolean(options?.force) || mutationTick > 0,
      });
    },
  });
  const forcedMutationRefreshRef = useRef(0);

  useEffect(() => {
    if (!mutationTick) return;
    if (forcedMutationRefreshRef.current === mutationTick) return;
    forcedMutationRefreshRef.current = mutationTick;

    void summaryResource.refresh({ force: true });
    if (tab === "relationships") {
      void centerResource.refresh({ force: true });
    } else {
      void listResource.refresh({ force: true });
    }
  }, [
    centerResource,
    listResource,
    mutationTick,
    summaryResource,
    tab,
  ]);

  useEffect(() => {
    if (summaryResource.data) {
      setRetainedSummary({ key: summaryCacheKey, data: summaryResource.data });
    }
  }, [summaryCacheKey, summaryResource.data]);

  useEffect(() => {
    if (listResource.data) {
      setRetainedList({ key: listCacheKey, data: listResource.data });
    }
  }, [listCacheKey, listResource.data]);
  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === summaryCacheKey ? retainedSummary.data : null);
  const listData =
    listResource.data ??
    (retainedList?.key === listCacheKey ? retainedList.data : null);

  const applyConfirmedConsentMutation = useCallback(
    (detail: Partial<ConsentMutationDetail>) => {
      const action = detail.action;
      const requestId = detail.requestId?.trim();
      const scope = detail.scope?.trim();
      if (!action) return;

      if ((action === "approve" || action === "deny") && requestId) {
        setLocallyHandledRequestIds((current) => {
          const next = new Set(current);
          next.add(requestId);
          return next;
        });
      }
      if (action === "revoke" && scope) {
        setLocallyRevokedScopes((current) => {
          const next = new Set(current);
          next.add(scope);
          return next;
        });
      }

      const normalizedDetail: ConsentMutationDetail = {
        action,
        requestId,
        scope,
        source: "consent_actions",
      };

      setRetainedSummary((current) => {
        const base =
          current?.key === summaryCacheKey
            ? current.data
            : summaryData ?? null;
        if (!base) return current;
        return {
          key: summaryCacheKey,
          data: applyConsentMutationToSummary(base, normalizedDetail),
        };
      });

      setRetainedList((current) => {
        const base =
          current?.key === listCacheKey ? current.data : listData ?? null;
        if (!base) return current;
        return {
          key: listCacheKey,
          data: applyConsentMutationToList(base, normalizedDetail),
        };
      });
    },
    [listCacheKey, listData, summaryCacheKey, summaryData],
  );

  useEffect(() => {
    const handleAction = (event: Event) => {
      const detail =
        (event as CustomEvent<Partial<ConsentMutationDetail>>).detail || {};
      applyConfirmedConsentMutation(detail);
      setMutationTick((value) => value + 1);
    };
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    };
  }, [applyConfirmedConsentMutation]);

  const relationshipItems = useMemo(
    () =>
      filterRelationshipEntries(
        buildRelationshipEntries(centerResource.data || null),
        deferredQuery,
      ),
    [centerResource.data, deferredQuery],
  );
  const items = useMemo(
    () => {
      const source =
        tab === "relationships" ? relationshipItems : listData?.items || [];
      return source.filter((entry) => {
        if (
          listSurface === "pending" &&
          entry.request_id &&
          locallyHandledRequestIds.has(entry.request_id)
        ) {
          return false;
        }
        if (listSurface === "pending" && locallyHandledRequestIds.has(entry.id)) {
          return false;
        }
        if (
          entry.scope &&
          locallyRevokedScopes.has(entry.scope) &&
          entry.kind === "active_grant"
        ) {
          return false;
        }
        return true;
      });
    },
    [
      listData?.items,
      locallyHandledRequestIds,
      locallyRevokedScopes,
      listSurface,
      relationshipItems,
      tab,
    ],
  );
  const selectedEntryFromList = useMemo(() => {
    if (!items.length) return null;
    if (selectedId) {
      return (
        items.find((item) => consentEntryMatchesSelectedId(item, selectedId)) ??
        null
      );
    }
    return items[0] ?? null;
  }, [items, selectedId]);
  const shouldLookupSelectedPending = Boolean(
    user?.uid &&
      selectedId &&
      tab === "requests" &&
      !selectedEntryFromList &&
      !listResource.loading,
  );
  const selectedPendingLookupResource = useStaleResource({
    cacheKey:
      user?.uid && selectedId
        ? `consent_pending_lookup:${user.uid}:${selectedId}`
        : "consent_pending_lookup_guest",
    refreshKey: `${selectedId || ""}:${mutationTick}:${isVaultUnlocked ? "unlocked" : "locked"}`,
    enabled: shouldLookupSelectedPending,
    load: async () => {
      const vaultOwnerToken = getVaultOwnerToken();
      if (!user?.uid || !vaultOwnerToken) {
        throw new Error("Unlock your vault to open this consent request.");
      }
      return ConsentCenterService.lookupPendingRequests({
        vaultOwnerToken,
        userId: user.uid,
        requestIds: selectedId ? [selectedId] : [],
      });
    },
  });
  const selectedLookupEntry = useMemo(() => {
    const item = selectedPendingLookupResource.data?.items?.[0];
    if (!item || locallyHandledRequestIds.has(item.request_id)) return null;
    return pendingLookupItemToConsentEntry(item);
  }, [locallyHandledRequestIds, selectedPendingLookupResource.data]);
  const activeListError =
    tab === "relationships" ? centerResource.error : listResource.error;
  const activeListLoading =
    tab === "relationships" ? centerResource.loading : listResource.loading;
  const activeListRefreshing =
    tab === "relationships"
      ? centerResource.refreshing
      : listResource.refreshing;
  const consentLoadError = activeListError || summaryResource.error;
  const isAuthLoadError = isAuthConsentLoadError(consentLoadError);
  const hasVisibleConsentListData =
    items.length > 0 ||
    (tab === "relationships"
      ? Boolean(centerResource.data)
      : Boolean(listData));
  const showCompactRetryState = Boolean(
    consentLoadError && hasVisibleConsentListData && !isAuthLoadError,
  );
  const showFullRetryState = Boolean(
    consentLoadError && !hasVisibleConsentListData && !isAuthLoadError,
  );
  const showSessionRecovery = Boolean(
    (!authLoading && !user) || (isAuthLoadError && !hasVisibleConsentListData),
  );
  const visibleSnapshot =
    tab === "relationships" ? centerResource.snapshot : listResource.snapshot;
  const isConsentActionRefreshing =
    summaryResource.refreshing ||
    listResource.refreshing ||
    centerResource.refreshing;
  const accessibilityStatusMessage = activeListLoading
    ? "Consent entries are loading."
    : activeListRefreshing
      ? "Consent entries are refreshing."
      : consentLoadError
        ? "Consent entries failed to refresh."
        : "";
  const selectedEntry = useMemo(() => {
    if (selectedId) {
      return selectedEntryFromList || selectedLookupEntry;
    }
    return selectedEntryFromList;
  }, [selectedEntryFromList, selectedId, selectedLookupEntry]);
  const selectedRequestMissing = Boolean(
    selectedId &&
      selectedPendingLookupResource.data?.missing_request_ids?.includes(selectedId),
  );
  const selectedRequestResolving = Boolean(
    selectedId &&
      !selectedEntry &&
      (listResource.loading ||
        selectedPendingLookupResource.loading ||
        selectedPendingLookupResource.refreshing),
  );
  const selectedRequestNeedsUnlock = Boolean(
    selectedId &&
      !selectedEntry &&
      shouldLookupSelectedPending &&
      (!isVaultUnlocked ||
        selectedPendingLookupResource.error
          ?.toLowerCase()
          .includes("unlock")),
  );
  const selectedPendingConsent = useMemo(
    () => (selectedEntry ? toPendingConsent(selectedEntry) : null),
    [selectedEntry],
  );
  const listMismatchRetryRef = useRef<string | null>(null);

  useEffect(() => {
    if (tab === "relationships") return;
    if (deferredQuery) return;
    if (listResource.loading || listResource.refreshing) return;
    if (!summaryData || !listData) return;

    const expectedCount =
      listSurface === "pending"
        ? summaryData.counts.pending
        : listSurface === "active"
          ? summaryData.counts.active
          : summaryData.counts.previous;
    if (expectedCount <= 0) return;
    if (listData.total > 0 || items.length > 0) return;

    const retryKey = `${listCacheKey}:${listSurface}:${expectedCount}:${mutationTick}`;
    if (listMismatchRetryRef.current === retryKey) return;
    listMismatchRetryRef.current = retryKey;
    void listResource.refresh({ force: true });
  }, [
    deferredQuery,
    items.length,
    listCacheKey,
    listData,
    listResource,
    listSurface,
    mutationTick,
    summaryData,
    tab,
  ]);
  const consentVoiceSurfaceMetadata = useMemo(() => {
    const tabTitle =
      tab === "requests" ? "Pending" : tab === "active" ? "Active" : "Previous";
    const actions = [
      {
        id: "consents.search",
        label: "Search consents",
        purpose:
          "Filters the current consent list by name, email, scope, or reason.",
        voiceAliases: ["search consents", "filter consents"],
      },
      {
        id: "consents.review",
        label: "Review consent details",
        purpose: "Opens the selected consent request details and next actions.",
        voiceAliases: ["review consent", "open consent details"],
      },
      ...(selectedEntry?.kind === "incoming_request" &&
      selectedEntry.status === "pending"
        ? [
            {
              id: "consents.approve",
              label: "Approve request",
              purpose: "Approves the selected incoming consent request.",
              voiceAliases: ["approve request", "approve consent"],
            },
            {
              id: "consents.deny",
              label: "Deny request",
              purpose: "Denies the selected incoming consent request.",
              voiceAliases: ["deny request", "deny consent"],
            },
          ]
        : []),
      ...(selectedEntry?.kind === "active_grant" && selectedEntry.scope
        ? [
            {
              id: "consents.revoke",
              label: "Revoke active access",
              purpose: "Revokes the selected active consent grant.",
              voiceAliases: ["revoke access", "revoke consent"],
            },
          ]
        : []),
    ];

    return {
      screenId: "consents",
      title: "Consent manager",
      purpose:
        "This screen is the permission workspace for reviewing pending requests, active grants, and prior decisions.",
      sections: [
        {
          id: "pending",
          title: "Pending",
          purpose: "Shows consent requests waiting for a decision.",
        },
        {
          id: "active",
          title: "Active",
          purpose: "Shows currently active consent grants.",
        },
        {
          id: "previous",
          title: "Previous",
          purpose: "Shows prior consent decisions and closed requests.",
        },
        {
          id: "consent_details",
          title: "Consent details",
          purpose:
            "Shows the selected request details and next available actions.",
        },
      ],
      actions,
      controls: [
        {
          id: "consent_search",
          label: "Search consents",
          purpose: "Filters the current consent list.",
          actionId: "consents.search",
          role: "input",
        },
        {
          id: "consent_detail_panel",
          label: "Consent details",
          purpose: "Shows the selected consent request details and actions.",
          actionId: "consents.review",
          role: "panel",
        },
        ...(selectedEntry?.kind === "incoming_request" &&
        selectedEntry.status === "pending"
          ? [
              {
                id: "consent_approve",
                label: "Approve request",
                purpose: "Approves the selected incoming consent request.",
                actionId: "consents.approve",
                role: "button",
              },
              {
                id: "consent_deny",
                label: "Deny request",
                purpose: "Denies the selected incoming consent request.",
                actionId: "consents.deny",
                role: "button",
              },
            ]
          : []),
        ...(selectedEntry?.kind === "active_grant" && selectedEntry.scope
          ? [
              {
                id: "consent_revoke",
                label: "Revoke active access",
                purpose: "Revokes the selected active grant.",
                actionId: "consents.revoke",
                role: "button",
              },
            ]
          : []),
      ],
      concepts: [
        {
          id: "consents",
          label: "Consents",
          explanation:
            "Consents is the permission workspace where sharing requests and active grants are reviewed.",
          aliases: ["consents", "consent center", "consent manager"],
        },
      ],
      activeSection: tabTitle,
      activeTab: tab,
      visibleModules: [
        "Consent manager",
        tabTitle,
        ...(selectedEntry ? ["Consent details"] : []),
      ],
      focusedWidget: selectedEntry ? "Consent details" : "Consent manager",
      searchQuery: searchValue.trim() || null,
      availableActions: actions.map((action) => action.label),
      activeControlId:
        activeVoiceControlId || (selectedEntry ? "consent_detail_panel" : null),
      lastInteractedControlId: lastVoiceControlId,
      activeFilters: riaOutgoingCompatibilityRoute ? [actor, managerView] : [],
      selectedEntity: selectedEntry
        ? resolveCounterpartLabel(selectedEntry)
        : null,
      busyOperations: [
        ...(summaryResource.loading ? ["consent_summary_load"] : []),
        ...(listResource.loading ? ["consent_list_load"] : []),
        ...(listResource.refreshing ? ["consent_list_refresh"] : []),
      ],
      screenMetadata: {
        actor,
        tab,
        manager_view: managerView,
        pending_count: summaryData?.counts.pending ?? 0,
        active_count: summaryData?.counts.active ?? 0,
        previous_count: summaryData?.counts.previous ?? 0,
        selected_request_id:
          selectedEntry?.request_id || selectedEntry?.id || null,
        selected_status: selectedEntry?.status || null,
        selected_scope: selectedEntry?.scope || null,
        detail_open: Boolean(selectedId),
        visible_entry_count: items.length,
        total_entries: listData?.total || 0,
      },
    };
  }, [
    activeVoiceControlId,
    actor,
    items.length,
    lastVoiceControlId,
    listData?.total,
    listResource.loading,
    listResource.refreshing,
    managerView,
    riaOutgoingCompatibilityRoute,
    searchValue,
    selectedEntry,
    selectedId,
    summaryData?.counts.active,
    summaryData?.counts.pending,
    summaryData?.counts.previous,
    summaryResource.loading,
    tab,
  ]);
  usePublishVoiceSurfaceMetadata(consentVoiceSurfaceMetadata);

  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    if (!riaOutgoingCompatibilityRoute && !("actor" in updates)) {
      next.delete("actor");
      next.delete("view");
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  // Close the detail panel instantly, then clear its URL params in a transition
  // so the route navigation never blocks the panel's close animation.
  const closeDetailPanel = useCallback(() => {
    setPanelCloseRequested(true);
    startPanelUrlSync(() => {
      setParam({
        requestId: null,
        selected: null,
        notificationAction: null,
      });
    });
    // setParam intentionally excluded; it is recreated each render and only
    // reads current searchParams/router refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPanelUrlSync]);

  // When the selected request changes (deep link, list selection, or after the
  // URL finishes clearing), drop the local close override so the panel can open
  // again and stays in sync with the URL.
  useEffect(() => {
    setPanelCloseRequested(false);
  }, [selectedId]);

  const pageEyebrow = "Access / Consent";
  const pageTitle = "Access manager";
  const relationshipCount = relationshipItems.length;
  const pageDescription =
    actor === "ria"
      ? "Requests, active access, history, and relationship state live in one canonical advisor access manager."
      : managerView === "outgoing"
        ? "Outgoing access requests, active access, history, and relationship state stay grouped in one canonical access workspace."
        : "Incoming access requests, active access, history, and relationship state stay grouped in one canonical access workspace.";
  const searchPlaceholder =
    tab === "relationships"
      ? "Search relationships by name, email, scope, or status"
      : `Search ${tab} by name, email, scope, or reason`;

  return (
    <AppPageShell as="main" width="expanded" className="pb-24 sm:pb-28">
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow={pageEyebrow}
          title={pageTitle}
          description={pageDescription}
          icon={ShieldCheck}
          accent="consent"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
          <section className="space-y-4" data-testid="consent-manager-primary">
            <SettingsSegmentedTabs
              value={tab}
              onValueChange={(value) =>
                setParam({ tab: value, page: "1", requestId: null })
              }
              options={[
                {
                  value: "requests",
                  label: `Requests (${summaryData?.counts.pending ?? 0})`,
                },
                {
                  value: "active",
                  label: `Active Access (${summaryData?.counts.active ?? 0})`,
                },
                {
                  value: "history",
                  label: `History (${summaryData?.counts.previous ?? 0})`,
                },
                {
                  value: "relationships",
                  label: `Relationships (${relationshipCount})`,
                },
              ]}
            />

            <div className="flex items-center justify-between gap-3">
              {visibleSnapshot ? (
                <StaleCacheTimestamp
                  updatedAt={visibleSnapshot.timestamp}
                  stale={Boolean(activeListError && items.length > 0)}
                />
              ) : (
                <span />
              )}
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                onClick={retryConsentCenter}
                aria-label="Refresh consent entries"
                disabled={isConsentActionRefreshing}
              >
                <RefreshCcw
                  className={cn(
                    "mr-2 h-4 w-4",
                    isConsentActionRefreshing && "animate-spin",
                  )}
                />
                Refresh
              </Button>
            </div>

            <SettingsGroup embedded>
              <div className="px-4 py-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchValue}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSearchValue(next);
                      setParam({ q: next || null, page: "1" });
                    }}
                    placeholder={searchPlaceholder}
                    className="pl-9"
                    data-voice-control-id="consent_search"
                  />
                </div>
                {(tab === "relationships"
                  ? centerResource.loading || centerResource.refreshing
                  : listResource.loading || listResource.refreshing) &&
                items.length > 0 ? (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Refreshing from the latest consent state…
                  </div>
                ) : null}
              </div>
            </SettingsGroup>

            <section data-testid="consent-manager-list">
              <SettingsGroup embedded>
                <div className="space-y-2 px-2 py-2">
                  <AccessibilityStatusAnnouncer
                    message={accessibilityStatusMessage}
                  />

                  {showSessionRecovery ? <SessionExpiryRecovery /> : null}

                  {isConsentActionRefreshing && items.length > 0 ? (
                    <AsyncActionStatus
                      state="loading"
                      label="Refreshing consent state..."
                      compact
                    />
                  ) : null}

                  {showCompactRetryState ? (
                    <ApiRetryState
                      variant="compact"
                      title="Showing saved consent data"
                      description="The latest refresh failed. You can keep reviewing cached data or refresh from the page header."
                      onRetry={retryConsentCenter}
                      showRetryAction={false}
                    />
                  ) : null}

                  {showFullRetryState && !showSessionRecovery ? (
                    <ApiRetryState
                      title="Consent service is unavailable"
                      description={
                        consentLoadError
                          ? `The consent service did not return the latest access state. ${consentLoadError}`
                          : "The consent service did not return the latest access state. Refresh from the page header when the backend is available."
                      }
                      onRetry={retryConsentCenter}
                      showRetryAction={false}
                    />
                  ) : null}

                  {listResource.loading &&
                  items.length === 0 &&
                  !showFullRetryState ? (
                    <div className="px-3 py-6 text-sm text-muted-foreground">
                      Loading consent entries…
                    </div>
                  ) : null}
                  {!listResource.loading &&
                  !showFullRetryState &&
                  tab !== "relationships" &&
                  items.length === 0 ? (
                    <div className="px-3 py-8 text-sm text-muted-foreground">
                      No {tab} entries match this view right now.
                    </div>
                  ) : null}
                  {!centerResource.loading &&
                  !showFullRetryState &&
                  tab === "relationships" &&
                  items.length === 0 ? (
                    <div className="px-3 py-8 text-sm text-muted-foreground">
                      No relationship entries match this view right now.
                    </div>
                  ) : null}
                  {items.map((entry, index) => (
                    <ConsentEntryRow
                      key={`${entry.kind}-${entry.id}-${entry.request_id || "no-request"}-${index}`}
                      entry={entry}
                      selected={
                        selectedEntry?.id === entry.id ||
                        selectedEntry?.request_id === entry.request_id ||
                        Boolean(
                          selectedId &&
                            consentEntryMatchesSelectedId(entry, selectedId),
                        )
                      }
                      onSelect={() =>
                        setParam({
                          requestId: entry.request_id || entry.id,
                        })
                      }
                    />
                  ))}
                </div>

                {tab !== "relationships" && listData ? (
                  <PaginatedListFooter
                    page={listData.page}
                    limit={listData.limit}
                    total={listData.total}
                    hasMore={listData.has_more}
                    onPrevious={() =>
                      setParam({ page: String(Math.max(1, page - 1)) })
                    }
                    onNext={() => setParam({ page: String(page + 1) })}
                  />
                ) : null}
              </SettingsGroup>
            </section>
          </section>
        </SurfaceStack>
      </AppPageContentRegion>

      <SettingsDetailPanel
        open={isPanelOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeDetailPanel();
          }
        }}
        title={
          selectedEntry
            ? resolveCounterpartLabel(selectedEntry)
            : "Consent details"
        }
        description={
          selectedEntry
            ? `${formatStatus(selectedEntry.status)} request`
            : selectedId
              ? "Resolving the selected consent request."
            : "Choose a consent entry from the list to review details and next actions."
        }
      >
        {notificationAction && selectedEntry?.status === "pending" ? (
          <SettingsGroup
            embedded
            title="Notification action pending"
            description={
              notificationAction === "review"
                ? "This request was opened from a notification. Review the details below."
                : notificationAction === "approve"
                  ? "Approve was chosen from the notification. Final approval still happens here after vault confirmation."
                  : "Deny was chosen from the notification. Final denial still happens here after vault confirmation."
            }
          >
            <SettingsRow
              title={
                notificationAction === "approve"
                  ? "Confirm approval in app"
                  : notificationAction === "deny"
                    ? "Confirm denial in app"
                    : "Continue review"
              }
              description={
                notificationAction === "review"
                  ? "Use the actions below when you are ready."
                  : "Notification actions never commit access changes by themselves."
              }
              trailing={
                <div className="flex items-center gap-2">
                  {notificationAction === "approve" &&
                  selectedEntry &&
                  selectedPendingConsent ? (
                    <Button
                      variant="blue-gradient"
                      effect="fill"
                      size="sm"
                      disabled={isRequestBusy(selectedPendingConsent.id)}
                      onClick={() => {
                        approveEntry(selectedEntry);
                        closeDetailPanel();
                      }}
                    >
                      {activeAction?.kind === "approve" &&
                      activeAction.requestId === selectedPendingConsent.id
                        ? "Allowing..."
                        : "Confirm allow"}
                    </Button>
                  ) : null}
                  {notificationAction === "deny" && selectedEntry ? (
                    <Button
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={isRequestBusy(
                        selectedEntry.request_id || selectedEntry.id,
                      )}
                      onClick={() => {
                        denyEntry(selectedEntry);
                        closeDetailPanel();
                      }}
                    >

                      {activeAction?.kind === "deny" &&
                      activeAction.requestId ===
                        (selectedEntry.request_id || selectedEntry.id)
                        ? "Rejecting..."
                        : "Confirm don't allow"}
                    </Button>
                  ) : null}
                  <Button
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={() => setParam({ notificationAction: null })}
                  >
                    Dismiss
                  </Button>
                </div>
              }
            />
          </SettingsGroup>
        ) : null}
        {selectedId && !selectedEntry ? (
          <SettingsGroup
            embedded
            title="Request status"
            description="This link points to a specific consent request. We resolve it from the current list first, then from the scoped request lookup."
          >
            {selectedRequestResolving ? (
              <SettingsRow
                title="Loading request"
                description={`Fetching details for ${selectedId}.`}
              />
            ) : selectedRequestNeedsUnlock ? (
              <SettingsRow
                title="Unlock vault to review"
                description="This request was not in the current page. Unlock your vault so One can resolve the exact consent request by ID."
              />
            ) : selectedPendingLookupResource.error ? (
              <SettingsRow
                title="Could not load request"
                description={selectedPendingLookupResource.error}
              />
            ) : selectedRequestMissing ? (
              <SettingsRow
                title="Request not found"
                description="This request may already be approved, denied, expired, or belong to a different consent lane. Use the tabs to check Active Access or History."
                trailing={
                  <Button
                    type="button"
                    variant="none"
                    effect="fade"
                    size="sm"
                    onClick={closeDetailPanel}
                  >
                    View list
                  </Button>
                }
                stackTrailingOnMobile
              />
            ) : (
              <SettingsRow
                title="Request not visible"
                description="The current pending list did not include this request. Refresh from the page header or check the History tab if it was already handled."
              />
            )}
          </SettingsGroup>
        ) : (
          <ConsentEntryDetail
            actor={actor}
            entry={selectedEntry}
            onApprove={(entry, durationHours) => {
              approveEntry(entry, durationHours);
              // Dismiss the panel immediately; the list already optimistically
              // removes the row and any failure surfaces via toast.
              closeDetailPanel();
            }}
            onDeny={(entry) => {
              denyEntry(entry);
              closeDetailPanel();
            }}
            onRevoke={(entry) => {
              revokeEntry(entry);
            }}

            onRevokeScope={(scope) => void handleRevoke(scope)}
            activeAction={activeAction}
            isRequestBusy={isRequestBusy}
            isScopeBusy={isScopeBusy}
          />
        )}
      </SettingsDetailPanel>
    </AppPageShell>
  );
}

"use client";

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
  UserRound,
} from "lucide-react";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CapabilityExploreCard } from "@/components/onboarding/setup/capability-explore-card";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
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
import { runMarketplaceDeliverySweep } from "@/lib/one-marketplace/delivery-sweep";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import {
  isLocalConsentPreviewRuntime,
  loadLocalConsentPreviewModule,
  syncLocalConsentPreviewSession,
} from "@/lib/consent/local-consent-preview-gate";
import {
  useConsentActions,
  useOneLocationConsentActions,
  useMarketplaceConsentActions,
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
import { isMarketplaceConsent } from "@/lib/consent/marketplace-consent";
import { normalizeInternalAppHref } from "@/lib/consent/consent-sheet-route";
import { isConnectionRequestEntry } from "@/components/consent/connection-request-entry";
import { ConnectionsService } from "@/lib/services/connections-service";

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
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { Button } from "@/lib/morphy-ux/button";
import { buildRiaClientWorkspaceRoute, ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import {
  usePublishVoiceSurfaceMetadata,
  useVoiceSurfaceControlTracking,
} from "@/lib/voice/voice-surface-metadata";

type ConsentTab = "requests" | "active" | "history" | "connections";
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
  // "relationships" is the legacy name for the Connections tab.
  if (value === "connections" || value === "relationships")
    return "connections";
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
    viewParam === "connections" ||
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
  return `Access ${index + 1}`;
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
        (total, trail) =>
          total + (trail.event_count || trail.events?.length || 0),
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

function consentEntryMatchesBundleId(
  entry: ConsentCenterEntry,
  bundleId: string,
) {
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  return Boolean(metadata && metadata.bundle_id === bundleId);
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

function buildConnectionEntries(
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
      id: `connection:${key}`,
      additional_access_summary:
        scopeLabels.length > 0
          ? `${scopeLabels.length} scope${scopeLabels.length === 1 ? "" : "s"} shared in this connection`
          : primary.additional_access_summary,
    });
  }

  return resolved.sort(
    (left, right) => relationshipSortValue(right) - relationshipSortValue(left),
  );
}

function filterConnectionEntries(
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
          ? "border-accent-border bg-accent-surface text-accent-strong"
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
  const counterpartSubtitle =
    entry.counterpart_email || entry.counterpart_secondary_label || null;
  const scopeLabel = entry.scope
    ? entry.scope_description || humanizeConsentScope(entry.scope)
    : null;

  return (
    <button
      type="button"
      data-testid="consent-entry-row"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative w-full overflow-hidden px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
        selected
          ? "bg-accent-surface"
          : "bg-transparent hover:bg-[color:var(--app-card-surface-compact)]/70",
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
          {counterpartSubtitle ? (
            <p className="truncate text-xs text-muted-foreground">
              {counterpartSubtitle}
            </p>
          ) : null}
        </div>
      </div>
      {isIdentifierHistory ? (
        <>
          <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/80">
            {entrySummary(entry)}
          </p>
          {entry.issued_at ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Latest {formatDate(entry.issued_at)}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground/80">
            {entrySummary(entry)}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {scopeLabel ? <span>{scopeLabel}</span> : null}
            {entry.expires_at ? (
              <span>{formatRelative(entry.expires_at)}</span>
            ) : null}
            {entry.issued_at ? (
              <span>{formatDate(entry.issued_at)}</span>
            ) : null}
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
      title="Access history"
      description="See how each type of access changed over time."
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
  const refreshPolicy =
    entry?.metadata?.refresh_policy === "continuous_until_expiry"
      ? "continuous_until_expiry"
      : "snapshot";
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
  const isPendingDecision =
    (entry.kind === "incoming_request" || isConnectionRequestEntry(entry)) &&
    entry.status === "pending";
  const isConnectionDecision =
    isPendingDecision && isConnectionRequestEntry(entry);
  const isMarketplaceDecision =
    isPendingDecision && isMarketplaceConsent(entry.metadata, entry.scope);
  const canChooseDuration =
    isPendingDecision && !isConnectionDecision && !isMarketplaceDecision;
  const requestedDurationDays =
    typeof entry.metadata?.duration_days === "number" ||
    typeof entry.metadata?.duration_days === "string"
      ? entry.metadata.duration_days
      : null;
  const requestedDurationLabel =
    formatDurationHours(requestedDurationHours) ||
    (requestedDurationDays
      ? formatDurationHours(Number(requestedDurationDays) * 24)
      : "");
  const requestDeadline =
    entry.approval_timeout_at || (isPendingDecision ? entry.expires_at : null);
  const detailGroupTitle =
    isConnectionDecision
      ? "Connection request"
      : entry.kind === "active_grant"
      ? "Active access"
      : entry.kind === "history"
        ? "History details"
        : "Request details";
  const detailGroupDescription =
    isConnectionDecision
      ? "Who wants to connect with you and why."
      : entry.kind === "active_grant"
      ? "What is currently shared and when access ends."
      : entry.kind === "history"
        ? "The recorded outcome and how this access changed over time."
        : "What is being requested and when you need to decide.";
  const activityDateLabel =
    entry.kind === "active_grant"
      ? "Granted"
      : entry.kind === "history"
        ? "Recorded"
        : "Requested";
  const detailItems = [
    ["Status", formatStatus(entry.status)],
    [
      "Contact",
      entry.counterpart_email ||
        entry.counterpart_secondary_label ||
        resolveCounterpartLabel(entry),
    ],
    [
      isConnectionDecision ? "Relationship" : "Access",
      isConnectionDecision
        ? entry.scope_description || "Trusted connection"
        : entry.scope_description ||
          (entry.scope ? humanizeConsentScope(entry.scope) : "Not provided"),
    ],
    [activityDateLabel, formatDate(entry.issued_at) || "Unavailable"],
    isPendingDecision && requestDeadline
      ? [
          "Decision due",
          formatDate(requestDeadline) ||
            formatRelative(requestDeadline) ||
            "Unavailable",
        ]
      : null,
    entry.kind === "active_grant"
      ? [
          "Ends",
          formatDate(entry.expires_at) ||
            formatRelative(entry.expires_at) ||
            "Expiry unavailable",
        ]
      : null,
    entry.kind === "history" && entry.expires_at
      ? [
          "Ended",
          formatDate(entry.expires_at) ||
            formatRelative(entry.expires_at) ||
            "Unavailable",
        ]
      : null,
    isPendingDecision && !isConnectionDecision && requestedDurationLabel
      ? [
          "Requested duration",
          requestedDurationLabel,
        ]
      : null,
    entry.reason ? ["Reason", entry.reason] : null,
  ].filter((item): item is [string, string] => Boolean(item));

  return (
    <div className="space-y-4">
      <SettingsGroup
        embedded
        title={detailGroupTitle}
        description={detailGroupDescription}
      >
        <div className="grid gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)] sm:grid-cols-2">
          {detailItems.map(([label, value]) => (
            <div key={label} className="min-w-0 space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {label}
              </div>
              <div className="text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                {value}
              </div>
            </div>
          ))}
        </div>
      </SettingsGroup>

      {isPendingDecision ? (
        <SettingsGroup
          embedded
          title="Your decision"
          description={
            isConnectionDecision
              ? "Accept or decline this trusted-connection request."
              : isMarketplaceDecision
                ? "Allow or deny delivery of the requested encrypted summary."
                : "Choose the access duration, then allow or reject the request."
          }
        >
          {canChooseDuration ? (
            <SettingsRow
              title="Access duration"
              description={
                approvedDurationLabel
                  ? `Access will end after ${approvedDurationLabel}.`
                  : "Choose how long this access should stay active."
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
          ) : null}
          {canChooseDuration && entry.scope?.startsWith("attr.") ? (
            <SettingsRow
              title="Future updates"
              description={
                refreshPolicy === "continuous_until_expiry"
                  ? "Keep the approved information up to date until access ends."
                  : "Share only the information approved now. Later changes are not shared automatically."
              }
              trailing={
                <span className="text-sm font-semibold text-foreground">
                  {refreshPolicy === "continuous_until_expiry"
                    ? "Keep updated"
                    : "One-time copy"}
                </span>
              }
              stackTrailingOnMobile
            />
          ) : null}
          <SettingsRow
            title={
              isConnectionDecision
                ? "Accept this connection?"
                : isMarketplaceDecision
                  ? "Share this summary?"
                  : "Allow this request?"
            }
            description={
              isConnectionDecision
                ? "Accept to create a mutual trusted connection, or decline."
                : isMarketplaceDecision
                  ? requestedDurationLabel
                    ? `Allow encrypted access for ${requestedDurationLabel}, or don't allow it.`
                    : "Allow encrypted access to the requested summary, or don't allow it."
                  : approvedDurationLabel
                ? `Allow access for ${approvedDurationLabel}, or don't allow it.`
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
                    onApprove(
                      entry,
                      canChooseDuration
                        ? parseDurationHours(selectedDuration)
                        : undefined,
                    )
                  }
                  data-voice-control-id="consent_approve"
                >
                  {approveBusy
                    ? isConnectionDecision
                      ? "Accepting..."
                      : "Allowing..."
                    : isConnectionDecision
                      ? "Accept"
                      : "Allow"}
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  disabled={requestBusy}
                  onClick={() => onDeny(entry)}
                  data-voice-control-id="consent_deny"
                >
                  {denyBusy
                    ? isConnectionDecision
                      ? "Declining..."
                      : "Rejecting..."
                    : isConnectionDecision
                      ? "Decline"
                      : "Don't allow"}
                </Button>
              </div>
            }
            stackTrailingOnMobile
          />
        </SettingsGroup>
      ) : null}

      {entry.kind === "active_grant" && entry.scope ? (
        <SettingsGroup
          embedded
          title="Manage access"
          description="Stop future access without removing the activity record."
        >
          <SettingsRow
            title="Stop sharing"
            description="Revoke this access now. The change remains visible in History."
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
        </SettingsGroup>
      ) : null}

      {emailHelperHref || locationHref || entry.request_url || requestRoute ? (
        <SettingsGroup
          embedded
          title="Related workspace"
          description="Open the app or source connected to this consent."
        >
          {emailHelperHref ? (
            <SettingsRow
              title="Email reply"
              description="Review the request and draft reply in Email."
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
              description="Review this request or access in Location."
              trailing={
                <Button asChild variant="none" effect="fade" size="sm">
                  <Link href={locationHref}>Open Location</Link>
                </Button>
              }
            />
          ) : null}
          {entry.request_url ? (
          <SettingsRow
            title="Original request"
            description="Go back to where this request started."
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
              title="Client workspace"
              description="Review this client's access and connected accounts."
              trailing={
                <Button asChild variant="none" effect="fade" size="sm">
                  <Link href={requestRoute}>Open client</Link>
                </Button>
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {hasGroupedHistory ? (
        <ConsentHistoryLifecycleDetails
          entry={entry}
          onRevokeScope={onRevokeScope}
          activeAction={activeAction}
          isScopeBusy={isScopeBusy}
        />
      ) : null}

      {entry.kind === "history" &&
      !hasGroupedHistory &&
      entry.consent_chain &&
      entry.consent_chain.length > 1 ? (
        <SettingsGroup
          embedded
          title="Recent changes"
          description="The latest changes to this type of access."
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

      {/* Consent handshake timeline (Issue #122). Active Access entries cover
          a single live grant, so the full historical trail (grants, denials,
          revocations across time) belongs on the History tab, not here -
          showing it in Active Access read as a duplicate/unrelated "history
          trail" attached to a currently active item. */}
      {!hasGroupedHistory &&
      entry.kind === "history" &&
      entry.counterpart_id &&
      entry.counterpart_type !== "self" ? (
        <SettingsGroup
          embedded
          title="Access timeline"
          description="How access changed with this connection."
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
  const { getVaultOwnerToken, isVaultUnlocked, vaultKey } = useVault();
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
  const apiActor: ConsentCenterActor | undefined = riaOutgoingCompatibilityRoute
    ? "ria"
    : undefined;
  const consentScopeKey = apiActor === "ria" ? "ria" : "one";
  const mode: ConsentManagerMode = "consents";
  const tab = resolveConsentTab(searchParams);
  const localConsentPreview = isLocalConsentPreviewRuntime();
  const managerView: "incoming" | "outgoing" = riaOutgoingCompatibilityRoute
    ? "outgoing"
    : "incoming";
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const selectedId =
    searchParams.get("requestId") || searchParams.get("selected");
  // Bundle deep links (KYC/RIA emails and backend consent URLs carry bundleId
  // without a requestId). Used as a selection fallback below.
  const selectedBundleId = searchParams.get("bundleId");
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
  const isPanelOpen =
    Boolean(selectedId || selectedBundleId) && !panelCloseRequested;
  const routeQuery = searchParams.get("q") || "";
  const [searchValue, setSearchValue] = useState(routeQuery);
  const deferredQuery = useDeferredValue(searchValue.trim());
  const [mutationTick, setMutationTick] = useState(0);
  const retryConsentCenter = () => {
    setMutationTick((value) => value + 1);
  };
  const summaryCacheKey = user?.uid
    ? `${CACHE_KEYS.CONSENT_CENTER_SUMMARY(
        user.uid,
        `${consentScopeKey}:${mode}`,
      )}${localConsentPreview ? ":local-preview" : ""}`
    : "consent_center_summary_guest";
  const listSurface =
    tab === "requests" ? "pending" : tab === "history" ? "previous" : "active";
  const listCacheKey = user?.uid
    ? `${CACHE_KEYS.CONSENT_CENTER_LIST(
        user.uid,
        `${consentScopeKey}:${mode}`,
        listSurface,
        deferredQuery,
        page,
        CONSENT_CENTER_PAGE_SIZE,
      )}${localConsentPreview ? ":local-preview" : ""}`
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
    if (routeQuery !== searchValue) {
      setSearchValue(routeQuery);
    }
    // searchValue is intentionally omitted: local input should not be reset
    // while its deferred URL update is still pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeQuery]);

  useEffect(() => {
    if (!syncLocalConsentPreviewSession()) return;
    if (searchParams.get("preview") === "consent") return;
    const next = new URLSearchParams(searchParams.toString());
    next.set("preview", "consent");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

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

  // Fulfil agent-driven marketplace approvals. Agent One (A2A) and the
  // marketplace chat agent can only flip a request to `approved` server-side —
  // they have no browser/vault key to seal the encrypted slice, so the seller's
  // device must complete delivery. The unlock-warm sweep runs at most once per
  // session and usually fires before the agent approval exists, leaving slices
  // approved-but-undelivered. Opening the Consent Guardian is exactly when the
  // seller is present with an unlocked vault, so we sweep again here (guard-free
  // relative to unlock-warm, once per mount) to seal + deliver those requests.
  const marketplaceSweptRef = useRef(false);
  useEffect(() => {
    if (localConsentPreview) return;
    if (marketplaceSweptRef.current) return;
    if (!isVaultUnlocked || !user?.uid || !vaultKey) return;
    const vaultOwnerToken = getVaultOwnerToken();
    if (!vaultOwnerToken) return;
    marketplaceSweptRef.current = true;
    void runMarketplaceDeliverySweep({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .then((result) => {
        // Refresh the lists so freshly delivered grants reflect their new state.
        if (result.delivered > 0) {
          setMutationTick((value) => value + 1);
        }
      })
      .catch((error) => {
        console.warn(
          "[ConsentCenter] marketplace delivery sweep failed:",
          error,
        );
      });
  }, [
    getVaultOwnerToken,
    isVaultUnlocked,
    localConsentPreview,
    user?.uid,
    vaultKey,
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

  // Information Marketplace rows are end-to-end encrypted slice deliveries and
  // must go through the dedicated marketplace approve endpoint + envelope publish
  // (build safe-summary export -> seal to the buyer's recipient key -> post
  // ciphertext only), NOT the generic developer-consent flow. See
  // lib/consent/use-marketplace-consent-actions.ts.
  const {
    handleApprove: handleMarketplaceApprove,
    handleDeny: handleMarketplaceDeny,
    handleRevoke: handleMarketplaceRevoke,
    activeAction: marketplaceActiveAction,
    isRequestBusy: isMarketplaceRequestBusy,
    isScopeBusy: isMarketplaceScopeBusy,
  } = useMarketplaceConsentActions({
    userId: user?.uid,
  });

  const activeAction =
    genericActiveAction ?? locationActiveAction ?? marketplaceActiveAction;
  const isRequestBusy = useCallback(
    (requestId?: string | null) =>
      isGenericRequestBusy(requestId) ||
      isLocationRequestBusy(requestId) ||
      isMarketplaceRequestBusy(requestId),
    [isGenericRequestBusy, isLocationRequestBusy, isMarketplaceRequestBusy],
  );
  const isScopeBusy = useCallback(
    (scope?: string | null) =>
      isGenericScopeBusy(scope) ||
      isLocationScopeBusy(scope) ||
      isMarketplaceScopeBusy(scope),
    [isGenericScopeBusy, isLocationScopeBusy, isMarketplaceScopeBusy],
  );

  // Route a consent entry to the correct backend pipeline. Location rows
  // (`metadata.request_source` starts with `one_location`, or a location-family
  // scope) use the One Location hook; everything else uses the generic flow.
  const isLocationEntry = useCallback(
    (entry: ConsentCenterEntry) =>
      isLocationConsent(entry.metadata, entry.scope),
    [],
  );
  const isMarketplaceEntry = useCallback(
    (entry: ConsentCenterEntry) =>
      isMarketplaceConsent(entry.metadata, entry.scope),
    [],
  );
  const applyPreviewAction = useCallback(
    async (
      action: "approve" | "deny" | "revoke",
      entry: ConsentCenterEntry,
      durationHours?: number,
    ) => {
      if (!localConsentPreview) return;
      const previewModule = await loadLocalConsentPreviewModule();
      if (!previewModule) return;
      const { applyLocalConsentPreviewMutation } = previewModule;
      const detail = applyLocalConsentPreviewMutation({
        action,
        entry,
        durationHours,
      });
      window.dispatchEvent(
        new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail }),
      );
    },
    [localConsentPreview],
  );
  const approveEntry = useCallback(
    (entry: ConsentCenterEntry, durationHours?: number) => {
      if (localConsentPreview) {
        void applyPreviewAction("approve", entry, durationHours);
        return;
      }
      if (isConnectionRequestEntry(entry)) {
        void (async () => {
          if (!user) return;
          try {
            const idToken = await user.getIdToken();
            await ConnectionsService.accept({
              idToken,
              requestId: entry.request_id || entry.id,
            });
            CacheSyncService.onConsentMutated(user.uid);
            window.dispatchEvent(
              new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT),
            );
          } catch (error) {
            console.error(
              "[ConsentCenter] Couldn't accept the connection request:",
              error,
            );
          }
        })();
        return;
      }
      if (isLocationEntry(entry)) {
        void handleLocationApprove(entry, durationHours);
        return;
      }
      if (isMarketplaceEntry(entry)) {
        void handleMarketplaceApprove(entry);
        return;
      }
      void handleApprove(toPendingConsent(entry, durationHours));
    },
    [
      applyPreviewAction,
      handleApprove,
      handleLocationApprove,
      handleMarketplaceApprove,
      isLocationEntry,
      isMarketplaceEntry,
      localConsentPreview,
      user,
    ],
  );
  const denyEntry = useCallback(
    (entry: ConsentCenterEntry) => {
      if (localConsentPreview) {
        void applyPreviewAction("deny", entry);
        return;
      }
      if (isConnectionRequestEntry(entry)) {
        void (async () => {
          if (!user) return;
          try {
            const idToken = await user.getIdToken();
            await ConnectionsService.reject({
              idToken,
              requestId: entry.request_id || entry.id,
            });
            CacheSyncService.onConsentMutated(user.uid);
            window.dispatchEvent(
              new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT),
            );
          } catch (error) {
            console.error(
              "[ConsentCenter] Couldn't decline the connection request:",
              error,
            );
          }
        })();
        return;
      }
      if (isLocationEntry(entry)) {
        void handleLocationDeny(entry);
        return;
      }
      if (isMarketplaceEntry(entry)) {
        void handleMarketplaceDeny(entry);
        return;
      }
      void handleDeny(entry.request_id || entry.id);
    },
    [
      applyPreviewAction,
      handleDeny,
      handleLocationDeny,
      handleMarketplaceDeny,
      isLocationEntry,
      isMarketplaceEntry,
      localConsentPreview,
      user,
    ],
  );
  const revokeEntry = useCallback(
    (entry: ConsentCenterEntry) => {
      if (localConsentPreview) {
        void applyPreviewAction("revoke", entry);
        return;
      }
      if (isLocationEntry(entry)) {
        void handleLocationRevoke(entry);
        return;
      }
      if (isMarketplaceEntry(entry)) {
        void handleMarketplaceRevoke(entry);
        return;
      }
      if (!entry.scope) return;
      void handleRevoke(entry.scope);
    },
    [
      applyPreviewAction,
      handleLocationRevoke,
      handleMarketplaceRevoke,
      handleRevoke,
      isLocationEntry,
      isMarketplaceEntry,
      localConsentPreview,
    ],
  );
  const revokeScope = useCallback(
    (scope: string) => {
      if (localConsentPreview) {
        void loadLocalConsentPreviewModule().then((previewModule) => {
          if (previewModule) {
            const { revokeLocalConsentPreviewScope } = previewModule;
            const detail = revokeLocalConsentPreviewScope(scope);
            window.dispatchEvent(
              new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, { detail }),
            );
          }
        });
        return;
      }
      void handleRevoke(scope);
    },
    [handleRevoke, localConsentPreview],
  );

  const idTokenLoader = async () => user?.getIdToken();

  const summaryResource = useStaleResource({
    cacheKey: summaryCacheKey,
    refreshKey: `${consentScopeKey}:${mode}`,
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
        force: Boolean(options?.force),
      });
    },
  });

  const centerResource = useStaleResource({
    cacheKey: user?.uid
      ? CACHE_KEYS.CONSENT_CENTER(user.uid, `${actor}:${managerView}`)
      : "consent_center_guest",
    refreshKey: `${actor}:${managerView}`,
    enabled: Boolean(user?.uid && tab === "connections"),
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
        force: Boolean(options?.force),
      });
    },
  });

  const listResource = useStaleResource({
    cacheKey: listCacheKey,
    refreshKey: `${consentScopeKey}:${mode}:${listSurface}:${deferredQuery}:${page}`,
    enabled: Boolean(user?.uid && tab !== "connections"),
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
        force: Boolean(options?.force),
      });
    },
  });
  const currentListResourceData =
    listResource.data?.surface === listSurface &&
    listResource.data.query === deferredQuery &&
    listResource.data.page === page &&
    listResource.data.limit === CONSENT_CENTER_PAGE_SIZE
      ? listResource.data
      : null;
  const forcedMutationRefreshRef = useRef(0);

  useEffect(() => {
    if (!mutationTick) return;
    if (forcedMutationRefreshRef.current === mutationTick) return;
    forcedMutationRefreshRef.current = mutationTick;

    void summaryResource.refresh({ force: true });
    if (tab === "connections") {
      void centerResource.refresh({ force: true });
    } else {
      void listResource.refresh({ force: true });
    }
  }, [centerResource, listResource, mutationTick, summaryResource, tab]);

  useEffect(() => {
    if (summaryResource.data) {
      setRetainedSummary({ key: summaryCacheKey, data: summaryResource.data });
    }
  }, [summaryCacheKey, summaryResource.data]);

  useEffect(() => {
    if (currentListResourceData) {
      setRetainedList({ key: listCacheKey, data: currentListResourceData });
    }
  }, [currentListResourceData, listCacheKey]);
  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === summaryCacheKey ? retainedSummary.data : null);
  const listData =
    currentListResourceData ??
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
            : (summaryData ?? null);
        if (!base) return current;
        return {
          key: summaryCacheKey,
          data: applyConsentMutationToSummary(base, normalizedDetail),
        };
      });

      setRetainedList((current) => {
        const base =
          current?.key === listCacheKey ? current.data : (listData ?? null);
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
        (
          event as CustomEvent<
            Partial<ConsentMutationDetail> & { reconcile?: boolean }
          >
        ).detail || {};
      applyConfirmedConsentMutation(detail);
      // CONSENT_STATE_CHANGED_EVENT is also dispatched for non-mutation
      // bookkeeping (e.g. "fcm_opened" when a request is merely opened/
      // acknowledged, "queued_pending"/"cached_pending"/"hydrated_pending"
      // on vault unlock). Those carry no `action`, but selecting any pending
      // or active row calls acknowledgePendingConsent() -> POST /pending/
      // opened -> the backend inserts a NOTIFICATION_OPENED audit event,
      // which echoes back over this same user's SSE/FCM channel as an
      // "fcm_opened" state-changed event. Forcing a full list+summary
      // refresh on that self-echo made every row click on Requests/Active
      // (both surfaces list still-pending/live rows) visibly re-render with
      // a "Refreshing..." flash. History rows are already resolved
      // (status != REQUESTED) so the backend never inserts that event and
      // never echoes back, which is why History never flickered. Only force
      // a refresh for detail.action-bearing events (approve/deny/revoke/
      // cancel), which are real state mutations.
      if (!detail.action && !detail.reconcile) return;
      setMutationTick((value) => value + 1);
    };
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, handleAction);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, handleAction);
    };
  }, [applyConfirmedConsentMutation]);

  const connectionItems = useMemo(
    () =>
      filterConnectionEntries(
        buildConnectionEntries(centerResource.data || null),
        deferredQuery,
      ),
    [centerResource.data, deferredQuery],
  );
  const items = useMemo(() => {
    const source =
      tab === "connections" ? connectionItems : listData?.items || [];
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
  }, [
    listData?.items,
    locallyHandledRequestIds,
    locallyRevokedScopes,
    listSurface,
    connectionItems,
    tab,
  ]);
  const selectedEntryFromList = useMemo(() => {
    if (!items.length) return null;
    if (selectedId) {
      return (
        items.find((item) => consentEntryMatchesSelectedId(item, selectedId)) ??
        null
      );
    }
    // Bundle deep links carry bundleId without a requestId: select the
    // matching bundle entry so backend-generated bundle URLs land somewhere.
    if (selectedBundleId) {
      return (
        items.find((item) =>
          consentEntryMatchesBundleId(item, selectedBundleId),
        ) ?? null
      );
    }
    // No selectedId/selectedBundleId in the URL means no entry is actually
    // selected (the detail panel is closed - see isPanelOpen). Falling back
    // to items[0] here made the FIRST row of every tab render as visually
    // "selected" (accent border/surface) on every render, including right
    // after switching tabs, with no click and no open panel. Because items
    // differ per tab, the highlighted row appeared to jump/flicker to a
    // different, unclicked entry every time the tab changed - the reported
    // "acting funny" when switching from History to Active.
    return null;
  }, [items, selectedBundleId, selectedId]);
  const shouldLookupSelectedPending = Boolean(
    user?.uid && selectedId && tab === "requests" && !selectedEntryFromList,
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
    tab === "connections" ? centerResource.error : listResource.error;
  const activeListLoading =
    tab === "connections" ? centerResource.loading : listResource.loading;
  const activeListRefreshing =
    tab === "connections" ? centerResource.refreshing : listResource.refreshing;
  const consentLoadError = activeListError || summaryResource.error;
  const isAuthLoadError = isAuthConsentLoadError(consentLoadError);
  const hasVisibleConsentListData =
    items.length > 0 ||
    (tab === "connections" ? Boolean(centerResource.data) : Boolean(listData));
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
    tab === "connections" ? centerResource.snapshot : listResource.snapshot;
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
    selectedPendingLookupResource.data?.missing_request_ids?.includes(
      selectedId,
    ),
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
      selectedPendingLookupResource.error?.toLowerCase().includes("unlock")),
  );
  const selectedPendingConsent = useMemo(
    () => (selectedEntry ? toPendingConsent(selectedEntry) : null),
    [selectedEntry],
  );
  const listMismatchRetryRef = useRef<string | null>(null);

  useEffect(() => {
    if (tab === "connections") return;
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

  // IMPORTANT: this must depend on the current searchParams/pathname/
  // riaOutgoingCompatibilityRoute so every caller always mutates the CURRENT
  // URL, never a stale snapshot from an earlier render. (A previous version
  // of closeDetailPanel captured this function once via useCallback([]) and
  // replayed page-load-time searchParams forever, which reset the active
  // tab to "requests" every time the detail panel closed - see below.)
  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
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
    },
    [pathname, riaOutgoingCompatibilityRoute, router, searchParams],
  );

  // Close the detail panel instantly, then clear its URL params in a transition
  // so the route navigation never blocks the panel's close animation. Only the
  // panel-specific params are cleared; tab/page/q/actor/view are untouched, so
  // closing never changes which tab you are viewing.
  const closeDetailPanel = useCallback(() => {
    setPanelCloseRequested(true);
    startPanelUrlSync(() => {
      setParam({
        requestId: null,
        selected: null,
        bundleId: null,
        notificationAction: null,
      });
    });
  }, [setParam, startPanelUrlSync]);

  useEffect(() => {
    if (deferredQuery === routeQuery.trim()) return;
    setParam({
      q: deferredQuery || null,
      page: "1",
      requestId: null,
      selected: null,
    });
  }, [deferredQuery, routeQuery, setParam]);

  // When the selected request changes (deep link, list selection, or after the
  // URL finishes clearing), drop the local close override so the panel can open
  // again and stays in sync with the URL.
  useEffect(() => {
    setPanelCloseRequested(false);
  }, [selectedId, selectedBundleId]);

  const pageDescription =
    managerView === "outgoing" && tab === "requests"
      ? "Review access requests you sent and see what still needs a response."
      : tab === "requests"
        ? "Decide who can access specific information and for how long."
        : tab === "active"
          ? "Review current access and stop sharing when it is no longer needed."
          : tab === "history"
            ? "See what was allowed, denied, expired, cancelled, or revoked."
            : "Review the people and services connected to your private agent.";
  const searchPlaceholder =
    tab === "requests"
      ? "Search requests"
      : tab === "active"
        ? "Search active access"
        : tab === "history"
          ? "Search history"
          : "Search connections";
  const emptyListMessage = deferredQuery
    ? `No ${tab === "active" ? "active access" : tab} matches “${deferredQuery}”.`
    : tab === "requests"
      ? "No requests need your review."
      : tab === "active"
        ? "No one currently has active access."
        : tab === "history"
          ? "No consent activity has been recorded yet."
          : "No connections are available yet.";
  const loadingListMessage =
    tab === "requests"
      ? "Loading requests…"
      : tab === "active"
        ? "Loading active access…"
        : tab === "history"
          ? "Loading history…"
          : "Loading connections…";
  return (
    <AppPageShell as="main" width="reading" className="pb-24 sm:pb-28">
      {!localConsentPreview ? (
        <CapabilityExploreCard capabilityId="consent" />
      ) : null}
      <AppPageHeaderRegion>
        <PageHeader
          title="Consent Center"
          description={pageDescription}
          accent="consent"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SurfaceStack>
          {localConsentPreview ? (
            <div
              role="status"
              data-testid="consent-preview-banner"
              className="flex flex-col gap-3 rounded-[var(--app-card-radius-compact)] border border-accent-border bg-accent-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  Layout preview
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Showing deterministic sample consents. Changes stay in this
                  browser tab and never reach the backend.
                </p>
              </div>
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                className="self-start sm:self-auto"
                onClick={() =>
                  setParam({
                    preview: "live",
                    requestId: null,
                    selected: null,
                    page: "1",
                  })
                }
              >
                Use live data
              </Button>
            </div>
          ) : null}
          <section className="space-y-4" data-testid="consent-manager-primary">
            <section data-testid="consent-manager-list">
              <SettingsGroup embedded>
                <div className="flex items-center gap-2 border-b border-[color:var(--app-card-border-standard)]/45 px-3 py-3">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      value={searchValue}
                      onChange={(event) => {
                        setSearchValue(event.target.value);
                      }}
                      aria-label={searchPlaceholder}
                      placeholder={searchPlaceholder}
                      className="pl-9"
                      data-voice-control-id="consent_search"
                    />
                  </div>
                  {visibleSnapshot && activeListError && items.length > 0 ? (
                    <div className="hidden sm:block">
                      <StaleCacheTimestamp
                        updatedAt={visibleSnapshot.timestamp}
                        stale
                      />
                    </div>
                  ) : null}
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
                        "h-4 w-4 sm:mr-2",
                        isConsentActionRefreshing && "animate-spin",
                      )}
                    />
                    <span className="hidden sm:inline">Refresh</span>
                  </Button>
                </div>

                <div className="divide-y divide-[color:var(--app-card-border-standard)]/45">
                  <AccessibilityStatusAnnouncer
                    message={accessibilityStatusMessage}
                  />

                  {showSessionRecovery ? <SessionExpiryRecovery /> : null}

                  {showCompactRetryState ? (
                    <div className="p-3">
                      <ApiRetryState
                        variant="compact"
                        title="Showing the last available information"
                        description="The latest refresh did not finish. You can keep reviewing this list or try again."
                        onRetry={retryConsentCenter}
                        showRetryAction={false}
                      />
                    </div>
                  ) : null}

                  {showFullRetryState && !showSessionRecovery ? (
                    <div className="p-3">
                      <ApiRetryState
                        title="Consent Center is temporarily unavailable"
                        description="We could not load the latest access information. Try refreshing in a moment."
                        onRetry={retryConsentCenter}
                        showRetryAction={false}
                      />
                    </div>
                  ) : null}

                  {(tab === "connections"
                    ? centerResource.loading
                    : listResource.loading) &&
                  items.length === 0 &&
                  !showFullRetryState ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      {loadingListMessage}
                    </div>
                  ) : null}
                  {(tab === "connections"
                    ? !centerResource.loading
                    : !listResource.loading) &&
                  !showFullRetryState &&
                  items.length === 0 ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      {emptyListMessage}
                    </div>
                  ) : null}
                  {items.map((entry) => (
                    <ConsentEntryRow
                      key={`${entry.kind}-${entry.id}-${entry.request_id || "no-request"}`}
                      entry={entry}
                      selected={
                        Boolean(
                          selectedEntry &&
                          (selectedEntry.id === entry.id ||
                            (selectedEntry.request_id &&
                              selectedEntry.request_id === entry.request_id)),
                        ) ||
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

                {tab !== "connections" && listData ? (
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
            ? selectedEntry.kind === "active_grant"
              ? "Active access"
              : selectedEntry.kind === "history"
                ? `${formatStatus(selectedEntry.status)} access`
                : selectedEntry.status === "pending"
                  ? "Request awaiting your decision"
                  : `${formatStatus(selectedEntry.status)} request`
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
                        closeDetailPanel();
                        approveEntry(selectedEntry);
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
                        closeDetailPanel();
                        denyEntry(selectedEntry);
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
            description="We’re loading the consent request from this link."
          >
            {selectedRequestResolving ? (
              <SettingsRow
                title="Loading request"
                description="Fetching the latest details."
              />
            ) : selectedRequestNeedsUnlock ? (
              <SettingsRow
                title="Unlock vault to review"
                description="Unlock your vault to load this request securely."
              />
            ) : selectedPendingLookupResource.error ? (
              <SettingsRow
                title="Could not load request"
                description="Refresh the list and try opening the request again."
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
                description="Refresh the list or check History if the request was already handled."
              />
            )}
          </SettingsGroup>
        ) : (
          <ConsentEntryDetail
            actor={actor}
            entry={selectedEntry}
            onApprove={(entry, durationHours) => {
              // Dismiss the panel immediately; the list already optimistically
              // removes the row and any failure surfaces via toast.
              closeDetailPanel();
              approveEntry(entry, durationHours);
            }}
            onDeny={(entry) => {
              closeDetailPanel();
              denyEntry(entry);
            }}
            onRevoke={(entry) => {
              revokeEntry(entry);
            }}

            onRevokeScope={revokeScope}
            activeAction={activeAction}
            isRequestBusy={isRequestBusy}
            isScopeBusy={isScopeBusy}
          />
        )}
      </SettingsDetailPanel>
    </AppPageShell>
  );
}

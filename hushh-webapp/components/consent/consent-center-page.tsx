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
  Code2,
  ExternalLink,
  Landmark,
  RefreshCcw,
  Search,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PaginatedListFooter } from "@/components/app-ui/paginated-list-footer";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { AccessibilityStatusAnnouncer } from "@/components/system/accessibility-status-announcer";
import { ApiRetryState } from "@/components/system/api-retry-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  isCircleMemberInviteConsent,
  isLocationConsent,
  locationConsentSummary,
  locationConsentWorkflowHref,
} from "@/lib/consent/location-consent";
import { isMarketplaceConsent } from "@/lib/consent/marketplace-consent";
import {
  isInternalAppHref,
  normalizeInternalAppHref,
} from "@/lib/consent/consent-sheet-route";
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
import {
  buildConsentCenterTabRoute,
  TOP_SHELL_TAB_REGISTRY,
} from "@/lib/navigation/top-shell-tabs";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
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
type ConnectionScopeProposalPresentation = {
  scopeHandle: string;
  direction: "requested" | "offered";
  label: string;
  description: string;
  status: string;
};

function connectionScopeProposals(
  entry: ConsentCenterEntry | null,
): ConnectionScopeProposalPresentation[] {
  const raw = entry?.metadata?.scope_proposals;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const proposal = item as Partial<ConnectionScopeProposalPresentation>;
    if (
      typeof proposal.scopeHandle !== "string" ||
      (proposal.direction !== "requested" && proposal.direction !== "offered")
    ) {
      return [];
    }
    return [
      {
        scopeHandle: proposal.scopeHandle,
        direction: proposal.direction,
        label:
          typeof proposal.label === "string"
            ? proposal.label
            : "Connection capability",
        description:
          typeof proposal.description === "string" ? proposal.description : "",
        status:
          typeof proposal.status === "string" ? proposal.status : "pending",
      },
    ];
  });
}

const DURATION_OPTIONS = [
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "2160", label: "90 days" },
];
const LOCATION_DURATION_OPTIONS = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
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
  if (hours < 1) {
    const minutes = hours * 60;
    if (Number.isInteger(minutes)) {
      return `${minutes} min`;
    }
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function durationOptionsFor(requestedDurationHours?: number | string | null) {
  const maxHours = Number(requestedDurationHours);
  if (!Number.isFinite(maxHours) || maxHours <= 0) return [];
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

function locationDurationOptionsFor(
  requestedDurationHours?: number | string | null,
) {
  const maxHours = Number(requestedDurationHours);
  if (!Number.isFinite(maxHours) || maxHours <= 0) {
    return LOCATION_DURATION_OPTIONS;
  }
  const options = LOCATION_DURATION_OPTIONS.filter(
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

function isConsentCenterHref(href?: string | null) {
  if (!href) return false;
  return href === ROUTES.CONSENTS || href.startsWith(`${ROUTES.CONSENTS}?`);
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

function filterConsentSurfaceEntries(
  source: ConsentCenterEntry[],
  surface: "pending" | "active" | "previous" | "connections",
  locallyHandledRequestIds: Set<string>,
  locallyRevokedScopes: Set<string>,
): ConsentCenterEntry[] {
  // Both of these surfaces list requests that are still open, so a row the
  // user just answered has to disappear from either one. Keying this on
  // "pending" alone kept an accepted connection request on screen, because
  // connections are a separate surface with their own tab.
  const listsOpenRequests = surface === "pending" || surface === "connections";
  return source.filter((entry) => {
    if (
      listsOpenRequests &&
      entry.request_id &&
      locallyHandledRequestIds.has(entry.request_id)
    ) {
      return false;
    }
    if (listsOpenRequests && locallyHandledRequestIds.has(entry.id)) {
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

function buildConnectionEntries(
  center: ConsentCenterResponse | null,
): ConsentCenterEntry[] {
  if (!center) return [];
  // Relationship metadata and ordinary consent rows must never become a
  // connection review. The backend returns only explicit proposal envelopes.
  return [...(center.connection_requests || [])].sort(
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
  const Icon =
    kind === "ria" ? Landmark : kind === "developer" ? Code2 : UserRound;
  const label = resolveCounterpartLabel(entry);
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
  const identityTone =
    kind === "ria"
      ? "border-accent-border bg-accent-surface text-accent-strong"
      : kind === "developer"
        ? "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:border-sky-300/20 dark:bg-sky-300/10 dark:text-sky-200"
        : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-200";

  return (
    <Avatar
      size="lg"
      className={cn(
        "h-10 w-10 rounded-[14px] border shadow-[0_1px_0_rgba(255,255,255,0.35)_inset]",
        identityTone,
      )}
    >
      <AvatarImage src={entry.counterpart_image_url || undefined} alt="" />
      <AvatarFallback className="rounded-[13px] bg-transparent text-current">
        <span className="relative flex h-full w-full items-center justify-center">
          <Icon className="h-[18px] w-[18px] opacity-80" aria-hidden="true" />
          {initials ? (
            <span className="absolute bottom-0.5 right-0.5 rounded-md bg-[color:var(--app-card-surface-default-solid)] px-1 text-[9px] font-semibold leading-4 text-foreground shadow-sm">
              {initials}
            </span>
          ) : null}
        </span>
      </AvatarFallback>
    </Avatar>
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
  const supportingCopy = isIdentifierHistory
    ? entrySummary(entry)
    : scopeLabel || entrySummary(entry);

  return (
    <SettingsRow
      data-testid="consent-entry-row"
      onClick={onSelect}
      leading={<ConsentCounterpartAvatar entry={entry} />}
      title={resolveCounterpartLabel(entry)}
      description={
        <span className="line-clamp-2">
          <span>{supportingCopy}</span>
          {counterpartSubtitle ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{counterpartSubtitle}</span>
            </>
          ) : null}
        </span>
      }
      trailing={
        <Badge
          className={cn("shrink-0 capitalize", badgeClassName(entry.status))}
        >
          {formatStatus(entry.status)}
        </Badge>
      }
      className={selected ? "bg-accent-surface" : undefined}
    />
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
      <div className="divide-y divide-[color:var(--app-card-border-standard)]/45 px-[var(--settings-row-px)]">
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
              className="py-[var(--settings-row-py)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
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
                        ? "Stopping..."
                        : "Stop active access"}
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
  onApprove: (
    entry: ConsentCenterEntry,
    durationHours?: number,
    scopeSelection?: {
      requestedScopeHandles: string[];
      offeredScopeHandles: string[];
    },
  ) => void;
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
  const isLocationEntry = Boolean(
    entry && isLocationConsent(entry.metadata, entry.scope),
  );
  const parsedRequestedDuration = parseDurationHours(
    requestedDurationHours === null ? null : String(requestedDurationHours),
  );
  const defaultDuration = String(
    parsedRequestedDuration || (isLocationEntry ? 1 : ""),
  );
  const [selectedDuration, setSelectedDuration] = useState(defaultDuration);
  useEffect(() => {
    setSelectedDuration(defaultDuration);
  }, [defaultDuration, entry?.id]);
  const proposals = connectionScopeProposals(entry);
  const requestedProposals = proposals.filter(
    (proposal) =>
      proposal.direction === "requested" && proposal.status === "pending",
  );
  const offeredProposals = proposals.filter(
    (proposal) =>
      proposal.direction === "offered" && proposal.status === "pending",
  );
  const [selectedRequestedScopes, setSelectedRequestedScopes] = useState<
    string[]
  >([]);
  const [selectedOfferedScopes, setSelectedOfferedScopes] = useState<string[]>(
    [],
  );
  const requestedProposalKey = requestedProposals
    .map((proposal) => proposal.scopeHandle)
    .sort()
    .join("|");
  useEffect(() => {
    // Information owners' requested scopes are selected by default; offers
    // demand a deliberate recipient opt-in.
    setSelectedRequestedScopes(
      requestedProposalKey ? requestedProposalKey.split("|") : [],
    );
    setSelectedOfferedScopes([]);
  }, [entry?.id, requestedProposalKey]);

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
    actor === "ria" &&
    entry.counterpart_id &&
    entry.allowed_next_action === "open_workspace"
      ? buildRiaClientWorkspaceRoute(entry.counterpart_id, { tab: "access" })
      : null;
  const emailHelperHref = isEmailHelperConsent(entry.metadata)
    ? normalizeInternalAppHref(emailHelperWorkflowHref(entry.metadata))
    : null;
  const locationHref = isLocationEntry
    ? normalizeInternalAppHref(locationConsentWorkflowHref(entry.metadata))
    : null;
  const isCircleMemberInvite = isCircleMemberInviteConsent(entry.metadata);
  const normalizedRequestHref = entry.request_url
    ? normalizeInternalAppHref(entry.request_url) || entry.request_url
    : null;
  const distinctRequestHref =
    normalizedRequestHref &&
    !isConsentCenterHref(normalizedRequestHref) &&
    normalizedRequestHref !== emailHelperHref &&
    normalizedRequestHref !== locationHref
      ? normalizedRequestHref
      : null;
  const relatedWorkspace = emailHelperHref
    ? {
        title: "Email reply",
        description: "Review the request and draft a reply in Email.",
        href: emailHelperHref,
        label: "Open Email",
        external: false,
      }
    : locationHref
      ? {
          title: isCircleMemberInvite ? "Circle invitation" : "Location sharing",
          description: isCircleMemberInvite
            ? "Open Location to review the Circle and choose Join or Decline. This invitation grants no location access."
            : "Review this request or access in Location.",
          href: locationHref,
          label: isCircleMemberInvite ? "Open invitation" : "Open Location",
          external: false,
        }
      : distinctRequestHref
        ? {
            title: "Original request",
            description: "Go back to where this request started.",
            href: distinctRequestHref,
            label: "Open",
            external: !isInternalAppHref(distinctRequestHref),
          }
        : requestRoute
          ? {
              title: "Client workspace",
              description:
                "Review this client's access and connected accounts.",
              href: requestRoute,
              label: "Open client",
              external: false,
            }
          : null;

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
  const allowedNextAction = String(entry.allowed_next_action || "").trim();
  const isPendingKind =
    entry.kind === "incoming_request" || isConnectionRequestEntry(entry);
  const isPendingDecision =
    !isCircleMemberInvite &&
    isPendingKind &&
    (allowedNextAction
      ? allowedNextAction === "review_request"
      : entry.status === "pending");
  const isConnectionDecision =
    isPendingDecision && isConnectionRequestEntry(entry);
  const isMarketplaceDecision =
    isPendingDecision && isMarketplaceConsent(entry.metadata, entry.scope);
  const durationOptions =
    isPendingDecision && !isConnectionDecision && !isMarketplaceDecision
      ? isLocationEntry
        ? locationDurationOptionsFor(requestedDurationHours)
        : durationOptionsFor(requestedDurationHours)
      : [];
  const showDurationChoice = durationOptions.length > 1;
  const effectiveDurationHours =
    isLocationEntry || parsedRequestedDuration
      ? parseDurationHours(selectedDuration)
      : undefined;
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
  const isReceivedLocationGrant =
    isLocationEntry && entry.metadata?.section === "shared";
  const canRevokeActive =
    entry.kind === "active_grant" &&
    Boolean(entry.scope) &&
    !isReceivedLocationGrant &&
    (allowedNextAction
      ? allowedNextAction === "revoke"
      : isRevocableConsentStatus(entry.status));
  const requestDeadline =
    entry.approval_timeout_at || (isPendingDecision ? entry.expires_at : null);
  const activityDateLabel =
    entry.kind === "active_grant"
      ? "Granted"
      : entry.kind === "history"
        ? "Recorded"
        : "Requested";
  const detailItems = [
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
    entry.kind === "active_grant" && entry.expires_at
      ? [
          "Ends",
          formatDate(entry.expires_at) ||
            formatRelative(entry.expires_at) ||
            "Unavailable",
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
    isPendingDecision &&
    !isConnectionDecision &&
    !showDurationChoice &&
    requestedDurationLabel
      ? ["Requested duration", requestedDurationLabel]
      : null,
    entry.is_scope_upgrade && entry.additional_access_summary
      ? ["What changes", entry.additional_access_summary]
      : null,
    entry.reason ? ["Reason", entry.reason] : null,
  ].filter((item): item is [string, string] => Boolean(item));

  return (
    <div className="space-y-4">
      {!hasGroupedHistory ? (
        <dl className="grid gap-x-6 gap-y-4 px-1 py-1 sm:grid-cols-2">
          {detailItems.map(([label, value]) => (
            <div key={label} className="min-w-0 space-y-1">
              <dt className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                {label}
              </dt>
              <dd className="text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {isConnectionDecision && proposals.length > 0 ? (
        <div className="space-y-3">
          {requestedProposals.length > 0 ? (
            <SettingsGroup embedded title="They’re requesting">
              {requestedProposals.map((proposal) => {
                const checked = selectedRequestedScopes.includes(
                  proposal.scopeHandle,
                );
                return (
                  <SettingsRow
                    key={proposal.scopeHandle}
                    title={proposal.label}
                    description={proposal.description}
                    trailing={
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setSelectedRequestedScopes((current) =>
                            next
                              ? Array.from(
                                  new Set([...current, proposal.scopeHandle]),
                                )
                              : current.filter(
                                  (handle) => handle !== proposal.scopeHandle,
                                ),
                          )
                        }
                        aria-label={`Share ${proposal.label}`}
                      />
                    }
                  />
                );
              })}
            </SettingsGroup>
          ) : null}
          {offeredProposals.length > 0 ? (
            <SettingsGroup embedded title="They’ve offered">
              {offeredProposals.map((proposal) => {
                const checked = selectedOfferedScopes.includes(
                  proposal.scopeHandle,
                );
                return (
                  <SettingsRow
                    key={proposal.scopeHandle}
                    title={proposal.label}
                    description={proposal.description}
                    trailing={
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setSelectedOfferedScopes((current) =>
                            next
                              ? Array.from(
                                  new Set([...current, proposal.scopeHandle]),
                                )
                              : current.filter(
                                  (handle) => handle !== proposal.scopeHandle,
                                ),
                          )
                        }
                        aria-label={`Accept ${proposal.label}`}
                      />
                    }
                  />
                );
              })}
            </SettingsGroup>
          ) : null}
        </div>
      ) : null}

      {isPendingDecision ? (
        <section
          className="flex flex-wrap items-center justify-end gap-2 pt-1"
          aria-label="Consent decision"
        >
          {showDurationChoice ? (
            <div className="min-w-[150px]">
              <Select
                value={selectedDuration}
                onValueChange={setSelectedDuration}
                disabled={requestBusy}
              >
                <SelectTrigger
                  className="w-[150px]"
                  aria-label="Access duration"
                >
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
            </div>
          ) : null}
          <Button
            variant="blue-gradient"
            effect="fill"
            size="sm"
            className="min-h-11"
            disabled={requestBusy}
            onClick={() =>
              onApprove(
                entry,
                isConnectionDecision || isMarketplaceDecision
                  ? undefined
                  : effectiveDurationHours,
                isConnectionDecision
                  ? {
                      requestedScopeHandles: selectedRequestedScopes,
                      offeredScopeHandles: selectedOfferedScopes,
                    }
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
            className="min-h-11"
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
        </section>
      ) : null}

      {canRevokeActive ? (
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
                {revokeBusy ? "Stopping..." : "Stop sharing"}
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}

      {relatedWorkspace ? (
        <SettingsGroup
          embedded
          title="Related workspace"
          description="Open the app or source connected to this consent."
        >
          <SettingsRow
            title={relatedWorkspace.title}
            description={relatedWorkspace.description}
            trailing={
              <Button asChild variant="none" effect="fade" size="sm">
                <Link
                  href={relatedWorkspace.href}
                  data-voice-control-id="consent_open_request"
                >
                  {relatedWorkspace.label}
                  {relatedWorkspace.external ? (
                    <ExternalLink className="ml-2 h-4 w-4" />
                  ) : null}
                </Link>
              </Button>
            }
          />
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
      (!entry.consent_chain || entry.consent_chain.length <= 1) &&
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

/**
 * One SwipeViews pane's list body (rows + pagination). Presentational only -
 * every pane stays mounted, so each owns its own resource one level up in
 * ConsentCenterPage; the shared announcer/session-recovery/retry banners for
 * whichever tab is actually active stay outside this component entirely.
 */
function ConsentSurfaceListSection({
  loading,
  emptyMessage,
  items,
  selectedEntry,
  selectedId,
  onSelectEntry,
  pagination,
}: {
  loading: boolean;
  emptyMessage: string;
  items: ConsentCenterEntry[];
  selectedEntry: ConsentCenterEntry | null;
  selectedId: string | null;
  onSelectEntry: (entry: ConsentCenterEntry) => void;
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
    onPrevious: () => void;
    onNext: () => void;
  } | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-consent-list-scroll="true"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      >
        {loading && items.length === 0 ? (
          <SettingsRow title="Loading consent entries" />
        ) : null}
        {!loading && items.length === 0 ? (
          <SettingsRow title={emptyMessage} />
        ) : null}
        {items.map((entry, index) => (
          <ConsentEntryRow
            key={`${entry.kind}-${entry.id}-${entry.request_id || "no-request"}-${index}`}
            entry={entry}
            selected={
              // Bug: when nothing is selected, selectedEntry is null,
              // so selectedEntry?.id and selectedEntry?.request_id are
              // both undefined. Entries without their own request_id
              // (e.g. one_location_grant rows) also have
              // entry.request_id === undefined, so
              // "undefined === undefined" was true and falsely
              // highlighted that row as selected on every render -
              // this is the row that appeared to randomly "jump" to
              // a different entry on every tab switch. Require a
              // real selectedEntry (or a matching selectedId) before
              // comparing ids at all.
              Boolean(
                selectedEntry &&
                (selectedEntry.id === entry.id ||
                  (selectedEntry.request_id &&
                    selectedEntry.request_id === entry.request_id)),
              ) ||
              Boolean(
                selectedId && consentEntryMatchesSelectedId(entry, selectedId),
              )
            }
            onSelect={() => onSelectEntry(entry)}
          />
        ))}
      </div>
      {pagination ? (
        <div className="shrink-0">
          <PaginatedListFooter
            page={pagination.page}
            limit={pagination.limit}
            total={pagination.total}
            hasMore={pagination.hasMore}
            onPrevious={pagination.onPrevious}
            onNext={pagination.onNext}
          />
        </div>
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
  // SwipeViews keeps every pane mounted, so each tab's resource must load only
  // once it has actually been visited (never eagerly on mount) - otherwise a
  // background Connections pane would call getCenter() on every page load.
  const [visitedSurfaces, setVisitedSurfaces] = useState<Set<ConsentTab>>(
    () => new Set([tab]),
  );
  useEffect(() => {
    setVisitedSurfaces((current) =>
      current.has(tab) ? current : new Set(current).add(tab),
    );
  }, [tab]);
  // Fast, local "which pane is showing" state for SwipeViews - the route
  // (`tab`) stays the selection authority, matching the same visible/active
  // split Kai's own SwipeViews-backed tabs already use.
  const [visibleTab, setVisibleTab] = useState<ConsentTab>(tab);
  useEffect(() => {
    setVisibleTab(tab);
  }, [tab]);
  const commitConsentTab = useCallback(
    (value: ConsentTab) => {
      if (value === tab) return;
      // A tab switch deliberately drops list/search/detail state - the same
      // contract the shell's tab pills and route-hop swipe already use (see
      // buildConsentCenterTabRoute), so swiping and clicking stay identical.
      router.push(buildConsentCenterTabRoute(value, searchParams), {
        scroll: false,
      });
    },
    [router, searchParams, tab],
  );
  const managerView: "incoming" | "outgoing" = riaOutgoingCompatibilityRoute
    ? "outgoing"
    : "incoming";
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  // Pagination stays URL-backed only for the currently active tab (matching
  // today's single shared `page` param); background panes that are mounted
  // but not the active tab keep their own local page so swiping away and back
  // does not reset them, without entangling the URL with a tab you cannot see.
  const [pendingLocalPage, setPendingLocalPage] = useState(1);
  const [activeLocalPage, setActiveLocalPage] = useState(1);
  const [previousLocalPage, setPreviousLocalPage] = useState(1);
  const pendingPage = tab === "requests" ? page : pendingLocalPage;
  const activePage = tab === "active" ? page : activeLocalPage;
  const previousPage = tab === "history" ? page : previousLocalPage;
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
    if (routeQuery !== searchValue) {
      setSearchValue(routeQuery);
    }
    // searchValue is intentionally omitted: local input should not be reset
    // while its deferred URL update is still pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeQuery]);

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
  }, [getVaultOwnerToken, isVaultUnlocked, user?.uid, vaultKey]);

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
  /**
   * Settle a connection request the user has just answered.
   *
   * Two separate things have to happen or the row survives its own decision.
   * The local id retires it from the connections pane straight away, and the
   * event has to carry `reconcile` — the listener ignores a bare event, so an
   * accepted request used to sit there looking unanswered until a reload.
   *
   * The event deliberately carries no `action`: the optimistic summary maths
   * behind that field counts consent rows, and a connection request is not
   * one, so claiming an approve here would knock a real pending consent off
   * the badge. The forced refetch settles the true counts a moment later.
   */
  const markConnectionRequestHandled = useCallback((requestId: string) => {
    const normalized = requestId.trim();
    if (normalized) {
      setLocallyHandledRequestIds((current) => {
        const next = new Set(current);
        next.add(normalized);
        return next;
      });
    }
    window.dispatchEvent(
      new CustomEvent(CONSENT_ACTION_COMPLETE_EVENT, {
        detail: { reconcile: true },
      }),
    );
  }, []);
  const approveEntry = useCallback(
    (
      entry: ConsentCenterEntry,
      durationHours?: number,
      scopeSelection?: {
        requestedScopeHandles: string[];
        offeredScopeHandles: string[];
      },
    ) => {
      if (isConnectionRequestEntry(entry)) {
        void (async () => {
          if (!user) return;
          const requestId = entry.request_id || entry.id;
          try {
            const idToken = await user.getIdToken();
            await ConnectionsService.accept({
              idToken,
              requestId,
              selectedRequestedScopeHandles:
                scopeSelection?.requestedScopeHandles,
              selectedOfferedScopeHandles: scopeSelection?.offeredScopeHandles,
            });
            CacheSyncService.onConnectionCapabilityMutated(user.uid);
            markConnectionRequestHandled(requestId);
          } catch (error) {
            console.error(
              "[ConsentCenter] Couldn't accept the connection request:",
              error,
            );
            toast.error("Could not accept the connection request. Try again.");
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
      handleApprove,
      handleLocationApprove,
      handleMarketplaceApprove,
      isLocationEntry,
      isMarketplaceEntry,
      markConnectionRequestHandled,
      user,
    ],
  );
  const denyEntry = useCallback(
    (entry: ConsentCenterEntry) => {
      if (isConnectionRequestEntry(entry)) {
        void (async () => {
          if (!user) return;
          const requestId = entry.request_id || entry.id;
          try {
            const idToken = await user.getIdToken();
            await ConnectionsService.reject({
              idToken,
              requestId,
            });
            CacheSyncService.onConnectionCapabilityMutated(user.uid);
            markConnectionRequestHandled(requestId);
          } catch (error) {
            console.error(
              "[ConsentCenter] Couldn't decline the connection request:",
              error,
            );
            toast.error("Could not decline the connection request. Try again.");
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
      handleDeny,
      handleLocationDeny,
      handleMarketplaceDeny,
      isLocationEntry,
      isMarketplaceEntry,
      markConnectionRequestHandled,
      user,
    ],
  );
  const revokeEntry = useCallback(
    (entry: ConsentCenterEntry) => {
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
      handleLocationRevoke,
      handleMarketplaceRevoke,
      handleRevoke,
      isLocationEntry,
      isMarketplaceEntry,
    ],
  );
  const idTokenLoader = async () => user?.getIdToken();

  const summaryResource = useStaleResource({
    cacheKey: summaryCacheKey,
    refreshKey: `${consentScopeKey}:${mode}`,
    enabled: Boolean(user?.uid),
    retainOnInvalidate: true,
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
    enabled: Boolean(user?.uid) && visitedSurfaces.has("connections"),
    retainOnInvalidate: true,
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

  // Requests / Active / History each get their own resource (rather than one
  // resource that swaps surface/page when `tab` changes) so all four
  // SwipeViews panes can stay mounted and independently live, matching how
  // Kai/Location's tab sets already behave under SwipeViews.
  const pendingResource = useStaleResource({
    cacheKey: user?.uid
      ? CACHE_KEYS.CONSENT_CENTER_LIST(
          user.uid,
          `${consentScopeKey}:${mode}`,
          "pending",
          deferredQuery,
          pendingPage,
          CONSENT_CENTER_PAGE_SIZE,
        )
      : "consent_center_list_guest_pending",
    refreshKey: `${consentScopeKey}:${mode}:pending:${deferredQuery}:${pendingPage}`,
    enabled: Boolean(user?.uid) && visitedSurfaces.has("requests"),
    retainOnInvalidate: true,
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
        surface: "pending",
        q: deferredQuery,
        page: pendingPage,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: Boolean(options?.force),
      });
    },
  });
  const activeResource = useStaleResource({
    cacheKey: user?.uid
      ? CACHE_KEYS.CONSENT_CENTER_LIST(
          user.uid,
          `${consentScopeKey}:${mode}`,
          "active",
          deferredQuery,
          activePage,
          CONSENT_CENTER_PAGE_SIZE,
        )
      : "consent_center_list_guest_active",
    refreshKey: `${consentScopeKey}:${mode}:active:${deferredQuery}:${activePage}`,
    enabled: Boolean(user?.uid) && visitedSurfaces.has("active"),
    retainOnInvalidate: true,
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
        surface: "active",
        q: deferredQuery,
        page: activePage,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: Boolean(options?.force),
      });
    },
  });
  const previousResource = useStaleResource({
    cacheKey: user?.uid
      ? CACHE_KEYS.CONSENT_CENTER_LIST(
          user.uid,
          `${consentScopeKey}:${mode}`,
          "previous",
          deferredQuery,
          previousPage,
          CONSENT_CENTER_PAGE_SIZE,
        )
      : "consent_center_list_guest_previous",
    refreshKey: `${consentScopeKey}:${mode}:previous:${deferredQuery}:${previousPage}`,
    enabled: Boolean(user?.uid) && visitedSurfaces.has("history"),
    retainOnInvalidate: true,
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
        surface: "previous",
        q: deferredQuery,
        page: previousPage,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: Boolean(options?.force),
      });
    },
  });
  // The tab actually visible right now, in the exact shape the rest of this
  // component already expects from "the one active list resource".
  const listResource =
    tab === "requests"
      ? pendingResource
      : tab === "history"
        ? previousResource
        : tab === "active"
          ? activeResource
          : null;
  const forcedMutationRefreshRef = useRef(0);

  // CacheSyncService invalidates every consent surface after a real mutation,
  // while SwipeViews deliberately keeps previously visited panes mounted.
  // A background pane therefore remains enabled after its cached data is
  // cleared. Refresh only when that pane becomes visible again and has no
  // retained resource; this avoids eager fan-out across hidden tabs while
  // preventing a stale invalidation from rendering as a false empty state.
  useEffect(() => {
    if (!user?.uid || tab === "connections") return;
    if (
      !listResource ||
      (!listResource.invalidated && listResource.data) ||
      listResource.loading ||
      listResource.refreshing
    ) {
      return;
    }
    void listResource.refresh({ force: listResource.invalidated });
    // This is intentionally a tab-entry effect. Watching the resource's
    // transition-backed data/loading fields can observe the brief state where
    // loading has settled before React commits data, causing a redundant fetch
    // loop. Current-tab mutations already use the forced refresh effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, user?.uid]);

  useEffect(() => {
    if (!mutationTick) return;
    if (forcedMutationRefreshRef.current === mutationTick) return;
    forcedMutationRefreshRef.current = mutationTick;

    void summaryResource.refresh({ force: true });
    if (tab === "connections") {
      void centerResource.refresh({ force: true });
    } else {
      void listResource?.refresh({ force: true });
    }
  }, [centerResource, listResource, mutationTick, summaryResource, tab]);

  useEffect(() => {
    if (summaryResource.data) {
      setRetainedSummary({ key: summaryCacheKey, data: summaryResource.data });
    }
  }, [summaryCacheKey, summaryResource.data]);

  useEffect(() => {
    if (listResource?.data) {
      setRetainedList({ key: listCacheKey, data: listResource.data });
    }
  }, [listCacheKey, listResource?.data]);
  const summaryData =
    summaryResource.data ??
    (retainedSummary?.key === summaryCacheKey ? retainedSummary.data : null);
  const listData =
    listResource?.data ??
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
  const items = useMemo(
    () =>
      filterConsentSurfaceEntries(
        tab === "connections" ? connectionItems : listData?.items || [],
        // `listSurface` has no case for the connections tab and falls through
        // to "active"; naming the surface honestly here is what lets a just-
        // answered connection request be filtered out of the live pane.
        tab === "connections" ? "connections" : listSurface,
        locallyHandledRequestIds,
        locallyRevokedScopes,
      ),
    [
      listData?.items,
      locallyHandledRequestIds,
      locallyRevokedScopes,
      listSurface,
      connectionItems,
      tab,
    ],
  );
  // Every pane stays mounted under SwipeViews, so whichever pane is NOT the
  // active tab still needs its own filtered items to render - `items` above
  // only ever reflects the currently active surface.
  const pendingItems = useMemo(
    () =>
      tab === "requests"
        ? items
        : filterConsentSurfaceEntries(
            pendingResource.data?.items || [],
            "pending",
            locallyHandledRequestIds,
            locallyRevokedScopes,
          ),
    [
      tab,
      items,
      pendingResource.data,
      locallyHandledRequestIds,
      locallyRevokedScopes,
    ],
  );
  const activeSurfaceItems = useMemo(
    () =>
      tab === "active"
        ? items
        : filterConsentSurfaceEntries(
            activeResource.data?.items || [],
            "active",
            locallyHandledRequestIds,
            locallyRevokedScopes,
          ),
    [
      tab,
      items,
      activeResource.data,
      locallyHandledRequestIds,
      locallyRevokedScopes,
    ],
  );
  const previousItems = useMemo(
    () =>
      tab === "history"
        ? items
        : filterConsentSurfaceEntries(
            previousResource.data?.items || [],
            "previous",
            locallyHandledRequestIds,
            locallyRevokedScopes,
          ),
    [
      tab,
      items,
      previousResource.data,
      locallyHandledRequestIds,
      locallyRevokedScopes,
    ],
  );
  const connectionsSurfaceItems = useMemo(
    () =>
      tab === "connections"
        ? items
        : filterConsentSurfaceEntries(
            connectionItems,
            "connections",
            locallyHandledRequestIds,
            locallyRevokedScopes,
          ),
    [
      tab,
      items,
      connectionItems,
      locallyHandledRequestIds,
      locallyRevokedScopes,
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
    tab === "connections" ? centerResource.error : listResource!.error;
  const activeListLoading =
    tab === "connections" ? centerResource.loading : listResource!.loading;
  const activeListRefreshing =
    tab === "connections"
      ? centerResource.refreshing
      : listResource!.refreshing;
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
    tab === "connections" ? centerResource.snapshot : listResource!.snapshot;
  const isConsentActionRefreshing =
    summaryResource.refreshing ||
    Boolean(listResource?.refreshing) ||
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
    (Boolean(listResource?.loading) ||
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
  const listMismatchRetryRef = useRef<string | null>(null);

  useEffect(() => {
    if (tab === "connections" || !listResource) return;
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
        ...(listResource?.loading ? ["consent_list_load"] : []),
        ...(listResource?.refreshing ? ["consent_list_refresh"] : []),
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
    listResource?.loading,
    listResource?.refreshing,
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

  // Pagination stays URL-backed for whichever surface is the active tab (so
  // links/back-forward keep working exactly as today); a swiped-to-but-not-
  // committed background pane pages through its own local state instead.
  function buildSurfacePagination(
    surface: "requests" | "active" | "history",
    displayData: ConsentCenterPageListResponse | null,
    currentPage: number,
    setLocalPage: (value: number) => void,
  ) {
    if (!displayData) return null;
    return {
      page: displayData.page,
      limit: displayData.limit,
      total: displayData.total,
      hasMore: displayData.has_more,
      onPrevious: () => {
        const next = Math.max(1, currentPage - 1);
        if (tab === surface) setParam({ page: String(next) });
        else setLocalPage(next);
      },
      onNext: () => {
        const next = currentPage + 1;
        if (tab === surface) setParam({ page: String(next) });
        else setLocalPage(next);
      },
    };
  }

  const pendingPagination = buildSurfacePagination(
    "requests",
    tab === "requests" ? listData : pendingResource.data,
    pendingPage,
    setPendingLocalPage,
  );
  const activePagination = buildSurfacePagination(
    "active",
    tab === "active" ? listData : activeResource.data,
    activePage,
    setActiveLocalPage,
  );
  const previousPagination = buildSurfacePagination(
    "history",
    tab === "history" ? listData : previousResource.data,
    previousPage,
    setPreviousLocalPage,
  );
  return (
    <AppPageShell as="main" width="reading" className="pb-24 sm:pb-28" fitContent>
      <AppPageContentRegion>
        <section
          data-testid="consent-manager-primary"
          className="min-h-0"
        >
          <section data-testid="consent-manager-list">
            <SettingsGroup
              embedded
              separatorInset
              shellClassName="flex min-h-0 flex-col"
              contentClassName="flex min-h-0 flex-col"
            >
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

              <AccessibilityStatusAnnouncer
                message={accessibilityStatusMessage}
              />

              {showSessionRecovery ? <SessionExpiryRecovery /> : null}

              {showCompactRetryState ? (
                <ApiRetryState
                  variant="compact"
                  title="Showing saved consent information"
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

              <div className="min-h-0">
                <SwipeViews
                  tabSetId={TOP_SHELL_TAB_REGISTRY.consent.id}
                  activeValue={visibleTab}
                  options={TOP_SHELL_TAB_REGISTRY.consent.tabs}
                  onSelectionChange={(value) =>
                    setVisibleTab(value as ConsentTab)
                  }
                  onSelectionCommit={(value) =>
                    commitConsentTab(value as ConsentTab)
                  }
                  panelInset="none"
                  viewportMinHeight="0px"
                  heightMode="active"
                >
                  <ConsentSurfaceListSection
                    loading={pendingResource.loading}
                    emptyMessage={
                      tab === "requests"
                        ? emptyListMessage
                        : "No requests need your review."
                    }
                    items={pendingItems}
                    selectedEntry={selectedEntry}
                    selectedId={selectedId}
                    onSelectEntry={(entry) =>
                      setParam({ requestId: entry.request_id || entry.id })
                    }
                    pagination={pendingPagination}
                  />
                  <ConsentSurfaceListSection
                    loading={activeResource.loading}
                    emptyMessage={
                      tab === "active"
                        ? emptyListMessage
                        : "No one currently has active access."
                    }
                    items={activeSurfaceItems}
                    selectedEntry={selectedEntry}
                    selectedId={selectedId}
                    onSelectEntry={(entry) =>
                      setParam({ requestId: entry.request_id || entry.id })
                    }
                    pagination={activePagination}
                  />
                  <ConsentSurfaceListSection
                    loading={previousResource.loading}
                    emptyMessage={
                      tab === "history"
                        ? emptyListMessage
                        : "No consent activity has been recorded yet."
                    }
                    items={previousItems}
                    selectedEntry={selectedEntry}
                    selectedId={selectedId}
                    onSelectEntry={(entry) =>
                      setParam({ requestId: entry.request_id || entry.id })
                    }
                    pagination={previousPagination}
                  />
                  <ConsentSurfaceListSection
                    loading={centerResource.loading}
                    emptyMessage={
                      tab === "connections"
                        ? emptyListMessage
                        : "No connections are available yet."
                    }
                    items={connectionsSurfaceItems}
                    selectedEntry={selectedEntry}
                    selectedId={selectedId}
                    onSelectEntry={(entry) =>
                      setParam({ requestId: entry.request_id || entry.id })
                    }
                    pagination={null}
                  />
                </SwipeViews>
              </div>
            </SettingsGroup>
          </section>
        </section>
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
        mobilePresentation="sheet"
        showCloseButton={false}
      >
        {notificationAction && selectedEntry?.status === "pending" ? (
          <div
            role="status"
            className="mb-4 rounded-[var(--app-card-radius-compact)] border border-accent-border bg-accent-surface px-4 py-3 text-sm leading-5 text-foreground"
          >
            {notificationAction === "review"
              ? "Opened from a notification. Review the request below."
              : notificationAction === "approve"
                ? "Allow was selected in the notification. Access changes only when you choose Allow below."
                : "Don’t allow was selected in the notification. Nothing changes until you decide below."}
          </div>
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
            onApprove={(entry, durationHours, scopeSelection) => {
              // Dismiss the panel immediately; the list already optimistically
              // removes the row and any failure surfaces via toast.
              closeDetailPanel();
              approveEntry(entry, durationHours, scopeSelection);
            }}
            onDeny={(entry) => {
              closeDetailPanel();
              denyEntry(entry);
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

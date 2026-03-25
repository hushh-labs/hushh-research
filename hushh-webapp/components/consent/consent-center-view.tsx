"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  BellRing,
  BriefcaseBusiness,
  ClipboardList,
  History,
  Loader2,
  RefreshCw,
  Shield,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { useVault } from "@/lib/vault/vault-context";
import { useConsentActions } from "@/lib/consent";
import {
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterEntry,
  type ConsentCenterResponse,
  type ConsentCenterView,
} from "@/lib/services/consent-center-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildConsentSheetProfileHref,
  CONSENT_BUNDLE_QUERY_KEY,
  CONSENT_REQUEST_QUERY_KEY,
  normalizeConsentSheetView,
  type ConsentSheetView,
} from "@/lib/consent/consent-sheet-route";
import { Button } from "@/lib/morphy-ux/button";
import { Badge } from "@/components/ui/badge";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, SectionHeader, ContentSurface } from "@/components/app-ui/page-sections";
import { SurfaceInset, SurfaceStack } from "@/components/app-ui/surfaces";
import { useConsentNotificationState } from "@/components/consent/notification-provider";
import { Icon } from "@/lib/morphy-ux/ui";
import { SegmentedPill, type SegmentedPillOption } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

const SURFACE_VIEW_LABELS = {
  pending: "Pending",
  active: "Active",
  previous: "Previous",
} as const;

type ConsentSurfaceView = ConsentSheetView;

function resolveRequestView(
  actor: ConsentCenterActor,
  surfaceView: ConsentSurfaceView
): ConsentCenterView {
  if (surfaceView === "active") return "active";
  if (surfaceView === "previous") return "history";
  return actor === "ria" ? "outgoing" : "incoming";
}

function statusTone(status: string) {
  switch (status) {
    case "approved":
    case "active":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    case "request_pending":
    case "pending":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    case "revoked":
    case "denied":
    case "cancelled":
      return "bg-red-500/10 text-red-600 border-red-500/20";
    case "expired":
      return "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
    case "sent":
      return "bg-sky-500/10 text-sky-600 border-sky-500/20";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatDate(value: number | string | null | undefined) {
  if (!value) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function toTimestamp(value: number | string | null | undefined) {
  if (typeof value === "number") return value;
  if (!value) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDurationLabel(hours: number | null | undefined) {
  if (!hours || !Number.isFinite(hours)) return "24 hours";
  if (hours === 24) return "24 hours";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatRelativeCountdown(value: number | string | null | undefined) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return null;
  const deltaMs = timestamp - Date.now();
  if (deltaMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(deltaMs / (60 * 1000));
  if (totalMinutes < 60) return `${totalMinutes} min left`;
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours} hr left`;
  const totalDays = Math.ceil(totalHours / 24);
  return `${totalDays} day${totalDays === 1 ? "" : "s"} left`;
}

function resolveRequesterImage(
  imageUrl?: string | null,
  websiteUrl?: string | null
) {
  if (imageUrl) return imageUrl;
  if (!websiteUrl) return null;
  try {
    const host = new URL(websiteUrl).host;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
}

function requesterInitials(label: string | null | undefined) {
  const parts = String(label || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "R";
  return parts.map((part) => part[0]?.toUpperCase() || "").join("");
}

function normalizeScopeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item): item is string => item.length > 0);
}

function entryHeadline(entry: ConsentCenterEntry) {
  if (entry.counterpart_label) return entry.counterpart_label;
  if (entry.kind === "invite") return "Invite";
  return entry.scope || "Consent request";
}

function entrySupportingCopy(entry: ConsentCenterEntry) {
  if (entry.scope_description) return entry.scope_description;
  if (entry.kind === "invite") return "Pre-consent handshake before the investor reviews access.";
  if (entry.kind === "outgoing_request") return "Request created from your advisor relationship flow.";
  if (entry.kind === "incoming_request") return "Approval is required before any protected data can be accessed.";
  return entry.scope || "Consent workflow event";
}

function getEntriesForSurfaceView(
  center: ConsentCenterResponse | null,
  actor: ConsentCenterActor,
  surfaceView: ConsentSurfaceView
) {
  if (!center) return [];

  if (surfaceView === "active") return center.active_grants;
  if (surfaceView === "previous") return center.history;

  const pendingEntries =
    actor === "ria"
      ? [...center.outgoing_requests, ...center.invites]
      : [...center.incoming_requests, ...center.developer_requests];

  return pendingEntries.sort((left, right) => {
    const leftTime = left.issued_at ? new Date(String(left.issued_at)).getTime() : 0;
    const rightTime = right.issued_at ? new Date(String(right.issued_at)).getTime() : 0;
    return rightTime - leftTime;
  });
}

function getViewCount(
  center: ConsentCenterResponse | null,
  actor: ConsentCenterActor,
  surfaceView: ConsentSurfaceView
) {
  if (!center) return 0;
  if (surfaceView === "active") return center.summary.active_grants;
  if (surfaceView === "previous") return center.summary.history;
  return actor === "ria"
    ? center.summary.outgoing_requests + center.summary.invites
    : center.summary.incoming_requests + center.summary.developer_requests;
}

function emptyStateCopy(actor: ConsentCenterActor, surfaceView: ConsentSurfaceView) {
  if (surfaceView === "active") {
    return "No active access grants yet.";
  }
  if (surfaceView === "previous") {
    return "No previous consent activity yet.";
  }
  return actor === "ria"
    ? "No pending RIA requests or invites yet."
    : "No pending investor approvals or developer requests yet.";
}

function deliveryModeCopy(mode: "push_active" | "push_blocked" | "push_failed_fallback_active" | "inbox_only") {
  switch (mode) {
    case "push_blocked":
      return {
        title: "Browser push is blocked",
        description: "Live consent alerts are active while this tab is open.",
      };
    case "push_failed_fallback_active":
      return {
        title: "Using live fallback alerts",
        description:
          "Push registration failed, but live consent alerts are active while this tab stays open.",
      };
    case "inbox_only":
      return {
        title: "Inbox-only delivery",
        description:
          "Live alerts are unavailable in this session. Pending requests will appear when you revisit the app.",
      };
    default:
      return null;
  }
}

const DURATION_OPTIONS = [
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "2160", label: "90 days" },
] as const;

type ConsentBundleGroup = {
  bundleId: string;
  bundleLabel: string;
  entries: ConsentCenterEntry[];
  counterpartLabel: string;
  issuedAt?: number | string | null;
  expiresAt?: number | string | null;
};

function groupConsentBundles(entries: ConsentCenterEntry[]): ConsentBundleGroup[] {
  const bundles = new Map<string, ConsentBundleGroup>();
  for (const entry of entries) {
    const metadata =
      entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const bundleId = String(
      metadata.bundle_id || entry.request_id || entry.id
    ).trim();
    if (!bundleId) continue;
    const existing = bundles.get(bundleId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    bundles.set(bundleId, {
      bundleId,
      bundleLabel:
        String(metadata.bundle_label || "").trim() || "Portfolio access request",
      entries: [entry],
      counterpartLabel: entry.counterpart_label || "Requester",
      issuedAt: entry.issued_at,
      expiresAt: entry.expires_at,
    });
  }
  return [...bundles.values()].sort((left, right) => {
    const leftTime = left.issuedAt ? new Date(String(left.issuedAt)).getTime() : 0;
    const rightTime = right.issuedAt ? new Date(String(right.issuedAt)).getTime() : 0;
    return rightTime - leftTime;
  });
}

function isBundledEntry(entry: ConsentCenterEntry) {
  return Boolean(
    entry.kind === "incoming_request" &&
      entry.metadata &&
      typeof entry.metadata === "object" &&
      "bundle_id" in entry.metadata &&
      entry.metadata.bundle_id
  );
}

function parseDurationHours(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toPendingConsent(entry: ConsentCenterEntry, durationHours?: number) {
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  return {
    id: entry.request_id || entry.id,
    developer: entry.counterpart_label || "requester",
    developerImageUrl: entry.counterpart_image_url || undefined,
    developerWebsiteUrl: entry.counterpart_website_url || undefined,
    scope: entry.scope || "",
    scopeDescription: entry.scope_description || undefined,
    requestedAt:
      typeof entry.issued_at === "number"
        ? entry.issued_at
        : entry.issued_at
          ? new Date(String(entry.issued_at)).getTime()
          : Date.now(),
    approvalTimeoutAt:
      typeof entry.approval_timeout_at === "number"
        ? entry.approval_timeout_at
        : entry.approval_timeout_at
          ? new Date(String(entry.approval_timeout_at)).getTime()
          : undefined,
    expiryHours:
      typeof metadata.expiry_hours === "number" ? metadata.expiry_hours : undefined,
    durationHours,
    bundleId:
      String(metadata.bundle_id || "") || undefined,
    requestUrl: entry.request_url || undefined,
    reason: entry.reason || (typeof metadata.reason === "string" ? metadata.reason : undefined),
    isScopeUpgrade:
      entry.is_scope_upgrade || Boolean(metadata.is_scope_upgrade) || undefined,
    existingGrantedScopes:
      entry.existing_granted_scopes ||
      normalizeScopeList(metadata.existing_granted_scopes) ||
      undefined,
    additionalAccessSummary:
      entry.additional_access_summary ||
      (typeof metadata.additional_access_summary === "string"
        ? metadata.additional_access_summary
        : undefined),
    metadata,
  };
}

export function ConsentCenterView({
  embedded = false,
  className,
  initialView = "pending",
}: {
  embedded?: boolean;
  className?: string;
  initialView?: ConsentSurfaceView;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked } = useVault();
  const { activePersona, riaCapability } = usePersonaState();
  const notificationState = useConsentNotificationState();
  const actor: ConsentCenterActor = activePersona === "ria" ? "ria" : "investor";
  const [embeddedView, setEmbeddedView] = useState<ConsentSurfaceView>(
    normalizeConsentSheetView(initialView)
  );
  const surfaceView = embedded
    ? embeddedView
    : normalizeConsentSheetView(searchParams.get("view"));
  const focusedRequestId = searchParams.get(CONSENT_REQUEST_QUERY_KEY);
  const focusedBundleId = searchParams.get(CONSENT_BUNDLE_QUERY_KEY);
  const requestView = resolveRequestView(actor, surfaceView);

  const [center, setCenter] = useState<ConsentCenterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    handleApprove,
    handleApproveBundle,
    handleDeny,
    handleDenyBundle,
    handleRevoke,
  } = useConsentActions({
    userId: user?.uid,
    onActionComplete: () => {
      if (user) {
        void loadCenter({ force: true, silent: true });
      }
    },
  });
  const [bundleDurationMode, setBundleDurationMode] = useState<
    Record<string, "shared" | "per-scope">
  >({});
  const [bundleSharedDuration, setBundleSharedDuration] = useState<Record<string, string>>({});
  const [bundleScopeDurations, setBundleScopeDurations] = useState<
    Record<string, Record<string, string>>
  >({});
  const [singleRequestDurations, setSingleRequestDurations] = useState<Record<string, string>>({});
  const [expandedBundles, setExpandedBundles] = useState<Record<string, boolean>>({});
  const [disconnectingCounterpartKey, setDisconnectingCounterpartKey] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!embedded) return;
    setEmbeddedView(normalizeConsentSheetView(initialView));
  }, [embedded, initialView]);

  const loadCenter = useCallback(
    async (options?: { force?: boolean; silent?: boolean }) => {
      if (!user) {
        setCenter(null);
        setLoading(false);
        return;
      }

      const cache = CacheService.getInstance();
      const cachedSnapshot = cache.peek<ConsentCenterResponse>(
        CACHE_KEYS.CONSENT_CENTER(user.uid, `${actor}:${requestView}`)
      );
      const cachedCenter = cachedSnapshot?.data ?? null;
      const hasCachedCenter = Boolean(cachedCenter);
      const shouldSkipNetwork = Boolean(cachedSnapshot?.isFresh) && !options?.force;

      if (hasCachedCenter) {
        setCenter(cachedCenter);
        setLoading(false);
      } else if (!options?.silent) {
        setLoading(true);
      }

      if (options?.silent || (hasCachedCenter && !shouldSkipNetwork)) {
        setRefreshing(true);
      }
      setError(null);

      if (shouldSkipNetwork) {
        setRefreshing(false);
        return;
      }

      try {
        const idToken = await user.getIdToken();
        const nextCenter = await ConsentCenterService.getCenter({
          idToken,
          userId: user.uid,
          actor,
          view: requestView,
          force: Boolean(options?.force),
        });
        setCenter(nextCenter);
      } catch (loadError) {
        setCenter(null);
        setError(loadError instanceof Error ? loadError.message : "Failed to load consent center");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [actor, requestView, user]
  );

  useEffect(() => {
    if (!embedded && authLoading && !user) return;
    if (authLoading || user) return;
    router.replace(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.CONSENTS)}`);
  }, [authLoading, embedded, router, user]);

  useEffect(() => {
    if (authLoading) return;
    void loadCenter();
  }, [authLoading, loadCenter]);

  useEffect(() => {
    const handler = () => {
      void loadCenter({ force: true, silent: true });
    };
    window.addEventListener("consent-action-complete", handler);
    return () => window.removeEventListener("consent-action-complete", handler);
  }, [loadCenter]);

  const visibleEntries = useMemo(
    () => getEntriesForSurfaceView(center, actor, surfaceView),
    [actor, center, surfaceView]
  );
  const visibleGroups = useMemo(
    () => (actor === "investor" ? center?.requestor_groups?.[surfaceView] || [] : []),
    [actor, center, surfaceView]
  );
  const deliveryCopy = useMemo(
    () => deliveryModeCopy(notificationState.deliveryMode),
    [notificationState.deliveryMode]
  );

  const pendingBundleGroups = useMemo(
    () =>
      actor === "investor" && surfaceView === "pending"
        ? groupConsentBundles(visibleEntries.filter((entry) => isBundledEntry(entry)))
        : [],
    [actor, surfaceView, visibleEntries]
  );

  const listEntries = useMemo(
    () =>
      actor === "investor" && surfaceView === "pending"
        ? visibleEntries.filter((entry) => !isBundledEntry(entry))
        : visibleEntries,
    [actor, surfaceView, visibleEntries]
  );

  const viewOptions = useMemo<SegmentedPillOption[]>(
    () => [
      {
        value: "pending",
        label: `${SURFACE_VIEW_LABELS.pending} ${getViewCount(center, actor, "pending")}`,
        icon: Shield,
      },
      {
        value: "active",
        label: `${SURFACE_VIEW_LABELS.active} ${getViewCount(center, actor, "active")}`,
        icon: BadgeCheck,
      },
      {
        value: "previous",
        label: `${SURFACE_VIEW_LABELS.previous} ${getViewCount(center, actor, "previous")}`,
        icon: History,
      },
    ],
    [actor, center]
  );

  const updateView = (nextView: ConsentSurfaceView) => {
    if (embedded) {
      setEmbeddedView(nextView);
      return;
    }
    router.replace(buildConsentSheetProfileHref(nextView));
  };

  const handleDisconnectRelationship = useCallback(
    async (entry: ConsentCenterEntry) => {
      if (!user || !entry.counterpart_id) return;

      const counterpartType = entry.counterpart_type;
      if (!["ria", "investor"].includes(counterpartType)) {
        return;
      }

      const counterpartKey = `${counterpartType}:${entry.counterpart_id}`;
      try {
        setDisconnectingCounterpartKey(counterpartKey);
        const idToken = await user.getIdToken();
        await ConsentCenterService.disconnectRelationship({
          idToken,
          investor_user_id:
            counterpartType === "investor" ? String(entry.counterpart_id) : undefined,
          ria_profile_id: counterpartType === "ria" ? String(entry.counterpart_id) : undefined,
        });
        toast.success("Relationship disconnected", {
          description:
            "Live access was revoked immediately. Consent history stays visible for audit.",
        });
        await loadCenter({ force: true, silent: true });
      } catch (disconnectError) {
        toast.error(
          disconnectError instanceof Error
            ? disconnectError.message
            : "Failed to disconnect relationship"
        );
      } finally {
        setDisconnectingCounterpartKey(null);
      }
    },
    [loadCenter, user]
  );

  const renderBundleCard = (bundle: ConsentBundleGroup) => {
    const durationMode = bundleDurationMode[bundle.bundleId] || "shared";
    const sharedDuration = bundleSharedDuration[bundle.bundleId] || "168";
    const isExpanded = expandedBundles[bundle.bundleId] ?? false;
    const bundleMetadata =
      bundle.entries[0]?.metadata && typeof bundle.entries[0].metadata === "object"
        ? bundle.entries[0].metadata
        : {};
    const requesterImage = resolveRequesterImage(
      bundle.entries[0]?.counterpart_image_url,
      bundle.entries[0]?.counterpart_website_url
    );
    const bundleReason =
      bundle.entries[0]?.reason ||
      (typeof bundleMetadata.reason === "string" ? bundleMetadata.reason : undefined);
    const requestExpiry = formatRelativeCountdown(
      bundle.entries[0]?.approval_timeout_at || bundle.entries[0]?.expires_at
    );
    const isFocused = Boolean(focusedBundleId && focusedBundleId === bundle.bundleId);

    return (
      <SurfaceInset
        key={`bundle-${bundle.bundleId}`}
        className={cn(
          "space-y-4 px-5 py-5",
          isFocused ? "ring-2 ring-sky-500/50 bg-sky-500/5" : undefined
        )}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background text-xs font-semibold text-foreground">
                {requesterImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={requesterImage}
                    alt={bundle.counterpartLabel}
                    className="size-full object-cover"
                  />
                ) : (
                  requesterInitials(bundle.counterpartLabel)
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{bundle.counterpartLabel}</p>
                <p className="text-xs text-muted-foreground">
                  Portfolio access request
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">{bundle.bundleLabel}</p>
              <Badge className={statusTone("pending")}>pending review</Badge>
              <Badge variant="secondary">{bundle.entries.length} scopes</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {bundle.counterpartLabel} is requesting portfolio-related access. Choose one
              duration for the whole bundle or expand to set durations per scope.
            </p>
            {bundleReason ? (
              <p className="text-sm text-foreground/80">Reason: {bundleReason}</p>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {formatDate(bundle.issuedAt) ? (
                <span>Issued: {formatDate(bundle.issuedAt)}</span>
              ) : null}
              {formatDate(bundle.expiresAt) ? (
                <span>Request expires: {formatDate(bundle.expiresAt)}</span>
              ) : null}
              {requestExpiry ? <span>{requestExpiry}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() =>
                setExpandedBundles((current) => ({
                  ...current,
                  [bundle.bundleId]: !current[bundle.bundleId],
                }))
              }
            >
              {isExpanded ? "Hide scopes" : "Review scopes"}
            </Button>
          </div>
        </div>

        <SurfaceInset className="space-y-4 p-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Approval mode
            </p>
            <SegmentedPill
              size="compact"
              value={durationMode}
              onValueChange={(value) =>
                setBundleDurationMode((current) => ({
                  ...current,
                  [bundle.bundleId]: value as "shared" | "per-scope",
                }))
              }
              options={[
                { value: "shared", label: "One duration" },
                { value: "per-scope", label: "Per scope" },
              ]}
              ariaLabel={`Approval mode for ${bundle.bundleLabel}`}
              className="w-full max-w-sm"
            />
          </div>

          {durationMode === "shared" ? (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Access duration
              </p>
              <Select
                value={sharedDuration}
                onValueChange={(value) =>
                  setBundleSharedDuration((current) => ({
                    ...current,
                    [bundle.bundleId]: value,
                  }))
                }
              >
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue placeholder="Choose duration" />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {(isExpanded || durationMode === "per-scope") ? (
            <div className="space-y-3">
              {bundle.entries.map((entry) => {
                const requestId = entry.request_id || entry.id;
                const durationValue =
                  bundleScopeDurations[bundle.bundleId]?.[requestId] || "168";

                return (
                  <div
                    key={`scope-${requestId}`}
                    className="rounded-[18px] border border-border/50 bg-background/70 p-3"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-foreground">
                          {entry.scope_description || entry.scope || "Scope"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {entry.scope || "No scope code provided"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {durationMode === "per-scope" ? (
                          <Select
                            value={durationValue}
                            onValueChange={(value) =>
                              setBundleScopeDurations((current) => ({
                                ...current,
                                [bundle.bundleId]: {
                                  ...(current[bundle.bundleId] || {}),
                                  [requestId]: value,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="w-[140px]">
                              <SelectValue placeholder="Duration" />
                            </SelectTrigger>
                            <SelectContent>
                              {DURATION_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                        <Button
                          variant="none"
                          effect="fade"
                          size="sm"
                          onClick={() => void handleDeny(requestId)}
                        >
                          Deny scope
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void handleApproveBundle(
                  bundle.entries.map((entry) =>
                    toPendingConsent(
                      entry,
                      durationMode === "shared"
                        ? parseDurationHours(sharedDuration)
                        : parseDurationHours(
                            bundleScopeDurations[bundle.bundleId]?.[
                              entry.request_id || entry.id
                            ] || "168"
                          )
                    )
                  ),
                  { bundleId: bundle.bundleId, bundleLabel: bundle.bundleLabel }
                )
              }
            >
              Approve bundle
            </Button>
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() =>
                void handleDenyBundle(
                  bundle.entries.map((entry) => entry.request_id || entry.id),
                  { bundleId: bundle.bundleId, bundleLabel: bundle.bundleLabel }
                )
              }
            >
              Deny bundle
            </Button>
          </div>
        </SurfaceInset>
      </SurfaceInset>
    );
  };

  const renderEntryRow = (entry: ConsentCenterEntry) => {
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const canOpenWorkspace =
      actor === "ria" &&
      entry.counterpart_type === "investor" &&
      entry.allowed_next_action === "open_workspace" &&
      entry.counterpart_id;
    const canDisconnectRelationship =
      surfaceView !== "previous" &&
      entry.counterpart_id &&
      ((actor === "investor" && entry.counterpart_type === "ria") ||
        (actor === "ria" && entry.counterpart_type === "investor"));
    const disconnectKey =
      canDisconnectRelationship && entry.counterpart_id
        ? `${entry.counterpart_type}:${entry.counterpart_id}`
        : null;
    const requestId = entry.request_id || entry.id;
    const isIncomingRequest = entry.kind === "incoming_request";
    const selectedDuration = singleRequestDurations[requestId] || String(
      typeof metadata.expiry_hours === "number" ? metadata.expiry_hours : 24
    );
    const isFocused = Boolean(
      (focusedRequestId && focusedRequestId === requestId) ||
        (focusedBundleId &&
          typeof metadata.bundle_id === "string" &&
          metadata.bundle_id === focusedBundleId)
    );
    const requesterImage = resolveRequesterImage(
      entry.counterpart_image_url,
      entry.counterpart_website_url
    );
    const requestCountdown = formatRelativeCountdown(
      entry.approval_timeout_at || entry.expires_at
    );
    const requestedDurationLabel = formatDurationLabel(
      typeof metadata.expiry_hours === "number" ? metadata.expiry_hours : undefined
    );
    const requestReason =
      entry.reason || (typeof metadata.reason === "string" ? metadata.reason : undefined);
    const additionalAccessSummary =
      entry.additional_access_summary ||
      (typeof metadata.additional_access_summary === "string"
        ? metadata.additional_access_summary
        : undefined);
    const existingGrantedScopes =
      entry.existing_granted_scopes ||
      normalizeScopeList(metadata.existing_granted_scopes);

    return (
      <div
        key={`${entry.kind}-${entry.id}`}
        className={cn(
          "space-y-4 rounded-[24px] border px-5 py-5 transition-colors",
          isFocused ? "border-sky-500/50 bg-sky-500/5" : "border-border/40"
        )}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background text-xs font-semibold text-foreground">
                {requesterImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={requesterImage}
                    alt={entryHeadline(entry)}
                    className="size-full object-cover"
                  />
                ) : (
                  requesterInitials(entry.counterpart_label)
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{entryHeadline(entry)}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.counterpart_type === "developer"
                    ? "External developer app"
                    : entry.counterpart_type === "ria"
                      ? "Advisor request"
                      : "Consent request"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={statusTone(entry.status)}>
                {entry.status.replace(/_/g, " ")}
              </Badge>
              {entry.kind === "invite" ? <Badge variant="secondary">pre-consent</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">{entrySupportingCopy(entry)}</p>
            {entry.scope ? (
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Scope code: {entry.scope}
              </p>
            ) : null}
            {requestReason ? (
              <p className="text-sm text-foreground/80">Reason: {requestReason}</p>
            ) : null}
            {additionalAccessSummary ? (
              <p className="text-sm text-foreground/80">{additionalAccessSummary}</p>
            ) : null}
            {existingGrantedScopes.length > 0 ? (
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>Already granted:</span>
                {existingGrantedScopes.map((scope) => (
                  <Badge key={scope} variant="secondary" className="font-normal">
                    {scope}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Action: {entry.action}</span>
              {formatDate(entry.issued_at) ? (
                <span>Issued: {formatDate(entry.issued_at)}</span>
              ) : null}
              {formatDate(entry.expires_at) ? (
                <span>Expires: {formatDate(entry.expires_at)}</span>
              ) : null}
              {entry.relationship_status ? (
                <span>Relationship: {entry.relationship_status}</span>
              ) : null}
              {isIncomingRequest ? <span>Requested duration: {requestedDurationLabel}</span> : null}
              {isIncomingRequest && requestCountdown ? <span>{requestCountdown}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {isIncomingRequest ? (
              <>
                <Select
                  value={selectedDuration}
                  onValueChange={(value) =>
                    setSingleRequestDurations((current) => ({
                      ...current,
                      [requestId]: value,
                    }))
                  }
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Duration" />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={() =>
                    void handleApprove(
                      toPendingConsent(entry, parseDurationHours(selectedDuration))
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => void handleDeny(requestId)}
                >
                  Deny
                </Button>
              </>
            ) : null}

            {entry.kind === "active_grant" && entry.scope ? (
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void handleRevoke(entry.scope || "")}
              >
                Revoke
              </Button>
            ) : null}

            {canDisconnectRelationship ? (
              <Button
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void handleDisconnectRelationship(entry)}
                disabled={disconnectKey === disconnectingCounterpartKey}
              >
                {disconnectKey === disconnectingCounterpartKey ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            ) : null}

            {canOpenWorkspace ? (
              <Link
                href={`${ROUTES.RIA_HOME}/workspace/${encodeURIComponent(
                  String(entry.counterpart_id)
                )}`}
                className="inline-flex min-h-10 items-center justify-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground"
              >
                Open workspace
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const hasVisibleEntries =
    actor === "investor"
      ? visibleGroups.some((group) => group.entries.length > 0)
      : pendingBundleGroups.length > 0 || listEntries.length > 0;

  if (authLoading || !user) return null;

  const content = (
    <>
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          View
        </p>
        <SegmentedPill
          size="default"
          value={surfaceView}
          options={viewOptions}
          onValueChange={(next) => updateView(next as ConsentSurfaceView)}
          ariaLabel="Consent center view"
          className="w-full"
        />
      </div>

      {actor === "investor" && !isVaultUnlocked ? (
        <ContentSurface className="space-y-3" accent="sky">
          <SectionHeader
            eyebrow="Vault"
            title="Unlock is required for investor decisions"
            description="You can review requests here, but approving, denying, or revoking access requires an unlocked vault."
            icon={Shield}
            actions={
              <Link
                href={ROUTES.PROFILE}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground"
              >
                Open profile
              </Link>
            }
          />
        </ContentSurface>
      ) : null}

      {riaCapability === "setup" ? (
        <ContentSurface className="space-y-3" accent="emerald">
          <SectionHeader
            eyebrow="RIA setup"
            title="The same account can activate RIA mode"
            description="Complete onboarding to send investor requests and manage advisor workflows from this same login."
            icon={BriefcaseBusiness}
            actions={
              <Link
                href={ROUTES.RIA_ONBOARDING}
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-4 text-sm font-medium text-background"
              >
                Open RIA onboarding
              </Link>
            }
          />
        </ContentSurface>
      ) : null}

      {actor === "investor" && deliveryCopy ? (
        <ContentSurface
          className="space-y-3"
          tone={notificationState.deliveryMode === "push_blocked" ? "warning" : "default"}
          accent={notificationState.deliveryMode === "push_failed_fallback_active" ? "amber" : "none"}
        >
          <SectionHeader
            eyebrow="Notifications"
            title={deliveryCopy.title}
            description={deliveryCopy.description}
            icon={BellRing}
            actions={
              notificationState.deliveryMode !== "push_active" ? (
                <Button
                  variant="none"
                  effect="fade"
                  size="sm"
                  disabled={notificationState.isRetryingPushRegistration}
                  onClick={() => notificationState.retryPushRegistration()}
                >
                  {notificationState.isRetryingPushRegistration ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Retry push registration
                </Button>
              ) : null
            }
          />
          {notificationState.deliveryDetail ? (
            <p className="px-5 text-xs text-muted-foreground">
              Detail: {notificationState.deliveryDetail}
            </p>
          ) : null}
          {notificationState.deliveryMode !== "push_active" ? (
            <div className="grid gap-3 px-5 pb-5 md:grid-cols-3">
              <SurfaceInset className="p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Browser permission
                </p>
                <p className="mt-2 text-sm text-foreground">
                  Confirm notifications are allowed for this origin before retrying.
                </p>
              </SurfaceInset>
              <SurfaceInset className="p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Token registration
                </p>
                <p className="mt-2 text-sm text-foreground">
                  A healthy retry should create a row in <code>user_push_tokens</code>.
                </p>
              </SurfaceInset>
              <SurfaceInset className="p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Firebase Console
                </p>
                <p className="mt-2 text-sm text-foreground">
                  Check the active project&apos;s Cloud Messaging web configuration and
                  use the project-specific VAPID key.
                </p>
              </SurfaceInset>
            </div>
          ) : null}
        </ContentSurface>
      ) : null}

      {actor === "investor" &&
      center?.self_activity_summary &&
      (center.self_activity_summary.active_sessions > 0 ||
        center.self_activity_summary.recent.length > 0) ? (
        <ContentSurface className="space-y-3" accent="violet">
          <SectionHeader
            eyebrow="Self activity"
            title="Your own vault activity stays separate"
            description="Self-issued vault sessions and Kai operations stay out of the external consent ledger, but you can still see a short summary here."
            icon={Activity}
          />
          <div className="grid gap-3 px-5 pb-5 md:grid-cols-3">
            <SurfaceInset className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Active sessions
              </p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {center.self_activity_summary.active_sessions}
              </p>
            </SurfaceInset>
            <SurfaceInset className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Last 24 hours
              </p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {center.self_activity_summary.recent_operations_24h}
              </p>
            </SurfaceInset>
            <SurfaceInset className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Latest activity
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">
                {formatDate(center.self_activity_summary.last_activity_at) || "No recent activity"}
              </p>
            </SurfaceInset>
          </div>
          {center.self_activity_summary.recent.length > 0 ? (
            <div className="divide-y divide-border/60">
              {center.self_activity_summary.recent.slice(0, 3).map((item) => (
                <div key={item.id} className="px-5 py-4">
                  <p className="text-sm font-medium text-foreground">
                    {item.scope_description || item.action}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(item.issued_at) || "Recent"}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </ContentSurface>
      ) : null}

      <div className="space-y-3">
        <SectionHeader
          eyebrow={actor === "ria" ? "RIA" : "Investor"}
          title={`${SURFACE_VIEW_LABELS[surfaceView]} log`}
          icon={
            surfaceView === "pending"
              ? Shield
              : surfaceView === "active"
                ? BadgeCheck
                : History
          }
          description={
            surfaceView === "pending"
              ? actor === "ria"
                ? "Outgoing requests and invite handshakes that still need investor action."
                : "Requests that still need an investor decision before data access can proceed."
              : surfaceView === "active"
                ? "Access that is currently live under the consent ledger."
                : "Historical approvals, denials, revokes, and expired access records."
          }
        />

        <ContentSurface className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
              <Icon icon={Loader2} size="sm" className="animate-spin" />
              Loading consent log...
            </div>
          ) : null}

          {error ? <p className="px-5 py-6 text-sm text-red-500">{error}</p> : null}

          {!loading && !error && !hasVisibleEntries ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">
              {emptyStateCopy(actor, surfaceView)}
            </div>
          ) : null}

          {!loading && !error && hasVisibleEntries ? (
            <div className="divide-y divide-border/60">
              {actor === "investor"
                ? visibleGroups.map((group) => {
                    const groupedBundles =
                      surfaceView === "pending"
                        ? groupConsentBundles(group.entries.filter((entry) => isBundledEntry(entry)))
                        : [];
                    const groupedEntries =
                      surfaceView === "pending"
                        ? group.entries.filter((entry) => !isBundledEntry(entry))
                        : group.entries;

                    return (
                      <div key={group.id} className="space-y-4 px-5 py-5">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-foreground">
                                {group.counterpart_label || "Requester"}
                              </p>
                              <Badge className={statusTone(String(group.status || "pending"))}>
                                {String(group.status || "pending").replace(/_/g, " ")}
                              </Badge>
                              <Badge variant="secondary">{group.request_count} request(s)</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Latest request received {formatDate(group.latest_request_at) || "recently"}.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {group.scopes.slice(0, 4).map((scope) => (
                                <Badge key={`${group.id}-${scope}`} variant="secondary">
                                  {scope}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          {groupedBundles.map(renderBundleCard)}
                          {groupedEntries.length > 0 ? (
                            <SurfaceInset className="divide-y divide-border/60 p-0">
                              {groupedEntries.map(renderEntryRow)}
                            </SurfaceInset>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                : (
                  <>
                    {pendingBundleGroups.map(renderBundleCard)}
                    {listEntries.map(renderEntryRow)}
                  </>
                )}
            </div>
          ) : null}
        </ContentSurface>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className={cn("space-y-5", className)}>
        <div className="flex justify-end">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => void loadCenter({ force: true, silent: true })}
              disabled={refreshing}
            >
              <Icon icon={RefreshCw} size="sm" className={refreshing ? "mr-2 animate-spin" : "mr-2"} />
              Refresh
            </Button>
        </div>
        {content}
      </div>
    );
  }

  return (
    <AppPageShell
      as="div"
      width="content"
      className={cn("pb-6 md:pb-8", className)}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow={actor === "ria" ? "Consent Workspace" : "Consent Center"}
          title={
            actor === "ria"
              ? "Outgoing requests, invites, and live advisor access"
              : "Pending, active, and previous Kai access"
          }
          description={
            actor === "ria"
              ? "Use the shared consent workspace to send request bundles, track investor decisions, and open ready workspaces without leaving the main shell."
              : "One place to review pending approvals, active grants, and the full consent log for the current persona."
          }
          icon={ClipboardList}
          actions={
            <Button
              variant="none"
              effect="fade"
              size="default"
              onClick={() => void loadCenter({ force: true, silent: true })}
              disabled={refreshing}
            >
              <Icon icon={RefreshCw} size="sm" className={refreshing ? "mr-2 animate-spin" : "mr-2"} />
              Refresh
            </Button>
          }
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceStack>{content}</SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

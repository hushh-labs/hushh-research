"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ContactRound,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LocateFixed,
  MapPin,
  Navigation,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  Send,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useRequireAuth } from "@/hooks/use-auth";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureLocationRecipientKey,
} from "@/lib/one-location/encryption";
import {
  buildOneLocationNotificationHref,
  isOneLocationGrantOpened,
  locationShareNotificationDescription,
  markOneLocationGrantOpened,
  ONE_LOCATION_GRANT_ID_PARAM,
  ONE_LOCATION_GRANT_OPENED_EVENT,
  ONE_LOCATION_NOTIFICATION_OPEN_PARAM,
  ONE_LOCATION_NOTIFICATION_OPEN_VALUE,
  playOneLocationNotificationSound,
  recordOneLocationShareNotification,
} from "@/lib/one-location/notifications";
import { OneLocationService } from "@/lib/one-location/service";
import {
  syncOneLocationContactSignals,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import { OneLocationActivityDashboard } from "@/components/one-location/activity-dashboard";
import { buildOneLocationActivityFallback } from "@/lib/one-location/activity";
import type {
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecommendationReason,
  OneLocationRecipient,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { toDurationBucket, trackEvent } from "@/lib/observability/client";
import { useVault } from "@/lib/vault/vault-context";
import { cn } from "@/lib/utils";

const DURATION_OPTIONS = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;
const LIVE_LOCATION_STALE_THRESHOLD_MS = LIVE_LOCATION_UPDATE_INTERVAL_MS * 3;
const FOREGROUND_RETRY_DELAYS_MS = [450, 900] as const;

type BusyState =
  | "load"
  | "share"
  | "publish"
  | "view"
  | "request"
  | "approve"
  | "deny"
  | "refer"
  | "revoke"
  | "contactSync"
  | "contactInvite"
  | "publicInvite"
  | "publicRevoke"
  | null;

type KaiCircleSectionKey =
  | "needs_action"
  | "trusted_circle"
  | "professional_network"
  | "location_ready"
  | "needs_setup";

type KaiCircleSection = {
  key: KaiCircleSectionKey;
  title: string;
  description: string;
  recipients: OneLocationRecipient[];
};

type OneLocationSelectionSurface =
  | "quick_circle"
  | "section_list"
  | "select_menu";

type OneLocationDurationBucket = "15m" | "30m" | "1h" | "4h" | "24h" | "custom";
type OneLocationForegroundOperation = "publish" | "view";
type OneLocationForegroundTrigger = "manual" | "foreground_interval";
type OneLocationBackoffBucket =
  | "none"
  | "lt_500ms"
  | "500ms_1s"
  | "1s_3s"
  | "gte_3s";

type OneLocationContactSignalStatus =
  | "idle"
  | "scanning"
  | "matched"
  | "empty"
  | "unavailable"
  | "denied"
  | "error";

type OneLocationContactSignalState = {
  status: OneLocationContactSignalStatus;
  matchedUserIds: string[];
  matchedCount: number;
  totalContacts: number;
  inviteCandidateCount: number;
  sourcePlatform?: OneLocationContactSignalResult["sourcePlatform"];
  error?: string | null;
  syncedAt?: string | null;
};

const INITIAL_CONTACT_SIGNAL_STATE: OneLocationContactSignalState = {
  status: "idle",
  matchedUserIds: [],
  matchedCount: 0,
  totalContacts: 0,
  inviteCandidateCount: 0,
  error: null,
  syncedAt: null,
};

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function expiresLabel(grant: OneLocationGrant): string {
  if (grant.status === "revoked") return "Revoked";
  if (grant.status === "expired") return "Expired";
  return `Expires ${formatDateTime(grant.expiresAt)}`;
}

function safePersonLabel(value?: string | null, fallback = "KAI member"): string {
  return String(value || "").trim() || fallback;
}

function recipientLabel(recipient: OneLocationRecipient): string {
  return safePersonLabel(recipient.displayName);
}

function recommendationTierLabel(tier?: string | null): string {
  switch (tier) {
    case "needs_action":
      return "Needs action";
    case "trusted_circle":
      return "Trusted Circle";
    case "kai_network":
      return "KAI Network";
    case "contacts":
      return "Contact match";
    case "setup_needed":
      return "Setup needed";
    case "available":
      return "Ready";
    default:
      return "KAI Circle";
  }
}

function recommendationToneClassName(tier?: string | null): string {
  switch (tier) {
    case "needs_action":
    case "setup_needed":
      return "bg-[#fff3e6] text-[#9a5a00] dark:bg-orange-400/15 dark:text-orange-200";
    case "trusted_circle":
      return "bg-[#eaf9ef] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200";
    case "kai_network":
      return "bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]";
    default:
      return "bg-[#f2f2f7] text-[#636366] dark:bg-white/10 dark:text-white/65";
  }
}

function visibleRecommendationReasons(
  recipient: OneLocationRecipient,
): OneLocationRecommendationReason[] {
  return (recipient.recommendationReasons ?? [])
    .filter((reason) => reason.code && reason.label)
    .slice(0, 2);
}

function recipientRecommendationLine(recipient: OneLocationRecipient): string {
  return (
    recipient.recommendationSummary ||
    visibleRecommendationReasons(recipient)[0]?.label ||
    (recipient.canReceiveLocation
      ? "Ready for encrypted location access"
      : "Needs a recipient key")
  );
}

function recommendationCategoryLabel(recipient: OneLocationRecipient): string {
  return (
    recipient.recommendationCategoryLabel ||
    recommendationTierLabel(recipient.recommendationTier)
  );
}

function recommendationSearchText(recipient: OneLocationRecipient): string {
  return [
    recipientLabel(recipient),
    recipient.profileHeadline,
    recipient.relationshipType,
    recipient.recommendationSummary,
    recipient.recommendationCategory,
    recommendationCategoryLabel(recipient),
    ...(recipient.recommendationReasons ?? []).map((reason) => reason.label),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function rankRecipientsForRecommendation(
  recipients: OneLocationRecipient[],
  contactMatchedUserIds: Set<string> = new Set(),
): OneLocationRecipient[] {
  if (contactMatchedUserIds.size > 0) {
    return [...recipients].sort((a, b) => {
      const aScore =
        (a.recommendationScore ?? 0) +
        (contactMatchedUserIds.has(a.userId) ? 8 : 0);
      const bScore =
        (b.recommendationScore ?? 0) +
        (contactMatchedUserIds.has(b.userId) ? 8 : 0);
      if (aScore !== bScore) return bScore - aScore;
      const aRank = a.recommendationRank ?? Number.MAX_SAFE_INTEGER;
      const bRank = b.recommendationRank ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      if (a.canReceiveLocation !== b.canReceiveLocation) {
        return a.canReceiveLocation ? -1 : 1;
      }
      return recipientLabel(a).localeCompare(recipientLabel(b));
    });
  }

  return [...recipients].sort((a, b) => {
    const aRank = a.recommendationRank ?? Number.MAX_SAFE_INTEGER;
    const bRank = b.recommendationRank ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    const aScore = a.recommendationScore ?? 0;
    const bScore = b.recommendationScore ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    if (a.canReceiveLocation !== b.canReceiveLocation) {
      return a.canReceiveLocation ? -1 : 1;
    }
    return recipientLabel(a).localeCompare(recipientLabel(b));
  });
}

function enrichRecipientsWithContactSignal(
  recipients: OneLocationRecipient[],
  contactMatchedUserIds: Set<string>,
): OneLocationRecipient[] {
  if (contactMatchedUserIds.size === 0) return recipients;

  return recipients.map((recipient) => {
    if (!contactMatchedUserIds.has(recipient.userId)) return recipient;
    const reasons = recipient.recommendationReasons ?? [];
    const hasContactReason = reasons.some(
      (reason) => reason.code === "mobile_contact_signal",
    );
    return {
      ...recipient,
      recommendationTier: recipient.recommendationTier || "contacts",
      recommendationReasons: hasContactReason
        ? reasons
        : [
            { code: "mobile_contact_signal", label: "In your contacts" },
            ...reasons,
          ],
      recommendationSummary:
        recipient.recommendationSummary ||
        "Matched from your private mobile contact scan",
    };
  });
}

function recipientSelectionFromIds(
  recipients: OneLocationRecipient[],
  selectedIds: string[],
): OneLocationRecipient[] {
  const recipientById = new Map(
    recipients.map((recipient) => [recipient.userId, recipient]),
  );
  return selectedIds
    .map((recipientId) => recipientById.get(recipientId))
    .filter((recipient): recipient is OneLocationRecipient => Boolean(recipient));
}

function addSelectedId(selectedIds: string[], recipientId: string): string[] {
  if (selectedIds.includes(recipientId)) return selectedIds;
  return [...selectedIds, recipientId];
}

function toggleSelectedId(
  selectedIds: string[],
  recipientId: string,
): string[] {
  if (selectedIds.includes(recipientId)) {
    return selectedIds.filter((selectedId) => selectedId !== recipientId);
  }
  return [...selectedIds, recipientId];
}

type ShareReadyRecipient = OneLocationRecipient & {
  keyId: string;
  publicKeyJwk: JsonWebKey;
};

function isShareReadyRecipient(
  recipient: OneLocationRecipient,
): recipient is ShareReadyRecipient {
  return Boolean(
    recipient.canReceiveLocation &&
      recipient.keyId &&
      recipient.publicKeyJwk,
  );
}

function peopleCountLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

const KAI_CIRCLE_SECTION_META: Record<
  KaiCircleSectionKey,
  Pick<KaiCircleSection, "title" | "description">
> = {
  needs_action: {
    title: "Needs your approval",
    description: "Requests and people waiting on a decision.",
  },
  trusted_circle: {
    title: "Trusted Circle",
    description: "People with active sharing, history, or referrals.",
  },
  professional_network: {
    title: "Professional Network",
    description: "RIA, investor, advisor, and marketplace signals.",
  },
  location_ready: {
    title: "Location-ready KAI members",
    description: "Verified KAI members ready for encrypted sharing.",
  },
  needs_setup: {
    title: "Needs setup",
    description: "People who need to open One Location once.",
  },
};

const KAI_CIRCLE_SECTION_EMPTY_COPY: Record<
  KaiCircleSectionKey,
  { title: string; description: string }
> = {
  needs_action: {
    title: "No approvals waiting",
    description: "New location requests and pending decisions will appear here.",
  },
  trusted_circle: {
    title: "No trusted matches yet",
    description:
      "Active shares, repeat approvals, and referrals will lift people here.",
  },
  professional_network: {
    title: "No professional signals yet",
    description: "RIA, investor, advisor, and marketplace matches will appear here.",
  },
  location_ready: {
    title: "No ready KAI members yet",
    description: "Verified KAI members with location keys will appear here.",
  },
  needs_setup: {
    title: "No setup blockers",
    description: "Everyone in this section is ready enough for the current flow.",
  },
};

const KAI_CIRCLE_SECTION_ORDER: KaiCircleSectionKey[] = [
  "needs_action",
  "trusted_circle",
  "professional_network",
  "location_ready",
  "needs_setup",
];

function kaiCircleSectionKey(
  recipient: OneLocationRecipient,
): KaiCircleSectionKey {
  switch (recipient.recommendationCategory) {
    case "needs_action":
    case "trusted_circle":
    case "professional_network":
    case "location_ready":
    case "needs_setup":
      return recipient.recommendationCategory;
  }

  if (!recipient.canReceiveLocation) return "needs_setup";
  switch (recipient.recommendationTier) {
    case "needs_action":
      return "needs_action";
    case "trusted_circle":
      return "trusted_circle";
    case "kai_network":
      return "professional_network";
    default:
      if (
        recipient.relationshipType ||
        recipient.profileHeadline ||
        recipient.verificationBadge
      ) {
        return "professional_network";
      }
      return "location_ready";
  }
}

function buildKaiCircleSections(
  recipients: OneLocationRecipient[],
): KaiCircleSection[] {
  const grouped = new Map<KaiCircleSectionKey, OneLocationRecipient[]>();
  KAI_CIRCLE_SECTION_ORDER.forEach((key) => grouped.set(key, []));

  recipients.forEach((recipient) => {
    grouped.get(kaiCircleSectionKey(recipient))?.push(recipient);
  });

  return KAI_CIRCLE_SECTION_ORDER.map((key) => {
    const meta = KAI_CIRCLE_SECTION_META[key];
    return {
      key,
      title: meta.title,
      description: meta.description,
      recipients: grouped.get(key) ?? [],
    };
  });
}

function oneLocationDurationBucket(value: string): OneLocationDurationBucket {
  switch (value) {
    case "0.25":
      return "15m";
    case "0.5":
      return "30m";
    case "1":
      return "1h";
    case "4":
      return "4h";
    case "24":
      return "24h";
    default:
      return "custom";
  }
}

function oneLocationEventResult(
  successCount: number,
  failureCount: number,
): "success" | "error" {
  return successCount > 0 && failureCount === 0 ? "success" : "error";
}

function contactCountBucket(
  count: number,
): "0" | "1_10" | "11_50" | "51_250" | "251_plus" {
  if (count <= 0) return "0";
  if (count <= 10) return "1_10";
  if (count <= 50) return "11_50";
  if (count <= 250) return "51_250";
  return "251_plus";
}

function contactSignalStatusLabel(status: OneLocationContactSignalStatus): string {
  switch (status) {
    case "scanning":
      return "Scanning";
    case "matched":
      return "Signal active";
    case "empty":
      return "No matches yet";
    case "unavailable":
      return "Mobile only";
    case "denied":
      return "Permission needed";
    case "error":
      return "Needs retry";
    default:
      return "Optional signal";
  }
}

function contactSignalSummary(state: OneLocationContactSignalState): string {
  switch (state.status) {
    case "matched":
      return `${state.matchedCount} KAI match${
        state.matchedCount === 1 ? "" : "es"
      } added as a ranking signal.`;
    case "empty":
      return state.totalContacts > 0
        ? "No KAI users matched from this scan."
        : "No contact numbers were available to match.";
    case "unavailable":
      return "Open One on iOS or Android to scan contacts.";
    case "denied":
      return "Allow contacts to use this optional ranking signal.";
    case "error":
      return state.error || "Contact signal could not be refreshed.";
    case "scanning":
      return "Checking contacts privately on this device.";
    default:
      return "Contacts stay on-device; only hashed lookups are used for matching.";
  }
}

function grantCounterpartyLabel(grant: OneLocationGrant): string {
  return safePersonLabel(grant.recipientDisplayName);
}

function receivedGrantOwnerLabel(grant: OneLocationGrant): string {
  return safePersonLabel(
    grant.ownerDisplayName || grant.recipientDisplayName,
    "A trusted person",
  );
}

function requestLabel(request: OneLocationAccessRequest): string {
  return safePersonLabel(request.requesterDisplayName, "Someone from KAI");
}

function publicSubmissionLabel(
  submission: OneLocationPublicInviteSubmission,
): string {
  return safePersonLabel(submission.visitorDisplayName, "Public request");
}

function publicInviteUrlLabel(value: string): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (typeof window === "undefined") return value;
  return new URL(value, window.location.origin).toString();
}

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "approved") return "default";
  if (status === "revoked" || status === "denied") return "destructive";
  if (status === "expired" || status === "cancelled") return "secondary";
  return "outline";
}

function isTransientOneApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 502 || status === 503 || status === 504;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function oneLocationBackoffBucket(delayMs: number): OneLocationBackoffBucket {
  if (delayMs <= 0) return "none";
  if (delayMs < 500) return "lt_500ms";
  if (delayMs < 1000) return "500ms_1s";
  if (delayMs < 3000) return "1s_3s";
  return "gte_3s";
}

function oneLocationFailureClass(error: unknown): string {
  if (isTransientOneApiError(error)) return "one_api_unavailable";
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "").toLowerCase()
      : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String((error as { message?: unknown })?.message || error || "").toLowerCase();
  if (name === "aborterror" || message.includes("abort")) return "aborted";
  if (message.includes("network") || message.includes("fetch")) return "network";
  if (message.includes("permission") || message.includes("location")) return "permission";
  if (
    message.includes("key") ||
    message.includes("encrypt") ||
    message.includes("decrypt")
  ) {
    return "encryption";
  }
  return "unknown";
}

function isRetryableForegroundError(error: unknown): boolean {
  const failureClass = oneLocationFailureClass(error);
  return failureClass === "one_api_unavailable" || failureClass === "network";
}

async function runOneLocationForegroundAttempt<T>(params: {
  operation: OneLocationForegroundOperation;
  trigger: OneLocationForegroundTrigger;
  task: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  let attemptIndex = 0;

  for (;;) {
    try {
      return await params.task();
    } catch (error) {
      const retryDelayMs = FOREGROUND_RETRY_DELAYS_MS[attemptIndex] ?? 0;
      const shouldRetry =
        retryDelayMs > 0 && isRetryableForegroundError(error);
      const retryCount = shouldRetry
        ? attemptIndex + 1
        : Math.min(attemptIndex, FOREGROUND_RETRY_DELAYS_MS.length);

      trackEvent("one_location_foreground_retry", {
        route_id: "one_location",
        operation: params.operation,
        trigger: params.trigger,
        result: shouldRetry ? "expected_error" : "error",
        attempt_count: attemptIndex + 1,
        retry_count: retryCount,
        backoff_bucket: oneLocationBackoffBucket(retryDelayMs),
        duration_ms_bucket: toDurationBucket(Date.now() - startedAt),
        error_class: oneLocationFailureClass(error),
      });

      if (!shouldRetry) {
        throw error;
      }

      attemptIndex += 1;
      await wait(retryDelayMs);
    }
  }
}

function oneLocationErrorMessage(error: unknown, fallback: string): string {
  if (isTransientOneApiError(error)) {
    return "One is still catching up. Please refresh once, then check this page before retrying.";
  }
  return error instanceof Error ? error.message : fallback;
}

function isLocationPointStale(point: PlainLocationPoint): boolean {
  const capturedAt = new Date(point.capturedAt).getTime();
  if (!Number.isFinite(capturedAt)) return false;
  return Date.now() - capturedAt > LIVE_LOCATION_STALE_THRESHOLD_MS;
}

function formatLocationCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

function locationCoordinateQuery(point: PlainLocationPoint): string {
  return [
    formatLocationCoordinate(point.latitude),
    formatLocationCoordinate(point.longitude),
  ].join(",");
}

function googleMapsLocationEmbedUrl(point: PlainLocationPoint): string {
  const query = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps?q=${query}&z=16&output=embed`;
}

function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

function googleMapsStartNavigationUrl(point: PlainLocationPoint): string {
  return `${googleMapsDirectionsUrl(point)}&dir_action=navigate`;
}

function locationAccuracyLabel(point: PlainLocationPoint): string | null {
  const accuracyM = point.accuracyM;
  if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    return null;
  }
  if (accuracyM >= 1000) {
    const kilometers = accuracyM / 1000;
    return `Accuracy +/- ${kilometers >= 10 ? Math.round(kilometers) : kilometers.toFixed(1)} km`;
  }
  return `Accuracy +/- ${Math.round(accuracyM)} m`;
}

function locationSourceLabel(sourcePlatform: PlainLocationPoint["sourcePlatform"]): string {
  switch (sourcePlatform) {
    case "ios":
      return "iOS";
    case "android":
      return "Android";
    case "native":
      return "Native";
    case "web":
      return "Web";
    default:
      return "Location";
  }
}

function LocalMapPreview({ point }: { point: PlainLocationPoint }) {
  const captured = formatDateTime(point.capturedAt);
  const isStale = isLocationPointStale(point);
  const accuracy = locationAccuracyLabel(point);
  const embedUrl = googleMapsLocationEmbedUrl(point);
  const directionsUrl = googleMapsDirectionsUrl(point);
  const startUrl = googleMapsStartNavigationUrl(point);
  const statusLabel = isStale ? "Last known location" : "Live location";
  return (
    <div className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-56 overflow-hidden bg-[#e5e5ea] dark:bg-[#111113]">
        <iframe
          title="Live location map preview"
          src={embedUrl}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className="h-full w-full border-0"
        />
        <div className="pointer-events-none absolute left-3 top-3">
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-semibold shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-xl",
              isStale
                ? "border-amber-400/40 bg-amber-950/70 text-amber-50"
                : "border-emerald-300/40 bg-emerald-950/70 text-emerald-50",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isStale ? "bg-amber-300" : "animate-pulse bg-emerald-300",
              )}
              aria-hidden="true"
            />
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-foreground">
            {statusLabel}
          </p>
          <p className="mt-1 text-[12px] font-medium text-muted-foreground">
            Updated {captured}
            {accuracy ? ` - ${accuracy}` : ""} -{" "}
            {locationSourceLabel(point.sourcePlatform)}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-10 rounded-full border-[#0a84ff]/30 bg-[#0a84ff]/10 text-[#0066cc] hover:bg-[#0a84ff]/15 dark:text-[#76b7ff]"
          >
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Google Maps directions to shared live location"
            >
              <Route className="h-4 w-4" aria-hidden="true" />
              Directions
            </a>
          </Button>
          <Button
            asChild
            size="sm"
            className="h-10 rounded-full bg-[#1c1c1e] text-white hover:bg-black dark:bg-white dark:text-[#1c1c1e] dark:hover:bg-white/90"
          >
            <a
              href={startUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Start Google Maps navigation to shared live location"
            >
              <Navigation className="h-4 w-4" aria-hidden="true" />
              Start
            </a>
          </Button>
        </div>
      </div>

      {isStale ? (
        <div
          role="status"
          className="mx-3 mb-3 flex items-start gap-2 rounded-[12px] border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[12px] font-medium text-amber-800 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Location update may be stale. Ask them to refresh sharing.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  busy,
  busyKey,
  children,
  ...props
}: ComponentProps<typeof Button> & { busy: BusyState; busyKey: BusyState }) {
  return (
    <Button {...props} disabled={props.disabled || busy === busyKey}>
      {busy === busyKey ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </Button>
  );
}

function SkeletonRow({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-20 items-center gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
      <Skeleton className="h-9 w-9 shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className={wide ? "h-4 w-2/3" : "h-4 w-40"} />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
      <Skeleton className="hidden h-8 w-20 rounded-full sm:block" />
    </div>
  );
}

type ShareMode = "share" | "request";

const onePanelClassName =
  "overflow-hidden rounded-[20px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_38px_rgba(0,0,0,0.28)]";
const oneInsetClassName =
  "rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white";
const oneSecondaryTextClassName = "text-[#8e8e93] dark:text-white/55";

function sectionLabel(title: string, count?: number) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45"
    >
      {title}
      {typeof count === "number" && count > 0 ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[10px] font-bold text-white">
          {count}
        </span>
      ) : null}
    </div>
  );
}

function displayNameFromRecipient(recipient: OneLocationRecipient): string {
  return recipientLabel(recipient);
}

function initialsForLabel(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] || "";
    const second = words[1]?.[0] || "";
    return `${first}${second}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "?").toUpperCase();
}

function avatarColor(index: number): string {
  const colors = [
    "bg-[#007aff]",
    "bg-[#34c759]",
    "bg-[#5856d6]",
    "bg-[#ff9500]",
    "bg-[#ff3b30]",
  ];
  return colors[index % colors.length] || "bg-[#007aff]";
}

function AvatarBubble({
  label,
  index,
  size = "md",
  muted = false,
}: {
  label: string;
  index: number;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase",
        size === "sm" && "h-9 w-9 text-[15px]",
        size === "md" && "h-[52px] w-[52px] text-[18px]",
        size === "lg" && "h-11 w-11 text-[17px]",
        muted
          ? "bg-[#e5e5ea] text-[#8e8e93] dark:bg-white/10 dark:text-white/55"
          : `${avatarColor(index)} text-white`,
      )}
      aria-hidden="true"
    >
      {initialsForLabel(label)}
    </span>
  );
}

function PromiseCard({
  icon: Icon,
  title,
  description,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone: "blue" | "green" | "orange";
}) {
  const toneClassName = {
    blue: "bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]",
    green:
      "bg-[#eaf9ef] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200",
    orange:
      "bg-[#fff3e6] text-[#ff9500] dark:bg-orange-400/15 dark:text-orange-200",
  }[tone];

  return (
    <div className="flex items-center gap-4 rounded-[20px] border border-black/[0.06] bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
          toneClassName,
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[16px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
          {title}
        </h3>
        <p className="mt-1 text-[14px] font-medium leading-snug text-[#8e8e93] dark:text-white/55">
          {description}
        </p>
      </div>
    </div>
  );
}

function SegmentedModeControl({
  value,
  onChange,
}: {
  value: ShareMode;
  onChange: (value: ShareMode) => void;
}) {
  return (
    <div className="flex h-9 w-full items-center rounded-[9px] bg-[#efeff0] p-[3px] dark:bg-white/10">
      {(["share", "request"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            "h-full flex-1 rounded-[7px] text-[13px] capitalize transition-all",
            value === mode
              ? "bg-white font-semibold text-[#1c1c1e] shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#2c2c2e] dark:text-white"
              : "font-medium text-[#8e8e93] hover:text-[#1c1c1e] dark:text-white/50 dark:hover:text-white",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function EmptyOneState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-24 items-center gap-3 p-3.5 text-sm">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="font-semibold text-[#1c1c1e] dark:text-white">
          {title}
        </div>
        <div className="text-[13px] leading-5 text-[#8e8e93] dark:text-white/55">
          {description}
        </div>
      </div>
    </div>
  );
}

function OneLocationInitialSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="space-y-6">
        <SettingsGroup eyebrow="Device" title="Readiness">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </SettingsGroup>
        <SettingsGroup eyebrow="Share" title="Share with trusted person">
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-11 rounded-xl" />
            </div>
            <Skeleton className="h-10 w-56 rounded-xl" />
          </div>
        </SettingsGroup>
        <SettingsGroup eyebrow="Request" title="Ask someone to share">
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <Skeleton className="h-11 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-10 w-40 rounded-xl" />
          </div>
        </SettingsGroup>
      </div>
      <div className="space-y-6">
        <SettingsGroup eyebrow="Owner" title="People who can see me">
          <SkeletonRow wide />
          <SkeletonRow />
        </SettingsGroup>
        <SettingsGroup eyebrow="Recipient" title="Shared with me">
          <SkeletonRow wide />
        </SettingsGroup>
        <SettingsGroup eyebrow="Approvals" title="Pending requests">
          <SkeletonRow />
        </SettingsGroup>
      </div>
    </div>
  );
}

export function OneLocationAgentPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useRequireAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [state, setState] = useState<OneLocationState | null>(null);
  const [permission, setPermission] =
    useState<HushhLocationPermissionState | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<ShareMode>("share");
  const [shareReviewOpen, setShareReviewOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [selectedRecipientId, setSelectedRecipientId] = useState("");
  const [selectedRequestOwnerId, setSelectedRequestOwnerId] = useState("");
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>(
    [],
  );
  const [selectedRequestOwnerIds, setSelectedRequestOwnerIds] = useState<
    string[]
  >([]);
  const [contactSignal, setContactSignal] =
    useState<OneLocationContactSignalState>(INITIAL_CONTACT_SIGNAL_STATE);
  const [activityRange, setActivityRange] =
    useState<OneLocationActivityRange>("30d");
  const [activitySnapshot, setActivitySnapshot] =
    useState<OneLocationActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [durationHours, setDurationHours] = useState("1");
  const [requestMessage, setRequestMessage] = useState("");
  const [referralTargets, setReferralTargets] = useState<
    Record<string, string>
  >({});
  const [publicInviteUrl, setPublicInviteUrl] = useState("");
  const [decryptedPoints, setDecryptedPoints] = useState<
    Record<string, PlainLocationPoint>
  >({});
  const [openedGrantTick, setOpenedGrantTick] = useState(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const livePublishInFlightRef = useRef(false);
  const liveViewInFlightRef = useRef(false);

  const recipients = useMemo(
    () => state?.recipients ?? [],
    [state?.recipients],
  );
  const contactMatchedUserIds = useMemo(
    () => new Set(contactSignal.matchedUserIds),
    [contactSignal.matchedUserIds],
  );
  const contactSignalRecipients = useMemo(
    () => enrichRecipientsWithContactSignal(recipients, contactMatchedUserIds),
    [contactMatchedUserIds, recipients],
  );
  const rankedRecipients = useMemo(
    () =>
      rankRecipientsForRecommendation(
        contactSignalRecipients,
        contactMatchedUserIds,
      ),
    [contactMatchedUserIds, contactSignalRecipients],
  );
  const visibleRecipients = useMemo(() => {
    const query = recipientSearch.trim().toLowerCase();
    if (!query) return rankedRecipients;
    return rankedRecipients.filter((recipient) =>
      recommendationSearchText(recipient).includes(query),
    );
  }, [rankedRecipients, recipientSearch]);
  const kaiCircleSections = useMemo(
    () => buildKaiCircleSections(visibleRecipients),
    [visibleRecipients],
  );
  const selectedShareRecipients = useMemo(
    () => recipientSelectionFromIds(contactSignalRecipients, selectedRecipientIds),
    [contactSignalRecipients, selectedRecipientIds],
  );
  const shareReadySelectedRecipients = useMemo(
    () => selectedShareRecipients.filter(isShareReadyRecipient),
    [selectedShareRecipients],
  );
  const setupNeededSelectedRecipients = useMemo(
    () =>
      selectedShareRecipients.filter(
        (recipient) => !isShareReadyRecipient(recipient),
      ),
    [selectedShareRecipients],
  );
  const selectedRequestOwners = useMemo(
    () =>
      recipientSelectionFromIds(contactSignalRecipients, selectedRequestOwnerIds),
    [contactSignalRecipients, selectedRequestOwnerIds],
  );
  const pendingOwnerRequests = useMemo(
    () =>
      (state?.requests ?? []).filter(
        (request) =>
          request.ownerUserId === auth.userId && request.status === "pending",
      ),
    [auth.userId, state?.requests],
  );
  const requestedByMe = useMemo(
    () =>
      (state?.requests ?? []).filter(
        (request) =>
          request.requesterUserId === auth.userId &&
          request.ownerUserId !== auth.userId,
      ),
    [auth.userId, state?.requests],
  );
  const visibleReceivedGrants = useMemo(() => {
    void openedGrantTick;
    return (state?.receivedGrants ?? []).filter((grant) =>
      isOneLocationGrantOpened(auth.userId, grant.id),
    );
  }, [auth.userId, openedGrantTick, state?.receivedGrants]);
  const activeOwnerGrants = useMemo(
    () =>
      (state?.ownerGrants ?? []).filter((grant) => grant.status === "active"),
    [state?.ownerGrants],
  );
  const activeVisibleReceivedGrants = useMemo(
    () => visibleReceivedGrants.filter((grant) => grant.status === "active"),
    [visibleReceivedGrants],
  );
  const hiddenReceivedGrantCount = (state?.receivedGrants ?? []).filter(
    (grant) =>
      grant.status === "active" &&
      !isOneLocationGrantOpened(auth.userId, grant.id),
  ).length;
  const activePublicInvites = useMemo(
    () =>
      (state?.publicInvites ?? []).filter(
        (invite) => invite.status === "active",
      ),
    [state?.publicInvites],
  );
  const publicSubmissions = useMemo(
    () => state?.publicInviteSubmissions ?? [],
    [state?.publicInviteSubmissions],
  );
  const fallbackActivity = useMemo(
    () => buildOneLocationActivityFallback(state, auth.userId, activityRange),
    [activityRange, auth.userId, state],
  );
  const locationActivity = activitySnapshot ?? fallbackActivity;

  useEffect(() => {
    if (!auth.userId || !vaultOwnerToken || !state) {
      setActivitySnapshot(null);
      setActivityLoading(false);
      return;
    }
    let active = true;
    setActivityLoading(true);
    setActivityError(null);
    OneLocationService.getActivity({
      vaultOwnerToken,
      range: activityRange,
    })
      .then((activity) => {
        if (!active) return;
        setActivitySnapshot(activity);
      })
      .catch(() => {
        if (!active) return;
        setActivitySnapshot(null);
        setActivityError("Showing current page activity while history sync catches up.");
      })
      .finally(() => {
        if (active) setActivityLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activityRange, auth.userId, state, vaultOwnerToken]);

  const openLocationShareFromNotification = useCallback(
    (grantId: string) => {
      if (!auth.userId) return;
      markOneLocationGrantOpened(auth.userId, grantId);
      setOpenedGrantTick((value) => value + 1);
      router.push(buildOneLocationNotificationHref(grantId), { scroll: false });
    },
    [auth.userId, router],
  );

  const showLocationShareToast = useCallback(
    (grant: OneLocationGrant) => {
      if (!auth.userId) return;
      const ownerLabel = receivedGrantOwnerLabel(grant);
      const toastKey = `one-location-share:${grant.id}`;
      const description = locationShareNotificationDescription(ownerLabel);
      playOneLocationNotificationSound();
      toast(
        <div className="flex flex-col gap-2">
          <div className="space-y-0.5">
            <p className="line-clamp-1 text-sm font-semibold">
              Location shared
            </p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {description}
            </p>
          </div>
          <button
            onClick={() => {
              toast.dismiss(toastKey);
              openLocationShareFromNotification(grant.id);
            }}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors"
          >
            Open
          </button>
        </div>,
        {
          id: toastKey,
          duration: 10000,
          position: "top-center",
        },
      );
    },
    [auth.userId, openLocationShareFromNotification],
  );

  const refresh = useCallback(async () => {
    if (!auth.userId) {
      setBusy(null);
      setLoadError("Sign in before loading location sharing.");
      return;
    }
    if (!vaultOwnerToken) {
      setBusy(null);
      setLoadError(
        isVaultUnlocked
          ? "Vault owner token is still unavailable. Lock and unlock the vault, then refresh."
          : "Unlock your vault before loading location sharing.",
      );
      return;
    }
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }
    const activeUserId = auth.userId;
    const activeUser = auth.user;
    const activeVaultOwnerToken = vaultOwnerToken;
    setBusy((current) => current ?? "load");
    const task = (async () => {
      setLoadError(null);
      try {
        if (activeUser) {
          await AccountIdentityService.syncCurrentUser(activeUser).catch(
            (error) => {
              console.warn(
                "[OneLocationAgent] Identity shadow sync skipped:",
                error,
              );
              return null;
            },
          );
        }
        const key = await ensureLocationRecipientKey(activeUserId);
        await OneLocationService.registerRecipientKey({
          vaultOwnerToken: activeVaultOwnerToken,
          keyId: key.keyId,
          publicKeyJwk: key.publicKeyJwk,
          algorithm: key.algorithm,
        });
        const [nextPermission, nextState] = await Promise.all([
          OneLocationService.getPermissionState().catch(() => ({
            state: "unavailable" as const,
            precise: false,
            background: "unavailable" as const,
          })),
          OneLocationService.getState(activeVaultOwnerToken),
        ]);
        setPermission(nextPermission);
        setState(nextState);
        const rankedNextRecipients = rankRecipientsForRecommendation(
          enrichRecipientsWithContactSignal(
            nextState.recipients,
            contactMatchedUserIds,
          ),
          contactMatchedUserIds,
        );
        const firstRecommendedRecipient = rankedNextRecipients[0];
        const nextRecipientIds = new Set(
          nextState.recipients.map((recipient) => recipient.userId),
        );
        setSelectedRecipientId((current) =>
          current && nextRecipientIds.has(current)
            ? current
            : firstRecommendedRecipient?.userId || "",
        );
        setSelectedRequestOwnerId((current) =>
          current && nextRecipientIds.has(current)
            ? current
            : firstRecommendedRecipient?.userId || "",
        );
        setSelectedRecipientIds((current) => {
          const validSelectedIds = current.filter((recipientId) =>
            nextRecipientIds.has(recipientId),
          );
          return validSelectedIds.length
            ? validSelectedIds
            : firstRecommendedRecipient
              ? [firstRecommendedRecipient.userId]
              : [];
        });
        setSelectedRequestOwnerIds((current) => {
          const validSelectedIds = current.filter((recipientId) =>
            nextRecipientIds.has(recipientId),
          );
          return validSelectedIds.length
            ? validSelectedIds
            : firstRecommendedRecipient
              ? [firstRecommendedRecipient.userId]
              : [];
        });
      } catch (error) {
        setLoadError(
          oneLocationErrorMessage(error, "Could not load location sharing."),
        );
      } finally {
        refreshInFlightRef.current = null;
        setBusy(null);
      }
    })();
    refreshInFlightRef.current = task;
    return task;
  }, [
    auth.user,
    auth.userId,
    contactMatchedUserIds,
    isVaultUnlocked,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!auth.loading) {
      void refresh();
    }
  }, [auth.loading, refresh]);

  useEffect(() => {
    if (!auth.userId || typeof window === "undefined") return;
    const handleLocationNotification = (event: Event) => {
      const detail =
        (event as CustomEvent<Record<string, unknown>>).detail || {};
      const source = String(detail.source || "").trim();
      const notificationType = String(detail.notificationType || "").trim();
      if (
        source !== "one_location_notification" &&
        !notificationType.startsWith("location_")
      ) {
        return;
      }
      void refresh();
    };
    window.addEventListener(
      CONSENT_STATE_CHANGED_EVENT,
      handleLocationNotification,
    );
    return () => {
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        handleLocationNotification,
      );
    };
  }, [auth.userId, refresh]);

  useEffect(() => {
    if (!auth.userId) return;
    const grantId = String(
      searchParams.get(ONE_LOCATION_GRANT_ID_PARAM) || "",
    ).trim();
    const notificationState = String(
      searchParams.get(ONE_LOCATION_NOTIFICATION_OPEN_PARAM) || "",
    ).trim();
    if (grantId && notificationState === ONE_LOCATION_NOTIFICATION_OPEN_VALUE) {
      markOneLocationGrantOpened(auth.userId, grantId);
      setOpenedGrantTick((value) => value + 1);
    }
  }, [auth.userId, searchParams]);

  useEffect(() => {
    if (!auth.userId || typeof window === "undefined") return;
    const handleGrantOpened = (event: Event) => {
      const detail =
        (event as CustomEvent<{ userId?: string; grantId?: string }>).detail ||
        {};
      if (detail.userId && detail.userId !== auth.userId) return;
      setOpenedGrantTick((value) => value + 1);
    };
    window.addEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, handleGrantOpened);
    return () => {
      window.removeEventListener(
        ONE_LOCATION_GRANT_OPENED_EVENT,
        handleGrantOpened,
      );
    };
  }, [auth.userId]);

  useEffect(() => {
    if (!auth.userId || !state?.receivedGrants?.length) return;
    for (const grant of state.receivedGrants) {
      if (grant.status !== "active") continue;
      if (isOneLocationGrantOpened(auth.userId, grant.id)) continue;
      const created = recordOneLocationShareNotification({
        userId: auth.userId,
        grantId: grant.id,
        ownerLabel: receivedGrantOwnerLabel(grant),
        expiresAt: grant.expiresAt,
        durationHours: grant.durationHours,
      });
      if (created) {
        showLocationShareToast(grant);
      }
    }
  }, [
    auth.userId,
    openedGrantTick,
    showLocationShareToast,
    state?.receivedGrants,
  ]);

  const recipientForGrant = useCallback(
    (grant: OneLocationGrant) =>
      recipients.find(
        (recipient) =>
          recipient.userId === grant.recipientUserId &&
          recipient.keyId === grant.recipientKeyId,
      ) || null,
    [recipients],
  );

  const publishEnvelope = useCallback(
    async (
      grant: OneLocationGrant,
      recipient: OneLocationRecipient,
      pointOverride?: PlainLocationPoint,
    ) => {
      if (!vaultOwnerToken) throw new Error("Vault owner token required.");
      if (!recipient.publicKeyJwk || !recipient.keyId) {
        throw new Error("Recipient key unavailable.");
      }
      const point =
        pointOverride ?? (await OneLocationService.captureCurrentPosition());
      const envelope = await encryptLocationForRecipient({
        point,
        recipientPublicKeyJwk: recipient.publicKeyJwk,
        recipientKeyId: recipient.keyId,
      });
      await OneLocationService.storeEnvelope({
        vaultOwnerToken,
        grantId: grant.id,
        envelope,
      });
    },
    [vaultOwnerToken],
  );

  const publishEnvelopeWithRetry = useCallback(
    async (
      grant: OneLocationGrant,
      recipient: OneLocationRecipient,
      trigger: OneLocationForegroundTrigger,
      pointOverride?: PlainLocationPoint,
    ) =>
      runOneLocationForegroundAttempt({
        operation: "publish",
        trigger,
        task: () => publishEnvelope(grant, recipient, pointOverride),
      }),
    [publishEnvelope],
  );

  const handleShare = useCallback(async () => {
    if (
      !vaultOwnerToken ||
      !shareReadySelectedRecipients.length ||
      setupNeededSelectedRecipients.length ||
      permission?.state === "denied" ||
      permission?.state === "restricted" ||
      permission?.state === "unavailable"
    )
      return;
    setBusy("share");
    let successCount = 0;
    try {
      const point = await OneLocationService.captureCurrentPosition();
      for (const recipient of shareReadySelectedRecipients) {
        const grant = await OneLocationService.createGrant({
          vaultOwnerToken,
          recipientUserId: recipient.userId,
          recipientKeyId: recipient.keyId,
          durationHours: Number(durationHours),
        });
        await publishEnvelopeWithRetry(grant, recipient, "manual", point);
        successCount += 1;
      }
      trackEvent("one_location_share_confirmed", {
        route_id: "one_location",
        result: oneLocationEventResult(successCount, 0),
        selected_count: shareReadySelectedRecipients.length,
        success_count: successCount,
        failure_count: 0,
        duration_bucket: oneLocationDurationBucket(durationHours),
        review_required: shareReviewOpen,
      });
      toast.success(
        `Location shared with ${peopleCountLabel(
          shareReadySelectedRecipients.length,
        )}.`,
      );
      setShareReviewOpen(false);
      await refresh();
    } catch (error) {
      const failureCount =
        shareReadySelectedRecipients.length - successCount || 1;
      trackEvent("one_location_share_confirmed", {
        route_id: "one_location",
        result: oneLocationEventResult(successCount, failureCount),
        selected_count: shareReadySelectedRecipients.length,
        success_count: successCount,
        failure_count: failureCount,
        duration_bucket: oneLocationDurationBucket(durationHours),
        review_required: shareReviewOpen,
      });
      toast.error(
        error instanceof Error ? error.message : "Could not share location.",
      );
    } finally {
      setBusy(null);
    }
  }, [
    durationHours,
    permission?.state,
    publishEnvelopeWithRetry,
    refresh,
    setupNeededSelectedRecipients.length,
    shareReviewOpen,
    shareReadySelectedRecipients,
    vaultOwnerToken,
  ]);

  const handlePublish = useCallback(
    async (grant: OneLocationGrant) => {
      const recipient = recipientForGrant(grant);
      if (!recipient) {
        toast.error("Recipient key unavailable for this active share.");
        return;
      }
      setBusy("publish");
      try {
        await publishEnvelopeWithRetry(grant, recipient, "manual");
        toast.success("Encrypted location update published.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not publish update.",
        );
      } finally {
        setBusy(null);
      }
    },
    [publishEnvelopeWithRetry, recipientForGrant, refresh],
  );

  const viewGrantEnvelope = useCallback(
    async (
      grant: OneLocationGrant,
      options?: { silent?: boolean; trigger?: OneLocationForegroundTrigger },
    ) => {
      if (!auth.userId || !vaultOwnerToken) return;
      const activeUserId = auth.userId;
      const silent = Boolean(options?.silent);
      const trigger = options?.trigger ?? (silent ? "foreground_interval" : "manual");
      if (!silent) setBusy("view");
      try {
        const point = await runOneLocationForegroundAttempt({
          operation: "view",
          trigger,
          task: async () => {
            const response = await OneLocationService.viewEnvelope({
              vaultOwnerToken,
              grantId: grant.id,
            });
            return decryptLocationEnvelope({
              userId: activeUserId,
              envelope: response.envelope,
            });
          },
        });
        setDecryptedPoints((current) => ({ ...current, [grant.id]: point }));
      } catch (error) {
        if (!silent) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not view encrypted location.",
          );
        } else {
          console.warn(
            "[OneLocationAgent] Silent location refresh skipped:",
            error,
          );
        }
      } finally {
        if (!silent) setBusy(null);
      }
    },
    [auth.userId, vaultOwnerToken],
  );

  const handleView = useCallback(
    async (grant: OneLocationGrant) => {
      await viewGrantEnvelope(grant);
    },
    [viewGrantEnvelope],
  );

  useEffect(() => {
    if (!vaultOwnerToken || !activeOwnerGrants.length) return;
    if (busy && busy !== "load") return;
    if (
      permission?.state === "denied" ||
      permission?.state === "restricted" ||
      permission?.state === "unavailable"
    ) {
      return;
    }

    const publishActiveGrants = async () => {
      if (livePublishInFlightRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      livePublishInFlightRef.current = true;
      try {
        const point = await OneLocationService.captureCurrentPosition();
        for (const grant of activeOwnerGrants) {
          const recipient = recipientForGrant(grant);
          if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
          await publishEnvelopeWithRetry(
            grant,
            recipient,
            "foreground_interval",
            point,
          );
        }
      } catch (error) {
        console.warn(
          "[OneLocationAgent] Foreground live update skipped:",
          error,
        );
      } finally {
        livePublishInFlightRef.current = false;
      }
    };

    const interval = window.setInterval(
      () => void publishActiveGrants(),
      LIVE_LOCATION_UPDATE_INTERVAL_MS,
    );
    void publishActiveGrants();
    return () => window.clearInterval(interval);
  }, [
    activeOwnerGrants,
    busy,
    permission?.state,
    publishEnvelopeWithRetry,
    recipientForGrant,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!activeVisibleReceivedGrants.length) return;
    if (busy && busy !== "load") return;

    const refreshVisibleGrants = async () => {
      if (liveViewInFlightRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      liveViewInFlightRef.current = true;
      try {
        await Promise.allSettled(
          activeVisibleReceivedGrants.map((grant) =>
            viewGrantEnvelope(grant, {
              silent: true,
              trigger: "foreground_interval",
            }),
          ),
        );
      } finally {
        liveViewInFlightRef.current = false;
      }
    };

    void refreshVisibleGrants();
    const interval = window.setInterval(
      () => void refreshVisibleGrants(),
      LIVE_LOCATION_UPDATE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);

  const handleRevoke = useCallback(
    async (grantId: string) => {
      if (!vaultOwnerToken) return;
      setBusy("revoke");
      try {
        await OneLocationService.revokeGrant({ vaultOwnerToken, grantId });
        toast.success("Location access revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not revoke access.",
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleSyncContactSignal = useCallback(async () => {
    if (!auth.user?.getIdToken) {
      const message = "Sign in before syncing contacts.";
      setContactSignal((current) => ({
        ...current,
        status: "error",
        error: message,
      }));
      toast.error(message);
      return;
    }

    setBusy("contactSync");
    setContactSignal((current) => ({
      ...current,
      status: "scanning",
      error: null,
    }));

    try {
      const idToken = await auth.user.getIdToken();
      const result = await syncOneLocationContactSignals({ idToken });
      const nextStatus: OneLocationContactSignalStatus =
        result.matchedUserIds.length > 0 ? "matched" : "empty";
      setContactSignal({
        status: nextStatus,
        matchedUserIds: result.matchedUserIds,
        matchedCount: result.matchedUserIds.length,
        totalContacts: result.totalContacts,
        inviteCandidateCount: result.inviteCandidateCount,
        sourcePlatform: result.sourcePlatform,
        error: null,
        syncedAt: new Date().toISOString(),
      });
      trackEvent("one_location_contact_signal_synced", {
        route_id: "one_location",
        result: "success",
        source_platform: result.sourcePlatform,
        contact_count_bucket: contactCountBucket(result.totalContacts),
        matched_count: result.matchedUserIds.length,
        invite_candidate_count: result.inviteCandidateCount,
      });
      if (result.matchedUserIds.length > 0) {
        toast.success(
          `${peopleCountLabel(
            result.matchedUserIds.length,
          )} added as a contact signal.`,
        );
      } else {
        toast.info("No KAI users matched from this contact scan.");
      }
    } catch (error) {
      const message = oneLocationErrorMessage(
        error,
        "Could not sync contacts.",
      );
      const normalized = message.toLowerCase();
      const status: OneLocationContactSignalStatus =
        normalized.includes("denied") || normalized.includes("permission")
          ? "denied"
          : normalized.includes("native") ||
              normalized.includes("mobile") ||
              normalized.includes("unavailable") ||
              normalized.includes("web view")
            ? "unavailable"
            : "error";
      setContactSignal((current) => ({
        ...current,
        status,
        error: message,
        syncedAt: new Date().toISOString(),
      }));
      trackEvent("one_location_contact_signal_synced", {
        route_id: "one_location",
        result: status === "denied" || status === "unavailable" ? "expected_error" : "error",
        source_platform: contactSignal.sourcePlatform ?? "unknown",
        contact_count_bucket: contactCountBucket(contactSignal.totalContacts),
        matched_count: contactSignal.matchedCount,
        invite_candidate_count: contactSignal.inviteCandidateCount,
      });
      if (status === "unavailable") {
        toast.info("Contact sync is available in the iOS and Android app.");
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  }, [auth.user, contactSignal]);

  const handleRequestAccess = useCallback(async () => {
    if (!vaultOwnerToken || !selectedRequestOwners.length) return;
    setBusy("request");
    let successCount = 0;
    try {
      for (const owner of selectedRequestOwners) {
        await OneLocationService.requestAccess({
          vaultOwnerToken,
          ownerUserId: owner.userId,
          message: requestMessage.trim() || undefined,
        });
        successCount += 1;
      }
      trackEvent("one_location_request_sent", {
        route_id: "one_location",
        result: oneLocationEventResult(successCount, 0),
        selected_count: selectedRequestOwners.length,
        success_count: successCount,
        failure_count: 0,
        has_note: Boolean(requestMessage.trim()),
      });
      setRequestMessage("");
      playOneLocationNotificationSound();
      toast.success(
        selectedRequestOwners.length === 1
          ? "Request sent. We'll notify you here when they respond."
          : `Requests sent to ${peopleCountLabel(
              selectedRequestOwners.length,
            )}. We'll notify you here when they respond.`,
      );
      await refresh();
    } catch (error) {
      const failureCount = selectedRequestOwners.length - successCount || 1;
      trackEvent("one_location_request_sent", {
        route_id: "one_location",
        result: oneLocationEventResult(successCount, failureCount),
        selected_count: selectedRequestOwners.length,
        success_count: successCount,
        failure_count: failureCount,
        has_note: Boolean(requestMessage.trim()),
      });
      toast.error(oneLocationErrorMessage(error, "Could not send request."));
      if (isTransientOneApiError(error)) {
        await refresh().catch(() => null);
      }
    } finally {
      setBusy(null);
    }
  }, [refresh, requestMessage, selectedRequestOwners, vaultOwnerToken]);

  const handleCreatePublicInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("publicInvite");
    try {
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(durationHours),
      });
      const url = publicInviteUrlLabel(response.publicUrl);
      setPublicInviteUrl(url);
      if (navigator.clipboard && url) {
        await navigator.clipboard.writeText(url).catch(() => undefined);
      }
      trackEvent("one_location_public_link_created", {
        route_id: "one_location",
        result: "success",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: Boolean(navigator.clipboard && url),
        active_invite_count: activePublicInvites.length + 1,
      });
      toast.success(
        "Public request link created. You still approve before sharing.",
      );
      await refresh();
    } catch (error) {
      trackEvent("one_location_public_link_created", {
        route_id: "one_location",
        result: "error",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: false,
        active_invite_count: activePublicInvites.length,
      });
      toast.error(
        oneLocationErrorMessage(error, "Could not create public request link."),
      );
    } finally {
      setBusy(null);
    }
  }, [activePublicInvites.length, durationHours, refresh, vaultOwnerToken]);

  const handleCopyPublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    try {
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Request link copied.");
    } catch {
      toast.error("Could not copy the request link.");
    }
  }, [publicInviteUrl]);

  const handleSharePublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    const text =
      "Please send a One Location request here. I approve before anything is shared.";
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Request my location",
          text,
          url: publicInviteUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Request link copied.");
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      toast.error("Could not open the share sheet.");
    }
  }, [publicInviteUrl]);

  const handleShareContactInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("contactInvite");
    try {
      let url = publicInviteUrl;
      if (!url) {
        const response = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: Number(durationHours),
        });
        url = publicInviteUrlLabel(response.publicUrl);
        setPublicInviteUrl(url);
        trackEvent("one_location_public_link_created", {
          route_id: "one_location",
          result: "success",
          duration_bucket: oneLocationDurationBucket(durationHours),
          copied_to_clipboard: false,
          active_invite_count: activePublicInvites.length + 1,
        });
        await refresh();
      }

      const text =
        "Join my KAI Circle on One Location. Send me a request here; I approve before anything is shared.";
      if (navigator.share && url) {
        await navigator.share({
          title: "Join my KAI Circle",
          text,
          url,
        });
        return;
      }
      if (navigator.clipboard && url) {
        await navigator.clipboard.writeText(`${text} ${url}`);
        toast.success("Invite link copied.");
        return;
      }
      toast.info("Create a request link, then share it with your contacts.");
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      trackEvent("one_location_public_link_created", {
        route_id: "one_location",
        result: "error",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: false,
        active_invite_count: activePublicInvites.length,
      });
      toast.error(oneLocationErrorMessage(error, "Could not prepare invite."));
    } finally {
      setBusy(null);
    }
  }, [
    activePublicInvites.length,
    durationHours,
    publicInviteUrl,
    refresh,
    vaultOwnerToken,
  ]);

  const handleRevokePublicInvite = useCallback(
    async (invite: OneLocationPublicInvite) => {
      if (!vaultOwnerToken) return;
      setBusy("publicRevoke");
      try {
        await OneLocationService.revokePublicInvite({
          vaultOwnerToken,
          inviteId: invite.id,
        });
        setPublicInviteUrl("");
        toast.success("Public request link revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(
            error,
            "Could not revoke public request link.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleApprove = useCallback(
    async (request: OneLocationAccessRequest) => {
      if (!vaultOwnerToken) return;
      const requester = recipients.find(
        (recipient) => recipient.userId === request.requesterUserId,
      );
      if (!requester?.keyId || !requester.publicKeyJwk) {
        toast.error("Requester key unavailable.");
        return;
      }
      setBusy("approve");
      try {
        const response = await OneLocationService.approveRequest({
          vaultOwnerToken,
          requestId: request.id,
          durationHours: Number(durationHours),
        });
        await publishEnvelopeWithRetry(response.grant, requester, "manual");
        toast.success("Request approved and encrypted update published.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not approve request.",
        );
      } finally {
        setBusy(null);
      }
    },
    [durationHours, publishEnvelopeWithRetry, recipients, refresh, vaultOwnerToken],
  );

  const handleDeny = useCallback(
    async (requestId: string) => {
      if (!vaultOwnerToken) return;
      setBusy("deny");
      try {
        await OneLocationService.denyRequest({ vaultOwnerToken, requestId });
        toast.success("Request denied.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not deny request.",
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleRefer = useCallback(
    async (grant: OneLocationGrant) => {
      if (!vaultOwnerToken) return;
      const target = referralTargets[grant.id];
      if (!target) return;
      setBusy("refer");
      try {
        await OneLocationService.referRecipient({
          vaultOwnerToken,
          grantId: grant.id,
          referredUserId: target,
        });
        toast.success("Referral sent as an owner approval request.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not refer recipient.",
        );
      } finally {
        setBusy(null);
      }
    },
    [referralTargets, refresh, vaultOwnerToken],
  );

  const trackRecommendationSelection = useCallback(
    (
      recipient: OneLocationRecipient,
      action: ShareMode,
      selectionSurface: OneLocationSelectionSurface,
      selectedCount: number,
    ) => {
      trackEvent(
        "one_location_recommendation_selected",
        {
          route_id: "one_location",
          action,
          result: "success",
          selection_surface: selectionSurface,
          recommendation_category: recipient.recommendationCategory ?? "unknown",
          recommendation_tier: recipient.recommendationTier ?? "unknown",
          selected_count: selectedCount,
          can_receive_location: recipient.canReceiveLocation,
        },
        {
          dedupeKey: `one_location_recommendation_selected:${action}:${selectionSurface}:${recipient.recommendationRank ?? "rankless"}:${selectedCount}`,
        },
      );
    },
    [],
  );

  const addShareRecipient = useCallback(
    (
      recipientId: string,
      selectionSurface: OneLocationSelectionSurface = "select_menu",
    ) => {
      const recipient = recipients.find((item) => item.userId === recipientId);
      const nextSelectedIds = addSelectedId(selectedRecipientIds, recipientId);
      setSelectedRecipientId(recipientId);
      setSelectedRecipientIds(nextSelectedIds);
      setShareReviewOpen(false);
      if (recipient) {
        trackRecommendationSelection(
          recipient,
          "share",
          selectionSurface,
          nextSelectedIds.length,
        );
      }
    },
    [recipients, selectedRecipientIds, trackRecommendationSelection],
  );
  const toggleShareRecipient = useCallback(
    (
      recipientId: string,
      selectionSurface: OneLocationSelectionSurface = "quick_circle",
    ) => {
      const recipient = recipients.find((item) => item.userId === recipientId);
      const nextSelectedIds = toggleSelectedId(selectedRecipientIds, recipientId);
      setSelectedRecipientId(recipientId);
      setSelectedRecipientIds(nextSelectedIds);
      setShareReviewOpen(false);
      if (recipient) {
        trackRecommendationSelection(
          recipient,
          "share",
          selectionSurface,
          nextSelectedIds.length,
        );
      }
    },
    [recipients, selectedRecipientIds, trackRecommendationSelection],
  );
  const removeShareRecipient = useCallback(
    (recipientId: string) => {
      const nextSelectedIds = selectedRecipientIds.filter(
        (selectedId) => selectedId !== recipientId,
      );
      setSelectedRecipientIds(nextSelectedIds);
      setSelectedRecipientId((current) =>
        current === recipientId ? nextSelectedIds[0] || "" : current,
      );
      setShareReviewOpen(false);
    },
    [selectedRecipientIds],
  );
  const addRequestOwner = useCallback(
    (
      recipientId: string,
      selectionSurface: OneLocationSelectionSurface = "select_menu",
    ) => {
      const recipient = recipients.find((item) => item.userId === recipientId);
      const nextSelectedIds = addSelectedId(
        selectedRequestOwnerIds,
        recipientId,
      );
      setSelectedRequestOwnerId(recipientId);
      setSelectedRequestOwnerIds(nextSelectedIds);
      if (recipient) {
        trackRecommendationSelection(
          recipient,
          "request",
          selectionSurface,
          nextSelectedIds.length,
        );
      }
    },
    [recipients, selectedRequestOwnerIds, trackRecommendationSelection],
  );
  const toggleRequestOwner = useCallback(
    (
      recipientId: string,
      selectionSurface: OneLocationSelectionSurface = "quick_circle",
    ) => {
      const recipient = recipients.find((item) => item.userId === recipientId);
      const nextSelectedIds = toggleSelectedId(
        selectedRequestOwnerIds,
        recipientId,
      );
      setSelectedRequestOwnerId(recipientId);
      setSelectedRequestOwnerIds(nextSelectedIds);
      if (recipient) {
        trackRecommendationSelection(
          recipient,
          "request",
          selectionSurface,
          nextSelectedIds.length,
        );
      }
    },
    [recipients, selectedRequestOwnerIds, trackRecommendationSelection],
  );
  const removeRequestOwner = useCallback(
    (recipientId: string) => {
      const nextSelectedIds = selectedRequestOwnerIds.filter(
        (selectedId) => selectedId !== recipientId,
      );
      setSelectedRequestOwnerIds(nextSelectedIds);
      setSelectedRequestOwnerId((current) =>
        current === recipientId ? nextSelectedIds[0] || "" : current,
      );
    },
    [selectedRequestOwnerIds],
  );

  const canShare = Boolean(
    vaultOwnerToken &&
    selectedShareRecipients.length &&
    shareReadySelectedRecipients.length &&
    !setupNeededSelectedRecipients.length &&
    permission?.state !== "denied" &&
    permission?.state !== "restricted" &&
    permission?.state !== "unavailable",
  );
  const handleOpenShareReview = useCallback(() => {
    if (!canShare) return;
    setShareReviewOpen(true);
    trackEvent(
      "one_location_share_review_opened",
      {
        route_id: "one_location",
        result: "success",
        selected_count: shareReadySelectedRecipients.length,
        duration_bucket: oneLocationDurationBucket(durationHours),
        has_permission_warning: permission?.state !== "granted",
        has_professional_signal: shareReadySelectedRecipients.some(
          (recipient) =>
            kaiCircleSectionKey(recipient) === "professional_network",
        ),
        has_setup_warning: Boolean(setupNeededSelectedRecipients.length),
      },
      {
        dedupeKey: `one_location_share_review_opened:${shareReadySelectedRecipients.length}:${durationHours}`,
      },
    );
  }, [
    canShare,
    durationHours,
    permission?.state,
    setupNeededSelectedRecipients.length,
    shareReadySelectedRecipients,
  ]);
  const dataState: "loading" | "loaded" | "unavailable-valid" = loadError
    ? "unavailable-valid"
    : state
      ? "loaded"
      : "loading";
  const showInitialSkeleton =
    !loadError &&
    !state &&
    (auth.loading ||
      busy === "load" ||
      Boolean(auth.userId && vaultOwnerToken));

  return (
    <AppPageShell
      width="standard"
      nativeTest={{
        routeId: "/one/location",
        marker: "native-route-one-location",
        authState: auth.loading
          ? "pending"
          : auth.isAuthenticated
            ? "authenticated"
            : "anonymous",
        dataState,
        errorCode: loadError ? "one_location_unavailable" : null,
        errorMessage: loadError,
      }}
    >
      <AppPageHeaderRegion className="mx-auto w-full max-w-[1120px]">
        <div className="flex flex-col gap-4 px-1 pt-3 sm:flex-row sm:items-end sm:justify-between">
          <header className="max-w-[560px] space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#007aff] dark:text-[#76b7ff]">
              When it matters most
            </span>
            <h1 className="text-[34px] font-bold leading-[1.2] tracking-tight text-[#1c1c1e] sm:text-[42px] dark:text-white">
              Your circle, safely connected.
            </h1>
            <h2 className="sr-only">One Location Agent</h2>
            <p className="max-w-[440px] text-[16px] font-medium leading-snug text-[#8e8e93] dark:text-white/55">
              Share your location with selected contacts, or ask to see theirs
              after they approve.
            </p>
          </header>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy === "load"}
            className="h-9 w-fit rounded-full border-black/[0.06] bg-white/80 px-3 text-[#1c1c1e] shadow-sm backdrop-blur-xl hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
          >
            {busy === "load" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Refresh
          </Button>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mx-auto w-full max-w-[1120px] space-y-6">
        {loadError ? (
          <div className="rounded-[20px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-4 text-sm text-[#ff3b30] dark:text-[#ff9f9a]">
            {loadError}
          </div>
        ) : null}

        {showInitialSkeleton ? (
          <OneLocationInitialSkeleton />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] xl:items-start">
            <div className="space-y-7">
              <section className="space-y-3 px-1">
                <PromiseCard
                  icon={LocateFixed}
                  title="Chosen People"
                  description="Only selected contacts can see your location."
                  tone="blue"
                />
                <PromiseCard
                  icon={ShieldCheck}
                  title="Approval First"
                  description="Every location request needs approval."
                  tone="green"
                />
                <PromiseCard
                  icon={KeyRound}
                  title="Stop Anytime"
                  description="Change access, set a time limit, or stop sharing anytime."
                  tone="orange"
                />
              </section>

              <section className="space-y-4 px-1">
                <SegmentedModeControl
                  value={activeMode}
                  onChange={setActiveMode}
                />

                <div className="space-y-2">
                  {sectionLabel("KAI Circle")}
                  <div className="flex gap-4 overflow-x-auto px-1 pb-2 pt-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {rankedRecipients.length ? (
                      rankedRecipients.map((recipient, index) => {
                        const label = displayNameFromRecipient(recipient);
                        const selected =
                          activeMode === "share"
                            ? selectedRecipientIds.includes(recipient.userId)
                            : selectedRequestOwnerIds.includes(
                                recipient.userId,
                              );
                        return (
                          <button
                            key={recipient.userId}
                            type="button"
                            aria-label={`Select ${recipientLabel(
                              recipient,
                            )} from KAI Circle`}
                            onClick={() => {
                              if (activeMode === "share") {
                                toggleShareRecipient(recipient.userId);
                              } else {
                                toggleRequestOwner(recipient.userId);
                              }
                            }}
                            className="flex shrink-0 flex-col items-center gap-1.5"
                          >
                            <span className="relative">
                              <AvatarBubble label={label} index={index} />
                              <span
                                className={cn(
                                  "absolute bottom-0 right-0 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-black/5 bg-white shadow-sm dark:border-white/10 dark:bg-[#2c2c2e]",
                                  selected && "ring-2 ring-[#007aff]/30",
                                )}
                              >
                                {selected ? (
                                  <CheckCircle2 className="h-3 w-3 text-[#2e7d32] dark:text-emerald-300" />
                                ) : recipient.canReceiveLocation ? (
                                  <ShieldCheck className="h-3 w-3 text-[#8e8e93] dark:text-white/55" />
                                ) : (
                                  <AlertTriangle className="h-3 w-3 text-[#ff9500]" />
                                )}
                              </span>
                            </span>
                            <span className="max-w-[68px] truncate text-[12px] font-medium text-[#1c1c1e] dark:text-white">
                              {label}
                            </span>
                            <span
                              className={cn(
                                "max-w-[88px] truncate rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase",
                                recommendationToneClassName(
                                  recipient.recommendationTier,
                                ),
                              )}
                            >
                              {recommendationTierLabel(
                                recipient.recommendationTier,
                              )}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="text-[13px] text-[#8e8e93] dark:text-white/55">
                        KAI Circle recommendations will appear here.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8e8e93]" />
                    <input
                      value={recipientSearch}
                      onChange={(event) =>
                        setRecipientSearch(event.target.value)
                      }
                      className="h-10 w-full rounded-[14px] border border-black/[0.04] bg-white pl-10 pr-4 text-[15px] text-[#1c1c1e] shadow-sm outline-none transition-shadow placeholder:text-[#8e8e93] focus:ring-2 focus:ring-[#007aff]/20 dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white"
                      placeholder="Search KAI Circle..."
                      type="text"
                    />
                  </div>

                  <div
                    aria-label="KAI Circle section states"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {kaiCircleSections.map((section) => {
                      const emptyCopy =
                        KAI_CIRCLE_SECTION_EMPTY_COPY[section.key];
                      return (
                        <div
                          key={section.key}
                          className="rounded-[14px] border border-black/[0.04] bg-white/70 p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]"
                        >
                          {sectionLabel(section.title, section.recipients.length)}
                          <p className="mt-1 text-[12px] leading-5 text-[#8e8e93] dark:text-white/55">
                            {section.recipients.length
                              ? section.description
                              : `${emptyCopy.title}. ${emptyCopy.description}`}
                          </p>
                        </div>
                      );
                    })}
                  </div>

                  <div className="rounded-[14px] border border-black/[0.04] bg-white/70 p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eaf9ef] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200">
                        <ContactRound className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[14px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
                            Mobile contact signal
                          </h3>
                          <span className="rounded-full bg-[#f2f2f7] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#636366] dark:bg-white/10 dark:text-white/65">
                            {contactSignalStatusLabel(contactSignal.status)}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] leading-5 text-[#8e8e93] dark:text-white/55">
                          {contactSignalSummary(contactSignal)}
                        </p>
                        {contactSignal.status === "matched" ||
                        contactSignal.status === "empty" ? (
                          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8e8e93] dark:text-white/45">
                            {contactSignal.matchedCount} matched /{" "}
                            {contactSignal.inviteCandidateCount} invite-ready
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <ActionButton
                        busy={busy}
                        busyKey="contactSync"
                        onClick={() => void handleSyncContactSignal()}
                        disabled={!auth.user || busy === "contactInvite"}
                        variant="outline"
                        className="h-10 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#1c1c1e] shadow-sm hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                      >
                        {busy !== "contactSync" ? (
                          <ContactRound className="mr-2 h-4 w-4" aria-hidden="true" />
                        ) : null}
                        Sync Contacts
                      </ActionButton>
                      <ActionButton
                        busy={busy}
                        busyKey="contactInvite"
                        onClick={() => void handleShareContactInvite()}
                        disabled={!vaultOwnerToken || busy === "contactSync"}
                        variant="outline"
                        className="h-10 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#007aff] shadow-sm hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15"
                      >
                        {busy !== "contactInvite" ? (
                          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        ) : null}
                        Invite Contacts
                      </ActionButton>
                    </div>
                  </div>

                  <div className={onePanelClassName}>
                    {visibleRecipients.length ? (
                      visibleRecipients.map((recipient, index) => {
                        const label = displayNameFromRecipient(recipient);
                        const selected =
                          activeMode === "share"
                            ? selectedRecipientIds.includes(recipient.userId)
                            : selectedRequestOwnerIds.includes(
                                recipient.userId,
                              );
                        const reasons = visibleRecommendationReasons(recipient);
                        return (
                          <div
                            key={recipient.userId}
                            className="relative flex flex-col gap-2.5 p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
                          >
                            <div className="flex items-center gap-3">
                              <AvatarBubble
                                label={label}
                                index={index}
                                size="sm"
                                muted={!recipient.canReceiveLocation}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
                                    {recipientLabel(recipient)}
                                  </span>
                                  <span className="rounded-md bg-[#f0f5ff] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
                                    {recipient.phoneVerified
                                      ? "Verified"
                                      : "Contact"}
                                  </span>
                                  <span
                                    className={cn(
                                      "rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                                      recommendationToneClassName(
                                        recipient.recommendationTier,
                                      ),
                                    )}
                                  >
                                    {recommendationCategoryLabel(recipient)}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                                  {recipientRecommendationLine(recipient)}
                                </p>
                                {reasons.length ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {reasons.map((reason) => (
                                      <span
                                        key={reason.code}
                                        className="rounded-full bg-[#f2f2f7] px-2 py-0.5 text-[11px] font-semibold text-[#636366] dark:bg-white/10 dark:text-white/65"
                                      >
                                        {reason.label}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                              {selected ? (
                                <CheckCircle2 className="h-[22px] w-[22px] text-[#007aff] dark:text-[#76b7ff]" />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (activeMode === "share") {
                                      toggleShareRecipient(
                                        recipient.userId,
                                        "section_list",
                                      );
                                    } else {
                                      toggleRequestOwner(
                                        recipient.userId,
                                        "section_list",
                                      );
                                    }
                                  }}
                                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[#f2f2f7] px-3 text-[12px] font-semibold text-[#007aff] transition-colors hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Select
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <EmptyOneState
                        icon={UsersRound}
                        title={
                          recipients.length
                            ? "No KAI Circle matches"
                            : "KAI Circle is empty"
                        }
                        description={
                          recipients.length
                            ? "Try another name, role, or recommendation signal."
                            : "Approval, professional, ready, and setup signals will appear as your KAI network grows."
                        }
                      />
                    )}
                  </div>

                  {activeMode === "share" ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                        <Select
                          value={selectedRecipientId}
                          onValueChange={addShareRecipient}
                        >
                          <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                            <SelectValue placeholder="Select verified person" />
                          </SelectTrigger>
                          <SelectContent>
                            {rankedRecipients.map((recipient) => (
                              <SelectItem
                                key={recipient.userId}
                                value={recipient.userId}
                              >
                                {recipientLabel(recipient)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={durationHours}
                          onValueChange={setDurationHours}
                        >
                          <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DURATION_OPTIONS.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedShareRecipients.length ? (
                        <div
                          aria-label="Selected share recipients"
                          className="flex flex-wrap gap-2"
                        >
                          {selectedShareRecipients.map((recipient) => (
                            <button
                              key={recipient.userId}
                              type="button"
                              onClick={() =>
                                removeShareRecipient(recipient.userId)
                              }
                              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25"
                            >
                              {recipientLabel(recipient)}
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="sr-only">
                                Remove {recipientLabel(recipient)}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {setupNeededSelectedRecipients.length ? (
                        <div className="rounded-[14px] border border-[#ff9500]/30 bg-[#ff9500]/10 p-3 text-xs leading-5 text-[#9a5a00] dark:text-[#ffd79a]">
                          {peopleCountLabel(
                            setupNeededSelectedRecipients.length,
                          )}{" "}
                          need One Location setup before private sharing can
                          start.
                        </div>
                      ) : null}
                      <p className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                        {selectedShareRecipients.length
                          ? `${peopleCountLabel(
                              selectedShareRecipients.length,
                            )} selected for private encrypted sharing.`
                          : "Select one or more KAI users for private sharing."}
                      </p>
                      {shareReviewOpen ? (
                        <div
                          role="region"
                          aria-label="Share safety review"
                          className="space-y-3 rounded-[14px] border border-[#007aff]/20 bg-[#eef5ff] p-3 text-[13px] leading-5 text-[#17446f] dark:border-[#0a84ff]/30 dark:bg-[#0a84ff]/15 dark:text-[#cfe7ff]"
                        >
                          <div>
                            <p className="font-semibold text-[#0b3d70] dark:text-[#e6f2ff]">
                              Confirm private KAI-to-KAI sharing
                            </p>
                            <p className="mt-1">
                              {peopleCountLabel(
                                shareReadySelectedRecipients.length,
                              )}{" "}
                              will receive separate encrypted location access
                              for{" "}
                              {
                                DURATION_OPTIONS.find(
                                  (option) => option.value === durationHours,
                                )?.label
                              }
                              .
                            </p>
                          </div>
                          <ActionButton
                            busy={busy}
                            busyKey="share"
                            onClick={() => void handleShare()}
                            disabled={!canShare}
                            className="h-10 rounded-full bg-[#007aff] px-4 text-[13px] font-semibold text-white hover:bg-[#006fe6]"
                          >
                            <Send
                              className="mr-2 h-4 w-4"
                              aria-hidden="true"
                            />
                            Confirm & Share Location
                          </ActionButton>
                        </div>
                      ) : null}
                      <ActionButton
                        busy={busy}
                        busyKey="share"
                        onClick={handleOpenShareReview}
                        disabled={!canShare}
                        className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[#1a85ff] to-[#0066ff] text-[16px] font-semibold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] hover:opacity-95"
                      >
                        <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        Review Share
                        <span className="sr-only">Share Encrypted Update</span>
                      </ActionButton>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <Select
                        value={selectedRequestOwnerId}
                        onValueChange={addRequestOwner}
                      >
                        <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                          <SelectValue placeholder="Select owner" />
                        </SelectTrigger>
                        <SelectContent>
                          {rankedRecipients.map((recipient) => (
                            <SelectItem
                              key={recipient.userId}
                              value={recipient.userId}
                            >
                              {recipientLabel(recipient)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedRequestOwners.length ? (
                        <div
                          aria-label="Selected request owners"
                          className="flex flex-wrap gap-2"
                        >
                          {selectedRequestOwners.map((recipient) => (
                            <button
                              key={recipient.userId}
                              type="button"
                              onClick={() =>
                                removeRequestOwner(recipient.userId)
                              }
                              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25"
                            >
                              {recipientLabel(recipient)}
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="sr-only">
                                Remove {recipientLabel(recipient)}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <p className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                        {selectedRequestOwners.length
                          ? `${peopleCountLabel(
                              selectedRequestOwners.length,
                            )} selected for approval-first requests.`
                          : "Select one or more KAI users before requesting location access."}
                      </p>
                      <Textarea
                        value={requestMessage}
                        onChange={(event) =>
                          setRequestMessage(event.target.value)
                        }
                        placeholder="Optional reason"
                        rows={3}
                        className="rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
                      />
                      <ActionButton
                        busy={busy}
                        busyKey="request"
                        onClick={() => void handleRequestAccess()}
                        disabled={
                          !vaultOwnerToken || !selectedRequestOwners.length
                        }
                        className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[#1a85ff] to-[#0066ff] text-[16px] font-semibold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] hover:opacity-95"
                      >
                        <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        Send Request
                      </ActionButton>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="space-y-6">
              <OneLocationActivityDashboard
                activity={locationActivity}
                range={activityRange}
                loading={activityLoading}
                error={activityError}
                onRangeChange={(value) => {
                  setActivityRange(value);
                  setActivitySnapshot(null);
                }}
              />

              <section className="space-y-2 px-1">
                {sectionLabel("People who can see me")}
                <div className={onePanelClassName}>
                  {(state?.ownerGrants ?? []).length ? (
                    state?.ownerGrants.map((grant, index) => (
                      <div
                        key={grant.id}
                        className="relative flex items-center gap-3 p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
                      >
                        <AvatarBubble
                          label={grantCounterpartyLabel(grant)}
                          index={index}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium tracking-tight text-[#1c1c1e] dark:text-white">
                            {grantCounterpartyLabel(grant)}
                          </h3>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <Badge variant={statusVariant(grant.status)}>
                              {grant.status}
                            </Badge>
                            <span className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                              {expiresLabel(grant)} - {grant.durationHours}h
                            </span>
                          </div>
                        </div>
                        {grant.status === "active" ? (
                          <div className="flex shrink-0 gap-1.5">
                            <Button
                              aria-label="Update share"
                              variant="outline"
                              size="icon"
                              onClick={() => void handlePublish(grant)}
                              disabled={busy === "publish"}
                              className="h-8 w-8 rounded-full border-0 bg-[#f2f2f7] text-[#8e8e93] hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white/55 dark:hover:bg-white/15"
                            >
                              {busy === "publish" ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Pencil className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              aria-label={`Revoke access for ${grantCounterpartyLabel(grant)}`}
                              variant="outline"
                              size="icon"
                              onClick={() => void handleRevoke(grant.id)}
                              disabled={busy === "revoke"}
                              className="h-8 w-8 rounded-full border-0 bg-[#ff3b30]/10 text-[#ff3b30] hover:bg-[#ff3b30]/20 dark:bg-[#ff453a]/15 dark:text-[#ff9f9a]"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={UsersRound}
                      title="No active shares"
                      description="Create one encrypted grant when you need a trusted person to see you."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Approvals", pendingOwnerRequests.length)}
                <div
                  className={cn(
                    onePanelClassName,
                    pendingOwnerRequests.length &&
                      "relative before:absolute before:bottom-0 before:left-0 before:top-0 before:w-1 before:bg-[#ff3b30]",
                  )}
                >
                  {pendingOwnerRequests.length ? (
                    pendingOwnerRequests.map((request) => (
                      <div key={request.id} className="flex items-start gap-3 p-3.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <UserRoundCheck className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <h3 className="text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
                            {requestLabel(request)}
                          </h3>
                          <p className="text-[13px] font-medium leading-relaxed text-[#8e8e93] dark:text-white/55">
                            {request.message ||
                              `Requested ${formatDateTime(request.requestedAt)}`}
                          </p>
                          <div className="flex gap-2 pt-2">
                            <Button
                              variant="outline"
                              onClick={() => void handleDeny(request.id)}
                              disabled={busy === "deny"}
                              className="h-9 flex-1 rounded-[12px] border-0 bg-[#f2f2f7] font-semibold text-[#1c1c1e] hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                            >
                              Deny
                            </Button>
                            <ActionButton
                              busy={busy}
                              busyKey="approve"
                              onClick={() => void handleApprove(request)}
                              className="h-9 flex-1 rounded-[12px] bg-[#007aff] font-semibold text-white shadow-[0_2px_8px_rgba(0,122,255,0.25)] hover:bg-[#0066ff]"
                            >
                              Approve
                            </ActionButton>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={Clock3}
                      title="No pending requests"
                      description="Referral and direct access requests wait here."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Create request link")}
                <div className={cn(onePanelClassName, "space-y-4 p-3.5")}>
                  <p className="text-[13px] leading-5 text-[#8e8e93] dark:text-white/55">
                    Share a request link. It asks for their details and never
                    shows your location until you approve an encrypted grant.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <div className={cn(oneInsetClassName, "px-3 py-2 text-sm")}>
                      <span className={oneSecondaryTextClassName}>
                        {publicInviteUrl ||
                          "Create a fresh request link to copy or share."}
                      </span>
                    </div>
                    <Select
                      value={durationHours}
                      onValueChange={setDurationHours}
                    >
                      <SelectTrigger className="h-10 w-full rounded-[12px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                        <SelectValue />
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
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      busy={busy}
                      busyKey="publicInvite"
                      onClick={() => void handleCreatePublicInvite()}
                      disabled={!vaultOwnerToken}
                      className="rounded-full bg-[#007aff] text-white hover:bg-[#0066ff]"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Create Request Link
                    </ActionButton>
                    <Button
                      variant="outline"
                      onClick={() => void handleSharePublicInvite()}
                      disabled={!publicInviteUrl}
                      className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyPublicInvite()}
                      disabled={!publicInviteUrl}
                      className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                  </div>
                  {activePublicInvites.length ? (
                    <div className="space-y-2">
                      {activePublicInvites.map((invite) => (
                        <div
                          key={invite.id}
                          className="flex items-center justify-between gap-3 rounded-[14px] bg-[#f2f2f7] p-3 dark:bg-white/10"
                        >
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                              Active request link
                            </p>
                            <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                              Requests expire{" "}
                              {formatDateTime(invite.expiresAt)} -{" "}
                              {invite.durationHours}h
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRevokePublicInvite(invite)}
                            disabled={busy === "publicRevoke"}
                            className="rounded-full"
                          >
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Shared with me")}
                <div className={onePanelClassName}>
                  {visibleReceivedGrants.length ? (
                    visibleReceivedGrants.map((grant, index) => {
                      const point = decryptedPoints[grant.id];
                      return (
                        <div
                          key={grant.id}
                          className="border-b border-black/[0.05] last:border-b-0 dark:border-white/[0.08]"
                        >
                          <div className="flex items-center gap-3 p-3.5">
                            <AvatarBubble
                              label={receivedGrantOwnerLabel(grant)}
                              index={index + 2}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-[16px] font-medium tracking-tight text-[#1c1c1e] dark:text-white">
                                {receivedGrantOwnerLabel(grant)}
                              </h3>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <Badge variant={statusVariant(grant.status)}>
                                  {grant.status}
                                </Badge>
                                <span className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                                  {expiresLabel(grant)}
                                </span>
                              </div>
                            </div>
                            {grant.status === "active" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleView(grant)}
                                disabled={busy === "view"}
                                className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                              >
                                {busy === "view" ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <ShieldCheck className="mr-2 h-4 w-4" />
                                )}
                                View
                              </Button>
                            ) : null}
                          </div>
                          {point ? (
                            <div className="px-3.5 pb-3.5">
                              <LocalMapPreview point={point} />
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <EmptyOneState
                      icon={MapPin}
                      title={
                        hiddenReceivedGrantCount > 0
                          ? "Open notification to view"
                          : "Nothing shared with you"
                      }
                      description={
                        hiddenReceivedGrantCount > 0
                          ? "A location share is waiting in the notification bell."
                          : "Approved recipient grants appear after you open their notification."
                      }
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Public link responses")}
                <div className={onePanelClassName}>
                  {publicSubmissions.length ? (
                    publicSubmissions.map((submission) => (
                      <div
                        key={submission.id}
                        className="flex items-center gap-3 p-3.5"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <ExternalLink className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium text-[#1c1c1e] dark:text-white">
                            {publicSubmissionLabel(submission)}
                          </h3>
                          <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                            {submission.message ||
                              `Status ${submission.status} - ${formatDateTime(submission.submittedAt)}`}
                          </p>
                        </div>
                        <Badge variant={statusVariant(submission.status)}>
                          {submission.requestStatus || submission.status}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={ExternalLink}
                      title="No public responses"
                      description="Responses from your request link show up here without exposing your location."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Refer someone else")}
                <div className={cn(onePanelClassName, "p-3.5")}>
                  {(state?.receivedGrants ?? []).filter(
                    (grant) => grant.status === "active",
                  ).length ? (
                    state?.receivedGrants
                      .filter((grant) => grant.status === "active")
                      .map((grant) => (
                        <div
                          key={grant.id}
                          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <Select
                            value={referralTargets[grant.id] || ""}
                            onValueChange={(value) =>
                              setReferralTargets((current) => ({
                                ...current,
                                [grant.id]: value,
                              }))
                            }
                          >
                            <SelectTrigger className="h-10 w-full rounded-[12px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                              <SelectValue placeholder="Select referred person" />
                            </SelectTrigger>
                            <SelectContent>
                              {recipients
                                .filter(
                                  (recipient) =>
                                    recipient.userId !== grant.ownerUserId,
                                )
                                .map((recipient) => (
                                  <SelectItem
                                    key={recipient.userId}
                                    value={recipient.userId}
                                  >
                                    {recipientLabel(recipient)}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          <ActionButton
                            busy={busy}
                            busyKey="refer"
                            variant="outline"
                            onClick={() => void handleRefer(grant)}
                            disabled={!referralTargets[grant.id]}
                            className="rounded-full"
                          >
                            Refer
                          </ActionButton>
                        </div>
                      ))
                  ) : (
                    <EmptyOneState
                      icon={UsersRound}
                      title="No active received grant"
                      description="You can refer only from an active share, and the owner still decides."
                    />
                  )}
                </div>
              </section>

              {requestedByMe.length ? (
                <section className="space-y-2 px-1">
                  {sectionLabel("My requests")}
                  <div className={onePanelClassName}>
                    {requestedByMe.map((request) => (
                      <div
                        key={request.id}
                        className="flex items-center gap-3 p-3.5"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <Clock3 className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium text-[#1c1c1e] dark:text-white">
                            {request.ownerUserId}
                          </h3>
                          <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                            Status {request.status} -{" "}
                            {formatDateTime(request.requestedAt)}
                          </p>
                        </div>
                        <Badge variant={statusVariant(request.status)}>
                          {request.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

export default function OneLocationAgentPage() {
  return (
    <VaultLockGuard>
      <OneLocationAgentPageContent />
    </VaultLockGuard>
  );
}

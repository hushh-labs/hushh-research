"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  ContactRound,
  Copy,
  ExternalLink,
  Hand,
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
  UserPlus,
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
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
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
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

import { useRequireAuth } from "@/hooks/use-auth";

type LocationTab = "compose" | "activity";

const LOCATION_TAB_PARAM = "tab";
const LOCATION_TAB_OPTIONS: { value: LocationTab; label: string }[] = [
  { value: "compose", label: "Share & Request" },
  { value: "activity", label: "Activity" },
];

function normalizeLocationTab(value: string | null | undefined): LocationTab {
  return value === "activity" ? "activity" : "compose";
}

import type { HushhLocationPermissionState } from "@/lib/capacitor";

import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureLocationRecipientKey,
} from "@/lib/one-location/encryption";
import {
  buildOneLocationNotificationHref,
  buildOneLocationWorkflowHref,
  isOneLocationGrantOpened,
  isOneLocationGrantUnwatched,
  locationShareNotificationDescription,
  locationWorkflowNotificationCopy,
  markOneLocationGrantOpened,
  markOneLocationGrantUnwatched,
  ONE_LOCATION_GRANT_ID_PARAM,
  ONE_LOCATION_GRANT_OPENED_EVENT,
  ONE_LOCATION_GRANT_UNWATCHED_EVENT,
  ONE_LOCATION_NOTIFICATION_OPEN_PARAM,
  ONE_LOCATION_NOTIFICATION_OPEN_VALUE,
  ONE_LOCATION_REFERRAL_ID_PARAM,
  ONE_LOCATION_REQUEST_ID_PARAM,
  ONE_LOCATION_SECTION_PARAM,
  ONE_LOCATION_SUBMISSION_ID_PARAM,
  oneLocationSectionForWorkflowNotificationType,
  playOneLocationNotificationSound,
  recordOneLocationShareNotification,
  recordOneLocationWorkflowNotification,
  type OneLocationNotificationSection,
  type OneLocationWorkflowNotificationType,
} from "@/lib/one-location/notifications";
import { OneLocationService } from "@/lib/one-location/service";
import {
  syncOneLocationContactSignals,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import { OneLocationActivityDashboard } from "@/components/one-location/activity-dashboard";
import {
  LocationRedesignHub,
  type LocationHubViewModel,
} from "@/components/one-location/redesign/location-redesign-hub";
import { LocationRedesignSkeleton } from "@/components/one-location/redesign/location-redesign-skeleton";
import { buildOneLocationActivityFallback } from "@/lib/one-location/activity";
import type {
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationCircleInvite,
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
import { copyToClipboard } from "@/lib/utils/clipboard";

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
// True live tracking: while a share is active and the app is foregrounded, the
// owner subscribes to a continuous geolocation watch and publishes a fresh
// encrypted envelope as soon as they MOVE at least this far. The min publish
// interval prevents flooding the network when GPS jitters or the user moves
// fast; the 20s interval above stays as a stationary heartbeat so a standing
// user's point never goes stale.
const LIVE_LOCATION_MIN_MOVE_METERS = 25;
const LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS = 8_000;

const ONE_NETWORK_PREVIEW_LIMIT = 3;
const REQUEST_MESSAGE_MAX_LENGTH = 80;


const ONE_LOCATION_SHARE_TITLE = "Join me on One";
const ONE_LOCATION_PUBLIC_SHARE_COPY = "Join my One Location circle";
const ONE_LOCATION_CIRCLE_SHARE_COPY = "Join me on One";
const SHOW_LOCATION_ACTIVITY_SECTION = false;
const SHOW_OWNER_GRANTS_SECTION = false;
const SHOW_PUBLIC_RESPONSES_SECTION = false;
const SHOW_REFERRAL_SECTION = false;

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
  | "locationSettings"
  | "selfLocation"
  | "contactSync"
  | "contactInvite"
  | "publicInvite"
  | "publicRevoke"
  | "circleInvite"
  | "circleRevoke"
  | null;

type OneLocationSelectionSurface =
  | "quick_circle"
  | "section_list"
  | "select_menu";

type OneLocationDurationBucket = "15m" | "30m" | "1h" | "4h" | "24h" | "custom";
type OneLocationForegroundOperation = "publish" | "view";
type OneLocationForegroundTrigger = "manual" | "foreground_interval";
type OneLocationFocusTarget = OneLocationNotificationSection;
type OneLocationOnboardingStep = "intro" | "permission";
type OneLocationOnboardingGate = "checking" | "show" | "hidden";
type OneLocationNativeTestConfig = ComponentProps<typeof NativeTestBeacon>;
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

// Human, at-a-glance countdown to when a share auto-stops (e.g. "Stops in
// 14 min"). This is a key confidence cue: the user can always see that sharing
// is time-boxed and will end on its own. Falls back to the absolute time when
// the window is long, and degrades gracefully if the timestamp is missing.
function expiresCountdownLabel(value?: string | null): string | null {
  if (!value) return null;
  const expiresAt = new Date(value).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "Stopping now";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) {
    return `Stops in ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes % 60;
    return remMinutes
      ? `Stops in ${hours}h ${remMinutes}m`
      : `Stops in ${hours}h`;
  }
  return `Stops ${formatDateTime(value)}`;
}

function looksLikeInternalIdentifier(value: string): boolean {
  const label = value.trim();
  if (!label) return false;
  if (
    /^(actor|grant|invite|key|location|one_location|recipient|referral|request|submission|user)[_-]/i.test(
      label,
    )
  ) {
    return true;
  }
  if (/^[0-9a-f]{24,}$/i.test(label) || /^[0-9a-f-]{32,}$/i.test(label)) {
    return true;
  }
  return (
    /^[A-Za-z0-9_-]{16,}$/.test(label) &&
    /[A-Z]/.test(label) &&
    /[a-z]/.test(label) &&
    /\d/.test(label)
  );
}

function safePersonLabel(value?: string | null, fallback = "One user"): string {
  const label = String(value || "").trim();
  if (!label || looksLikeInternalIdentifier(label)) return fallback;
  return label;
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
      return "One Network";
    case "contacts":
      return "Contact match";
    case "setup_needed":
      return "Setup needed";
    case "available":
      return "Ready";
    default:
      return "One Network";
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
      ? "Ready for private location sharing"
      : "Needs to open One Location once")
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

function requestOwnerLabel(
  request: OneLocationAccessRequest,
  recipients: OneLocationRecipient[],
): string {
  const owner = recipients.find(
    (recipient) => recipient.userId === request.ownerUserId,
  );
  return safePersonLabel(owner?.displayName, "Location owner");
}

function publicSubmissionLabel(
  submission: OneLocationPublicInviteSubmission,
): string {
  return safePersonLabel(submission.visitorDisplayName, "Public request");
}

function publicInviteUrlLabel(value: string): string {
  if (!value) return "";
  const configuredOrigin = String(process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  const origin =
    /^https?:\/\//i.test(configuredOrigin) ||
    typeof window === "undefined"
      ? configuredOrigin
      : String(window.location.origin || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) return value;
  return new URL(value, origin).toString();
}

function publicInviteUrlPreview(value: string): string {
  const url = value.trim();
  if (!url) return "";
  const maxLength = 52;
  return url.length > maxLength ? `${url.slice(0, maxLength)}...` : url;
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

// Great-circle distance in metres between two points (Haversine). Used to decide
// whether the owner has actually MOVED enough to warrant publishing a fresh
// encrypted live-location update, so the watch stream doesn't flood the network
// on GPS jitter while standing still.
function locationDistanceMeters(
  from: PlainLocationPoint,
  to: PlainLocationPoint,
): number {
  const earthRadiusM = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
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

function LocalMapPreview({
  point,
  showNavigation = true,
}: {
  point: PlainLocationPoint;
  // Self-location previews do not need Directions/Start - you are already there.
  showNavigation?: boolean;
}) {
  const captured = formatDateTime(point.capturedAt);
  const isStale = isLocationPointStale(point);
  const accuracy = locationAccuracyLabel(point);
  const embedUrl = googleMapsLocationEmbedUrl(point);
  const directionsUrl = googleMapsDirectionsUrl(point);
  const startUrl = googleMapsStartNavigationUrl(point);
  const statusLabel = isStale ? "Last known location" : "Live location";

  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-48 max-w-full overflow-hidden bg-[#e5e5ea] sm:h-56 dark:bg-[#111113]">
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
          <p className="mt-1 break-words text-[12px] font-medium text-muted-foreground [overflow-wrap:anywhere]">
            Updated {captured}
            {accuracy ? ` - ${accuracy}` : ""} -{" "}
            {locationSourceLabel(point.sourcePlatform)}
          </p>
        </div>

        {showNavigation ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-10 w-full min-w-0 rounded-full border-[#0a84ff]/30 bg-[#0a84ff]/10 text-[#0066cc] hover:bg-[#0a84ff]/15 dark:text-[#76b7ff]"
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
              className="h-10 w-full min-w-0 rounded-full bg-[#1c1c1e] text-white hover:bg-black dark:bg-white dark:text-[#1c1c1e] dark:hover:bg-white/90"
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
        ) : null}
      </div>


      {isStale ? (
        <div
          role="status"
          className="mx-3 mb-3 flex min-w-0 items-start gap-2 rounded-[12px] border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[12px] font-medium text-amber-800 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
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

type ShareMode = "share" | "request";

const onePanelClassName =
  "w-full min-w-0 max-w-full overflow-x-hidden rounded-[20px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_38px_rgba(0,0,0,0.28)]";
const oneScrollablePanelClassName = cn(
  onePanelClassName,
  "max-h-[min(70dvh,560px)] overflow-y-auto overscroll-contain [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/20 dark:[&::-webkit-scrollbar-thumb]:bg-white/20",
);
const oneInsetClassName =
  "w-full min-w-0 max-w-full overflow-hidden rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white";
const oneSecondaryTextClassName = "text-[#8e8e93] dark:text-white/55";

function sectionLabel(title: string, count?: number) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-[15px] font-semibold leading-tight tracking-normal text-[#3a3a3c] dark:text-white/75"
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

function SegmentedModeControl({
  value,
  onChange,
}: {
  value: ShareMode;
  onChange: (value: ShareMode) => void;
}) {
  return (
    <div
      aria-label="Choose location sharing mode"
      className="flex h-9 w-full min-w-0 max-w-full items-center overflow-hidden rounded-[9px] bg-[#efeff0] p-[3px] dark:bg-white/10"
      role="tablist"
    >
      {(["share", "request"] as const).map((mode) => (
        <button
          key={mode}
          aria-selected={value === mode}
          role="tab"
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
    <div className="flex min-h-24 min-w-0 max-w-full flex-col items-start gap-3 p-3.5 text-sm sm:flex-row sm:items-center">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-[#1c1c1e] dark:text-white">
          {title}
        </div>
        <div className="break-words text-[13px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
          {description}
        </div>
      </div>
    </div>
  );
}

const ONE_LOCATION_TRUST_CHIPS: {
  icon: LucideIcon;
  label: string;
  detail: string;
}[] = [
  {
    icon: ShieldCheck,
    label: "End-to-end encrypted",
    detail: "Only the people you pick can see it. We can't.",
  },
  {
    icon: Clock3,
    label: "Auto-expires",
    detail: "Sharing stops on its own when the timer ends.",
  },
  {
    icon: Hand,
    label: "Stop anytime",
    detail: "One tap ends sharing instantly - no waiting.",
  },
];

const ONE_LOCATION_FIRST_RUN_STEPS: {
  icon: LucideIcon;
  title: string;
  detail: string;
}[] = [
  {
    icon: UsersRound,
    title: "Add the people you trust",
    detail: "Pick from your One Network, or invite someone in a tap.",
  },
  {
    icon: Clock3,
    title: "Choose how long",
    detail: "15 minutes to a day - it auto-stops when the timer ends.",
  },
  {
    icon: Send,
    title: "Share or request",
    detail: "Share your live location, or ask to see theirs once they approve.",
  },
];

const ONE_LOCATION_FIRST_RUN_GUIDE_KEY = "one_location_first_run_guide_v1";

// One-time, friendly "how it works" card for first-time customers. It explains
// the whole flow in three plain steps so a brand-new user is never confused
// about what to do first. It is dismissible and the choice persists per user,
// and it auto-hides once the user already has any activity.
function OneLocationFirstRunGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      aria-label="How One Location works"
      className="relative min-w-0 max-w-full overflow-hidden rounded-[20px] border border-[#007aff]/15 bg-gradient-to-b from-[#f3f8ff] to-white p-4 shadow-sm dark:border-[#0a84ff]/20 dark:from-[#0a84ff]/10 dark:to-transparent"
    >
      <button
        type="button"
        aria-label="Dismiss the getting started guide"
        onClick={onDismiss}
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full text-[#8e8e93] transition-colors hover:bg-black/[0.05] hover:text-[#1c1c1e] dark:hover:bg-white/10 dark:hover:text-white"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="space-y-0.5 pr-8">
        <h3 className="text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
          New here? It takes 3 quick steps
        </h3>
        <p className="text-[13px] leading-snug text-[#8e8e93] dark:text-white/55">
          Location sharing is always your choice, and you stay in control.
        </p>
      </div>
      <ol className="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
        {ONE_LOCATION_FIRST_RUN_STEPS.map(({ icon: Icon, title, detail }, index) => (
          <li
            key={title}
            className="flex min-w-0 items-start gap-2.5 rounded-[14px] border border-black/[0.04] bg-white/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.06]"
          >
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#007aff]/12 text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-[#1c1c1e] dark:text-white">
                <span className="text-[#007aff] dark:text-[#76b7ff]">
                  {index + 1}.
                </span>
                {title}
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-[#8e8e93] dark:text-white/55">
                {detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Compact reassurance row shown above the tabs so a first-time user immediately
// sees the three trust promises ("why this is safe") before doing anything.
function OneLocationTrustStrip() {
  return (
    <ul
      aria-label="How One Location keeps you safe"
      className="grid min-w-0 max-w-full grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {ONE_LOCATION_TRUST_CHIPS.map(({ icon: Icon, label, detail }) => (
        <li
          key={label}
          className="flex min-w-0 items-start gap-2.5 rounded-[14px] border border-black/[0.05] bg-white/80 px-3 py-2.5 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]"
        >
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#34c759]/12 text-[#2dbd5a] dark:bg-[#34c759]/15">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold leading-tight text-[#1c1c1e] dark:text-white">
              {label}
            </span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-[#8e8e93] dark:text-white/55">
              {detail}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function isLocationServicesDisabled(
  permission: HushhLocationPermissionState | null,
): boolean {
  return permission?.locationServicesEnabled === false;
}

function locationPermissionBlocksSharing(
  permission: HushhLocationPermissionState | null,
): boolean {
  return (
    isLocationServicesDisabled(permission) ||
    permission?.state === "denied" ||
    permission?.state === "restricted" ||
    permission?.state === "unavailable"
  );
}

function locationServicesErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown })?.message || error || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("services are unavailable") ||
    normalized.includes("location services") ||
    normalized.includes("provider") ||
    normalized.includes("unavailable on this device")
  ) {
    return "Turn on Location from your phone settings before sharing.";
  }
  if (normalized.includes("permission") || normalized.includes("not granted")) {
    return "Allow location permission before sharing.";
  }
  return message || "Location is needed before sharing.";
}

function isShareAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function oneLocationShareMessage(text: string, url: string): string {
  return `${text}\n${url}`;
}

async function shareOneLocationLink(params: {
  title: string;
  text: string;
  url: string;
  dialogTitle: string;
}): Promise<"native-share" | "web-share" | "copied"> {
  const url = publicInviteUrlLabel(params.url.trim());
  if (!url) {
    throw new Error("Create a public location link before sharing.");
  }
  const message = oneLocationShareMessage(params.text, url);

  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    const { Share } = (await import("@capacitor/share")) as typeof import("@capacitor/share");
    if (Capacitor.getPlatform() === "android") {
      await Share.share({
        title: params.title,
        text: message,
        dialogTitle: params.dialogTitle,
      });
      return "native-share";
    }
    await Share.share({
      title: params.title,
      text: params.text,
      url,
      dialogTitle: params.dialogTitle,
    });
    return "native-share";
  }

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    await navigator.share({
      title: params.title,
      text: params.text,
      url,
    });
    return "web-share";
  }

  if (await copyToClipboard(message)) {
    return "copied";
  }

  throw new Error("Sharing is not supported on this device.");
}

function readinessCopy(permission: HushhLocationPermissionState | null): {
  title: string;
  description: string;
  tone: "ready" | "warning" | "blocked" | "checking";
  actionLabel?: string;
} {
  if (!permission) {
    return {
      title: "Checking location readiness",
      description: "One is checking whether this device can share your current location.",
      tone: "checking",
    };
  }
  if (isLocationServicesDisabled(permission)) {
    return {
      title: "Turn on phone Location",
      description:
        "Your phone Location switch is off. Turn it on before sharing with your trusted circle.",
      tone: "blocked",
      actionLabel: "Open Location Settings",
    };
  }
  if (permission.state === "prompt") {
    return {
      title: "Allow location permission",
      description:
        "One will ask for foreground location access before your first encrypted share.",
      tone: "warning",
      actionLabel: "Allow Location",
    };
  }
  if (permission.state === "denied" || permission.state === "restricted") {
    return {
      title: "Location permission blocked",
      description:
        "Allow location access from app settings before you share your location.",
      tone: "blocked",
      actionLabel: "Open Location Settings",
    };
  }
  if (permission.state === "unavailable") {
    return {
      title: "Location unavailable",
      description:
        "This device cannot provide a fresh location right now. Check Location settings and try again.",
      tone: "blocked",
      actionLabel: "Open Location Settings",
    };
  }
  return {
    title: permission.precise === false ? "Approximate location ready" : "Location ready",
    description:
      permission.precise === false
        ? "Sharing can continue, but accuracy may be approximate on this device."
        : "Foreground location is ready for private sharing.",
    tone: permission.precise === false ? "warning" : "ready",
  };
}

function OneLocationInitialSkeleton() {
  return (
    <div
      aria-label="Loading One Location"
      className="mx-auto w-full max-w-[720px] space-y-5"
      role="status"
    >
      <section className="space-y-2 px-1">
        {sectionLabel("Device readiness")}
        <div className="rounded-[20px] border border-[#34c759]/20 bg-[#34c759]/10 p-4 shadow-sm dark:border-[#34c759]/25 dark:bg-[#34c759]/12">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <Skeleton className="h-6 w-44 max-w-[70%] rounded-lg" />
          </div>
        </div>
        <div className={cn(onePanelClassName, "p-3.5")}>
          <Skeleton className="h-11 w-full rounded-full" />
        </div>
      </section>

      <section className="space-y-4 px-1">
        <div className="flex h-9 w-full rounded-[9px] bg-[#efeff0] p-[3px] dark:bg-white/10">
          <Skeleton className="h-full flex-1 rounded-[7px]" />
          <Skeleton className="h-full flex-1 rounded-[7px] opacity-60" />
        </div>

        <Skeleton className="h-10 w-full rounded-[14px]" />

        <div className={onePanelClassName}>
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="relative flex items-center gap-3 p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
            >
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40 max-w-full rounded-lg" />
                <Skeleton className="h-3 w-56 max-w-full rounded-lg" />
              </div>
              <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
            </div>
          ))}
        </div>

        <Skeleton className="h-9 w-full rounded-full" />

        <div className={cn(onePanelClassName, "space-y-3 p-3.5")}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
            <Skeleton className="h-11 rounded-[14px]" />
            <Skeleton className="h-11 rounded-[14px]" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-32 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
          <Skeleton className="h-12 w-full rounded-[16px]" />
        </div>
      </section>

      <section className="space-y-2 px-1">
        {sectionLabel("Approvals")}
        <div className={cn(onePanelClassName, "flex items-center gap-3 p-3.5")}>
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40 rounded-lg" />
            <Skeleton className="h-3 w-56 max-w-full rounded-lg" />
          </div>
        </div>
      </section>

      <section className="space-y-2 px-1">
        {sectionLabel("Create public link")}
        <div className={cn(onePanelClassName, "space-y-3 p-3.5")}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
            <Skeleton className="h-10 rounded-[12px]" />
            <Skeleton className="h-10 rounded-[12px]" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-10 w-full rounded-full sm:w-44" />
            <Skeleton className="h-10 w-full rounded-full sm:w-24" />
            <Skeleton className="h-10 w-full rounded-full sm:w-24" />
          </div>
        </div>
      </section>

      <section className="space-y-2 px-1">
        {sectionLabel("Shared with me")}
        <div className={cn(onePanelClassName, "flex items-center gap-3 p-3.5")}>
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40 rounded-lg" />
            <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
          </div>
        </div>
      </section>
    </div>
  );
}

function OneLocationIntroMapIllustration() {
  return (
    <div
      className="relative aspect-square w-[min(290px,78vw,42dvh)] overflow-hidden rounded-[32px] bg-[#efece5] shadow-[0_26px_54px_-14px_rgba(40,34,22,0.24),0_6px_16px_rgba(0,0,0,0.06)] dark:bg-[#1d2229] dark:shadow-[0_26px_54px_-14px_rgba(0,0,0,0.65),0_6px_16px_rgba(0,0,0,0.28)]"
      aria-hidden="true"
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 300 300"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <rect width="300" height="300" className="fill-[#efece5] dark:fill-[#1d2229]" />
        <path
          d="M0 198 Q44 182 86 198 T172 204 L172 300 L0 300 Z"
          className="fill-[#d3e7c4] dark:fill-[#243f2d]"
        />
        <path
          d="M214 0 Q248 42 300 38 L300 0 Z"
          className="fill-[#c2dcf4] dark:fill-[#20374f]"
        />
        <circle cx="58" cy="54" r="30" className="fill-[#d3e7c4] dark:fill-[#274633]" />
        <path
          d="M-20 116 L320 88"
          className="stroke-[#e6e0d4] dark:stroke-[#2c333c]"
          strokeWidth="17"
          fill="none"
        />
        <path
          d="M150 -20 L172 320"
          className="stroke-[#e6e0d4] dark:stroke-[#2c333c]"
          strokeWidth="17"
          fill="none"
        />
        <path
          d="M-20 224 L320 202"
          className="stroke-[#e6e0d4] dark:stroke-[#2c333c]"
          strokeWidth="12"
          fill="none"
        />
        <path
          d="M-20 116 L320 88"
          className="stroke-[#fbfaf6] dark:stroke-[#11161c]"
          strokeWidth="11.5"
          fill="none"
        />
        <path
          d="M150 -20 L172 320"
          className="stroke-[#fbfaf6] dark:stroke-[#11161c]"
          strokeWidth="11.5"
          fill="none"
        />
        <path
          d="M-20 224 L320 202"
          className="stroke-[#fbfaf6] dark:stroke-[#11161c]"
          strokeWidth="7.5"
          fill="none"
        />
        <rect x="38" y="128" width="44" height="38" rx="6" className="fill-[#e8e2d6] dark:fill-[#29313a]" />
        <rect x="90" y="132" width="40" height="34" rx="6" className="fill-[#e8e2d6] dark:fill-[#29313a]" />
        <rect x="198" y="124" width="52" height="46" rx="6" className="fill-[#e8e2d6] dark:fill-[#29313a]" />
        <rect x="40" y="250" width="48" height="40" rx="6" className="fill-[#e8e2d6] dark:fill-[#29313a]" />
      </svg>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_80%_at_28%_4%,rgba(255,255,255,0.55),rgba(255,255,255,0)_58%)] dark:bg-[radial-gradient(110%_80%_at_28%_4%,rgba(255,255,255,0.09),rgba(255,255,255,0)_58%)]" />
      <div className="absolute left-[18%] top-[27%] flex flex-col items-center">
        <span className="flex h-[50px] w-[50px] items-center justify-center rounded-full border-[3px] border-white bg-[#34c759] text-[19px] font-semibold text-white shadow-[0_6px_15px_rgba(0,0,0,0.16),0_1px_3px_rgba(0,0,0,0.1)]">
          M
        </span>
        <span className="-mt-0.5 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[9px] border-l-transparent border-r-transparent border-t-white" />
      </div>
      <div className="absolute left-[45%] top-[47%] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center">
        <span className="absolute h-20 w-20 rounded-full bg-[#0071e3]/12 dark:bg-[#0a84ff]/18" />
        <span className="absolute h-[30px] w-[30px] animate-ping rounded-full bg-[#0071e3]/35" />
        <span className="relative h-[22px] w-[22px] rounded-full border-[3px] border-white bg-[#0071e3] shadow-[0_2px_8px_rgba(0,113,227,0.55),0_1px_3px_rgba(0,0,0,0.25)]" />
      </div>
      <div className="absolute bottom-[29%] right-[21%] flex flex-col items-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border-[3px] border-white bg-[#ff3b30] text-[16px] font-semibold text-white shadow-[0_6px_15px_rgba(0,0,0,0.16),0_1px_3px_rgba(0,0,0,0.1)]">
          E
        </span>
        <span className="-mt-0.5 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[9px] border-l-transparent border-r-transparent border-t-white" />
      </div>
      <div className="absolute bottom-[16%] left-[29%] flex flex-col items-center">
        <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full border-[3px] border-white bg-[#ff9f0a] text-[15px] font-semibold text-white shadow-[0_6px_15px_rgba(0,0,0,0.16),0_1px_3px_rgba(0,0,0,0.1)]">
          J
        </span>
        <span className="-mt-0.5 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[9px] border-l-transparent border-r-transparent border-t-white" />
      </div>
      <div className="pointer-events-none absolute inset-0 rounded-[32px] shadow-[inset_0_0_60px_rgba(70,60,40,0.09),inset_0_0_0_1px_rgba(255,255,255,0.35)] dark:shadow-[inset_0_0_60px_rgba(0,0,0,0.28),inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
    </div>
  );
}

function OneLocationPermissionGlyph() {
  return (
    <div
      className="flex h-24 w-24 items-center justify-center rounded-full bg-[#0071e3] text-[#0071e3] shadow-[0_0_64px_10px_rgba(0,113,227,0.34),0_16px_34px_rgba(0,113,227,0.34)] dark:bg-[#0a84ff] dark:text-[#0a84ff] dark:shadow-[0_0_70px_10px_rgba(10,132,255,0.42),0_18px_38px_rgba(10,132,255,0.32)]"
      aria-hidden="true"
    >
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" focusable="false">
        <path
          d="M12 21s7-6.3 7-11.5A7 7 0 0 0 5 9.5C5 14.7 12 21 12 21Z"
          fill="#fff"
        />
        <circle cx="12" cy="9.5" r="2.7" fill="currentColor" />
      </svg>
    </div>
  );
}

function OneLocationOnboardingFlow({
  step,
  busy,
  permission,
  nativeTest,
  onContinueIntro,
  onRequestPermission,
  onSkip,
}: {
  step: OneLocationOnboardingStep;
  busy: boolean;
  permission: HushhLocationPermissionState | null;
  nativeTest: OneLocationNativeTestConfig;
  onContinueIntro: () => void;
  onRequestPermission: () => void;
  onSkip: () => void;
}) {
  const isPermissionStep = step === "permission";
  const isDeviceLocationOff =
    isPermissionStep && isLocationServicesDisabled(permission);
  const isPermissionBlocked =
    isPermissionStep &&
    (permission?.state === "denied" || permission?.state === "restricted");
  const permissionTitle = isDeviceLocationOff
    ? "Turn on phone Location"
    : isPermissionBlocked
      ? "Allow location in Settings"
      : "Allow location access";
  const permissionDescription = isDeviceLocationOff
    ? "Your app permission is ready, but your phone Location switch is off. Turn it on, then return to continue."
    : isPermissionBlocked
      ? "Open Settings and allow location for One. Sharing still only happens after you confirm."
      : "Choose While using the app. One only shares your location after you confirm a Circle share.";
  const permissionBadge = isDeviceLocationOff
    ? "Phone Location is off"
    : "You can pause sharing anytime";
  const primaryActionLabel = isPermissionStep
    ? isDeviceLocationOff || isPermissionBlocked
      ? isPermissionBlocked
        ? "Open App Settings"
        : "Open Location Settings"
      : "Allow Location"
    : "Continue";

  return (
    <main
      className="fixed inset-0 z-[540] h-dvh min-h-[100svh] w-full overflow-hidden bg-white text-[#1d1d1f] dark:bg-[#050506] dark:text-white"
      data-no-route-swipe
    >
      <NativeTestBeacon {...nativeTest} />
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[430px] flex-col overflow-hidden bg-white dark:bg-[#050506]">
        <div className="h-[calc(env(safe-area-inset-top,0px)+24px)] shrink-0" />
        <section className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-[clamp(24px,7vw,34px)] py-3 [-webkit-overflow-scrolling:touch]">
          <div
            key={step}
            className="flex w-full flex-col items-center text-center animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none"
          >
            {isPermissionStep ? <OneLocationPermissionGlyph /> : <OneLocationIntroMapIllustration />}

            <h1
              className={cn(
                "mt-8 max-w-[340px] text-center text-[28px] font-medium leading-[1.1] text-[#1d1d1f] sm:text-[31px] dark:text-white",
                isPermissionStep && "max-w-[330px] text-[27px] leading-[1.12] sm:text-[30px]",
              )}
            >
              {isPermissionStep
                ? permissionTitle
                : "Experience location sharing with One."}
            </h1>

            {isPermissionStep ? (
              <>
                <p className="mt-3 max-w-[330px] text-[15.5px] font-normal leading-[1.5] text-[#6e6e73] dark:text-white/62">
                  {permissionDescription}
                </p>
                <div className="mt-6 inline-flex max-w-full items-center gap-2.5 rounded-full bg-[#f5f5f7] px-4 py-2.5 text-[14px] text-[#6e6e73] dark:bg-white/[0.08] dark:text-white/62">
                  <Clock3 className="h-[18px] w-[18px] shrink-0 text-[#34c759]" aria-hidden="true" />
                  <span className="min-w-0 truncate">{permissionBadge}</span>
                </div>
              </>
            ) : (
              <p className="mt-3 max-w-[310px] text-[15.5px] leading-[1.45] text-[#6e6e73] dark:text-white/62">
                Never text "where are you?" again.
              </p>
            )}
          </div>
        </section>
        <footer className="flex shrink-0 flex-col items-center gap-3.5 px-[clamp(24px,7vw,34px)] pb-2 pt-2">
          <Button
            type="button"
            onClick={isPermissionStep ? onRequestPermission : onContinueIntro}
            disabled={busy}
            className="h-[54px] w-full rounded-full bg-[#0071e3] text-[17px] font-semibold text-white shadow-[0_8px_22px_rgba(0,113,227,0.28)] hover:bg-[#006fe6] dark:bg-[#0a84ff] dark:hover:bg-[#0077ed]"
          >
            {busy ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
            ) : null}
            {primaryActionLabel}
          </Button>

          {isPermissionStep ? (
            <button
              type="button"
              onClick={onSkip}
              disabled={busy}
              className="h-6 rounded-full px-3 text-[14.5px] font-medium text-[#86868b] transition-colors hover:text-[#1d1d1f] disabled:opacity-50 dark:text-white/45 dark:hover:text-white"
            >
              Not now
            </button>
          ) : (
            <p className="min-h-6 text-center text-[13px] text-[#86868b] dark:text-white/45">
              Private - shared only with your Circle.
            </p>
          )}
        </footer>
        <div className="h-[calc(env(safe-area-inset-bottom,0px)+22px)] shrink-0" />
      </div>
    </main>
  );
}

function OneLocationAgentPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useRequireAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const pendingCircleInviteToken = useMemo(
    () => String(searchParams.get("circleInviteToken") || "").trim(),
    [searchParams],
  );
  const [state, setState] = useState<OneLocationState | null>(null);
  const [permission, setPermission] =
    useState<HushhLocationPermissionState | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  // Per-grant revoke tracking so "Stop sharing" only spins on the specific
  // active-share card the user tapped, not every active share at once.
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  // Monotonic counter bumped each time a share completes successfully, so the
  // redesign hub can close the 3-step share flow and return to the main screen.
  const [shareCompletedTick, setShareCompletedTick] = useState(0);


  const [locationOnboardingGate, setLocationOnboardingGate] =
    useState<OneLocationOnboardingGate>("checking");
  const [locationOnboardingStep, setLocationOnboardingStep] =
    useState<OneLocationOnboardingStep>("intro");
  const [locationOnboardingBusy, setLocationOnboardingBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<ShareMode>("share");
  const locationTab = normalizeLocationTab(
    searchParams.get(LOCATION_TAB_PARAM),
  );
  const setLocationTab = useCallback(
    (next: LocationTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "compose") {
        params.delete(LOCATION_TAB_PARAM);
      } else {
        params.set(LOCATION_TAB_PARAM, next);
      }
      const query = params.toString();
      router.replace(query ? `/one/location?${query}` : "/one/location", {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const [shareReviewOpen, setShareReviewOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [oneNetworkListExpanded, setOneNetworkListExpanded] = useState(false);
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
  const [circleInviteUrl, setCircleInviteUrl] = useState("");
  const [myLocationPoint, setMyLocationPoint] =
    useState<PlainLocationPoint | null>(null);
  const [myLocationError, setMyLocationError] = useState<string | null>(null);
  const [decryptedPoints, setDecryptedPoints] = useState<
    Record<string, PlainLocationPoint>
  >({});
  const [openedGrantTick, setOpenedGrantTick] = useState(0);
  // Bumped whenever the recipient unwatches a share, so the memoized
  // "Shared with me" list recomputes immediately.
  const [unwatchedTick, setUnwatchedTick] = useState(0);
  // First-run "how it works" guide for brand-new customers. Defaults to shown
  // and is hidden once the user dismisses it (persisted per user) so it never
  // nags returning customers.
  const [firstRunGuideDismissed, setFirstRunGuideDismissed] = useState(true);

  const [focusedSection, setFocusedSection] =
    useState<OneLocationFocusTarget | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const peopleSectionRef = useRef<HTMLElement | null>(null);
  const approvalsSectionRef = useRef<HTMLElement | null>(null);
  const sharedSectionRef = useRef<HTMLElement | null>(null);
  const myRequestsSectionRef = useRef<HTMLElement | null>(null);
  const publicResponsesSectionRef = useRef<HTMLElement | null>(null);
  const activitySectionRef = useRef<HTMLElement | null>(null);
  const focusClearRef = useRef<number | null>(null);
  const livePublishInFlightRef = useRef(false);
  const liveViewInFlightRef = useRef(false);
  const suppressAutoRecipientSelectionRef = useRef(false);
  // Continuous movement-driven live tracking (owner side). Holds the active
  // geolocation watch id, the last point we actually published (to measure
  // movement), and the timestamp of that publish (to throttle bursts).
  const liveWatchIdRef = useRef<string | null>(null);
  const lastPublishedPointRef = useRef<PlainLocationPoint | null>(null);
  const lastWatchPublishAtRef = useRef(0);


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
  const hasMoreVisibleRecipients =
    visibleRecipients.length > ONE_NETWORK_PREVIEW_LIMIT;
  const showExpandedOneNetworkList =
    oneNetworkListExpanded && hasMoreVisibleRecipients;
  const displayedVisibleRecipients = useMemo(
    () =>
      showExpandedOneNetworkList
        ? visibleRecipients
        : visibleRecipients.slice(0, ONE_NETWORK_PREVIEW_LIMIT),
    [showExpandedOneNetworkList, visibleRecipients],
  );

  useEffect(() => {
    setOneNetworkListExpanded(false);
  }, [recipientSearch]);
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
  // Every ACTIVE received share is shown inline in "Shared with me" so the
  // recipient can view the live map directly - opening a notification is a
  // convenience deep-link, NOT a requirement. Shares the recipient explicitly
  // "unwatched" are hidden. Terminal (revoked/expired) grants are never listed
  // here (the backend keeps them for ~12h for history only).
  const visibleReceivedGrants = useMemo(() => {
    void openedGrantTick;
    void unwatchedTick;
    return (state?.receivedGrants ?? []).filter(
      (grant) =>
        grant.status === "active" &&
        !isOneLocationGrantUnwatched(auth.userId, grant.id),
    );
  }, [auth.userId, openedGrantTick, unwatchedTick, state?.receivedGrants]);
  const activeOwnerGrants = useMemo(
    () =>
      (state?.ownerGrants ?? []).filter((grant) => grant.status === "active"),
    [state?.ownerGrants],
  );
  const activeVisibleReceivedGrants = visibleReceivedGrants;
  // Active shares the recipient unwatched (hidden locally). Used only to tailor
  // the empty-state copy.
  const unwatchedActiveReceivedGrantCount = useMemo(() => {
    void unwatchedTick;
    return (state?.receivedGrants ?? []).filter(
      (grant) =>
        grant.status === "active" &&
        isOneLocationGrantUnwatched(auth.userId, grant.id),
    ).length;
  }, [auth.userId, unwatchedTick, state?.receivedGrants]);
  const activePublicInvites = useMemo(
    () =>
      (state?.publicInvites ?? []).filter(
        (invite) => invite.status === "active",
      ),
    [state?.publicInvites],
  );
  const latestActivePublicInvite = useMemo(() => {
    const inviteTime = (invite: OneLocationPublicInvite) =>
      Date.parse(
        invite.createdAt || invite.updatedAt || invite.expiresAt || "",
      ) || 0;
    return [...activePublicInvites].sort(
      (left, right) => inviteTime(right) - inviteTime(left),
    )[0] ?? null;
  }, [activePublicInvites]);
  const activeCircleInvites = useMemo(
    () =>
      (state?.circleInvites ?? []).filter(
        (invite) => invite.status === "active",
      ),
    [state?.circleInvites],
  );
  const latestActiveCircleInvite = useMemo(() => {
    const inviteTime = (invite: OneLocationCircleInvite) =>
      Date.parse(
        invite.createdAt || invite.updatedAt || invite.expiresAt || "",
      ) || 0;
    return [...activeCircleInvites].sort(
      (left, right) => inviteTime(right) - inviteTime(left),
    )[0] ?? null;
  }, [activeCircleInvites]);
  const publicSubmissions = useMemo(
    () => state?.publicInviteSubmissions ?? [],
    [state?.publicInviteSubmissions],
  );
  const fallbackActivity = useMemo(
    () => buildOneLocationActivityFallback(state, auth.userId, activityRange),
    [activityRange, auth.userId, state],
  );
  const locationActivity = activitySnapshot ?? fallbackActivity;
  const focusOneLocationSection = useCallback(
    (target: OneLocationFocusTarget | null) => {
      if (!target || typeof window === "undefined") return;
      const sectionRefs: Record<
        OneLocationFocusTarget,
        MutableRefObject<HTMLElement | null>
      > = {
        people: peopleSectionRef,
        approvals: approvalsSectionRef,
        shared: sharedSectionRef,
        my_requests: myRequestsSectionRef,
        public_responses: publicResponsesSectionRef,
        activity: activitySectionRef,
      };
      // Every deep-link focus target (Shared with me, Approvals, My requests,
      // etc.) lives inside the "Activity & Links" tab. The default tab is
      // "compose", where those sections render inside a `hidden` container, so
      // scrollIntoView would silently no-op. Switch to the Activity tab first,
      // then wait for the section to become visible (offsetParent !== null)
      // before scrolling — retrying a few frames to cover the tab transition.
      setLocationTab("activity");

      let attempts = 0;
      const tryScroll = () => {
        const element = sectionRefs[target]?.current;
        const isVisible = Boolean(element && element.offsetParent !== null);
        if (element && isVisible) {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
          element.focus({ preventScroll: true });
          setFocusedSection(target);
          if (focusClearRef.current) {
            window.clearTimeout(focusClearRef.current);
          }
          focusClearRef.current = window.setTimeout(() => {
            setFocusedSection((current) =>
              current === target ? null : current,
            );
          }, 2200);
          return;
        }
        attempts += 1;
        if (attempts <= 12) {
          window.setTimeout(tryScroll, 80);
        }
      };
      window.setTimeout(tryScroll, 80);
    },
    [setLocationTab],
  );


  const sectionFocusClassName = useCallback(
    (target: OneLocationFocusTarget) =>
      focusedSection === target
        ? "rounded-[22px] ring-2 ring-[#007aff]/35 ring-offset-2 ring-offset-transparent"
        : "",
    [focusedSection],
  );
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
      focusOneLocationSection("shared");
    },
    [auth.userId, focusOneLocationSection, router],
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

  const showWorkflowToast = useCallback(
    (params: {
      notificationType: OneLocationWorkflowNotificationType;
      id: string;
      ownerLabel?: string | null;
      requesterLabel?: string | null;
      referringLabel?: string | null;
      visitorLabel?: string | null;
      grantId?: string | null;
      requestId?: string | null;
      referralId?: string | null;
      submissionId?: string | null;
      section?: OneLocationFocusTarget | null;
      openGrant?: boolean;
    }) => {
      if (!auth.userId) return;
      const section =
        params.section ||
        oneLocationSectionForWorkflowNotificationType(params.notificationType);
      const copy = locationWorkflowNotificationCopy({
        type: params.notificationType,
        ownerLabel: params.ownerLabel,
        requesterLabel: params.requesterLabel,
        referringLabel: params.referringLabel,
        visitorLabel: params.visitorLabel,
      });
      const routeHref = buildOneLocationWorkflowHref({
        grantId: params.grantId,
        requestId: params.requestId,
        referralId: params.referralId,
        submissionId: params.submissionId,
        section,
        openGrant: params.openGrant,
      });
      const created = recordOneLocationWorkflowNotification({
        userId: auth.userId,
        notificationType: params.notificationType,
        id: params.id,
        title: copy.title,
        description: copy.description,
        routeHref,
        metadata: {
          grantId: params.grantId || null,
          requestId: params.requestId || null,
          referralId: params.referralId || null,
          submissionId: params.submissionId || null,
          section,
        },
      });
      if (!created) return;

      playOneLocationNotificationSound();
      const toastKey = `one-location-workflow:${params.notificationType}:${params.id}`;
      toast(
        <div className="flex flex-col gap-2">
          <div className="space-y-0.5">
            <p className="line-clamp-1 text-sm font-semibold">{copy.title}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {copy.description}
            </p>
          </div>
          <button
            onClick={() => {
              if (params.openGrant && params.grantId) {
                markOneLocationGrantOpened(auth.userId, params.grantId);
                setOpenedGrantTick((value) => value + 1);
              }
              toast.dismiss(toastKey);
              router.push(routeHref, { scroll: false });
              focusOneLocationSection(section);
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
    [auth.userId, focusOneLocationSection, router],
  );

  useEffect(() => {
    if (!pendingCircleInviteToken || !vaultOwnerToken) return;
    router.push(`/one/location/invite/${encodeURIComponent(pendingCircleInviteToken)}`);
  }, [pendingCircleInviteToken, router, vaultOwnerToken]);

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
        if (!activeUser) {
          throw new Error("Refresh your session before loading location sharing.");
        }
        await AccountIdentityService.syncCurrentUser(activeUser).catch((error) => {
          console.warn("[OneLocation] Failed to sync account identity:", error);
        });
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
        const shouldAutoSelectFallback =
          !suppressAutoRecipientSelectionRef.current;
        const nextRecipientIds = new Set(
          nextState.recipients.map((recipient) => recipient.userId),
        );
        setSelectedRecipientId((current) =>
          current && nextRecipientIds.has(current)
            ? current
            : shouldAutoSelectFallback
              ? firstRecommendedRecipient?.userId || ""
              : "",
        );
        setSelectedRequestOwnerId((current) =>
          current && nextRecipientIds.has(current)
            ? current
            : shouldAutoSelectFallback
              ? firstRecommendedRecipient?.userId || ""
              : "",
        );
        // Multi-select share/request lists must never auto-select a default
        // person: the redesign hub ("Who can see you?" / "Make it comfortable")
        // requires the user to pick explicitly. We only preserve selections that
        // are still valid after a refresh and otherwise leave the list empty.
        setSelectedRecipientIds((current) =>
          current.filter((recipientId) => nextRecipientIds.has(recipientId)),
        );
        setSelectedRequestOwnerIds((current) =>
          current.filter((recipientId) => nextRecipientIds.has(recipientId)),
        );
        suppressAutoRecipientSelectionRef.current = false;

      } catch (error) {
        suppressAutoRecipientSelectionRef.current = false;
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

  const refreshLocationPermission = useCallback(async () => {
    const nextPermission = await OneLocationService.getPermissionState().catch(
      () => ({
        state: "unavailable" as const,
        precise: false,
        background: "unavailable" as const,
        locationServicesEnabled: null,
      }),
    );
    setPermission(nextPermission);
    return nextPermission;
  }, []);

  const handleOpenLocationSettings = useCallback(async () => {
    setBusy("locationSettings");
    try {
      const result = await OneLocationService.openLocationSettings();
      toast.info(
        result.opened
          ? "Turn on Location, then return to One Location and refresh."
          : "Open your phone or browser location settings, then return and refresh.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not open location settings.",
      );
    } finally {
      setBusy(null);
      window.setTimeout(() => void refreshLocationPermission(), 1200);
    }
  }, [refreshLocationPermission]);

  const ensureForegroundLocationReady = useCallback(
    async (options?: {
      capturePoint?: boolean;
      autoOpenSettings?: boolean;
      requestNativePrompt?: boolean;
    }): Promise<{ ready: boolean; point?: PlainLocationPoint }> => {
      const shouldCapturePoint = Boolean(options?.capturePoint);
      const shouldOpenSettings = options?.autoOpenSettings !== false;
      const shouldRequestNativePrompt = options?.requestNativePrompt === true;
      const currentPermission = await refreshLocationPermission();

      if (isLocationServicesDisabled(currentPermission)) {
        toast.error("Turn on phone Location before sharing.");
        if (shouldOpenSettings) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false };
      }

      if (
        currentPermission.state === "restricted" ||
        (currentPermission.state === "denied" && !shouldRequestNativePrompt)
      ) {
        toast.error("Allow location permission before sharing.");
        if (shouldOpenSettings) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false };
      }

      if (currentPermission.state === "unavailable") {
        toast.error("Location is unavailable. Check your phone Location settings.");
        if (shouldOpenSettings) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false };
      }

      if (currentPermission.state === "granted" && !shouldCapturePoint) {
        return { ready: true };
      }

      try {
        const point = await OneLocationService.captureCurrentPosition();
        const nextPermission = await OneLocationService.getPermissionState().catch(
          () => null,
        );
        setPermission(
          nextPermission ?? {
            state: "granted",
            precise: null,
            background: "foreground-only",
            locationServicesEnabled: true,
          },
        );
        return shouldCapturePoint ? { ready: true, point } : { ready: true };
      } catch (error) {
        const nextPermission = await OneLocationService.getPermissionState().catch(
          () => null,
        );
        if (nextPermission) {
          setPermission(nextPermission);
        }
        const message = locationServicesErrorMessage(error);
        toast.error(message);
        if (
          shouldOpenSettings &&
          (isLocationServicesDisabled(nextPermission) ||
            message.toLowerCase().includes("turn on location"))
        ) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false };
      }
    },
    [refreshLocationPermission],
  );

  useEffect(() => {
    if (!auth.loading) {
      void refresh();
    }
  }, [auth.loading, refresh]);

  useEffect(() => {
    if (auth.loading) {
      setLocationOnboardingGate("checking");
      return;
    }
    if (!auth.userId || loadError) {
      setLocationOnboardingGate("hidden");
      return;
    }
    if (!vaultOwnerToken) {
      setLocationOnboardingGate("checking");
      return;
    }

    if (locationOnboardingGate === "hidden") {
      return;
    }

    const introSeen =
      typeof window !== "undefined" &&
      window.localStorage.getItem(
        `one_location_onboarding_v1:${auth.userId}`,
      ) === "1";
    // Re-show the permission screen only when location is *actionably* off:
    // the phone Location switch is disabled, or the user explicitly denied /
    // restricted access. Neutral states ("prompt" = never asked yet, or
    // "unavailable" = web Permissions API can't determine state) must NOT trap
    // the user on the permission screen — they can use the app, see their
    // circle, and grant access at the moment they actually share.
    const deviceLocationBlocked =
      isLocationServicesDisabled(permission) ||
      permission?.state === "denied" ||
      permission?.state === "restricted";

    // The marketing intro screen only ever shows once per user (persisted in
    // localStorage). After that, the second "Allow location" screen is driven
    // purely by the real device location state: it re-appears only when access
    // is explicitly off / blocked, and stays hidden otherwise.
    if (introSeen) {
      // If onboarding is already visible (the user is mid-flow, e.g. just
      // advanced from the intro to the permission step), never auto-hide or
      // redirect — let them finish the current step. Dismissal happens through
      // the flow's own handlers. Device-state-driven (re)appearance only
      // applies on a fresh load when onboarding is not already showing.
      if (locationOnboardingGate === "show") {
        return;
      }
      if (deviceLocationBlocked) {
        setLocationOnboardingStep("permission");
        setLocationOnboardingGate("show");
        return;
      }
      setLocationOnboardingGate("hidden");
      return;
    }




    if (locationOnboardingGate !== "show") {
      setLocationOnboardingStep("intro");
    }
    setLocationOnboardingGate("show");
  }, [
    auth.loading,
    auth.userId,
    loadError,
    locationOnboardingGate,
    permission,
    vaultOwnerToken,
  ]);


  useEffect(() => {
    return () => {
      if (focusClearRef.current && typeof window !== "undefined") {
        window.clearTimeout(focusClearRef.current);
      }
    };
  }, []);

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
    if (!auth.userId || !state) return;
    const grantId = String(
      searchParams.get(ONE_LOCATION_GRANT_ID_PARAM) || "",
    ).trim();
    const requestId = String(
      searchParams.get(ONE_LOCATION_REQUEST_ID_PARAM) || "",
    ).trim();
    const referralId = String(
      searchParams.get(ONE_LOCATION_REFERRAL_ID_PARAM) || "",
    ).trim();
    const submissionId = String(
      searchParams.get(ONE_LOCATION_SUBMISSION_ID_PARAM) || "",
    ).trim();
    const section = String(
      searchParams.get(ONE_LOCATION_SECTION_PARAM) || "",
    ).trim() as OneLocationFocusTarget | "";
    const notificationState = String(
      searchParams.get(ONE_LOCATION_NOTIFICATION_OPEN_PARAM) || "",
    ).trim();
    let focusTarget: OneLocationFocusTarget | null =
      section && [
        "people",
        "approvals",
        "shared",
        "my_requests",
        "public_responses",
        "activity",
      ].includes(section)
        ? section
        : null;
    if (grantId && notificationState === ONE_LOCATION_NOTIFICATION_OPEN_VALUE) {
      markOneLocationGrantOpened(auth.userId, grantId);
      setOpenedGrantTick((value) => value + 1);
      focusTarget = focusTarget || "shared";
    }
    if (requestId) {
      focusTarget =
        focusTarget ||
        (pendingOwnerRequests.some((request) => request.id === requestId)
          ? "approvals"
          : "my_requests");
    }
    if (referralId) {
      focusTarget = focusTarget || "my_requests";
    }
    if (submissionId) {
      focusTarget = focusTarget || "public_responses";
    }
    focusOneLocationSection(focusTarget);
  }, [
    auth.userId,
    focusOneLocationSection,
    pendingOwnerRequests,
    searchParams,
    state,
  ]);

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
    if (!auth.userId || typeof window === "undefined") return;
    const handleGrantUnwatched = (event: Event) => {
      const detail =
        (event as CustomEvent<{ userId?: string; grantId?: string }>).detail ||
        {};
      if (detail.userId && detail.userId !== auth.userId) return;
      setUnwatchedTick((value) => value + 1);
      // Drop any decrypted map point for the unwatched grant immediately.
      const grantId = String(detail.grantId || "").trim();
      if (grantId) {
        setDecryptedPoints((current) => {
          if (!(grantId in current)) return current;
          const next = { ...current };
          delete next[grantId];
          return next;
        });
      }
    };
    window.addEventListener(
      ONE_LOCATION_GRANT_UNWATCHED_EVENT,
      handleGrantUnwatched,
    );
    return () => {
      window.removeEventListener(
        ONE_LOCATION_GRANT_UNWATCHED_EVENT,
        handleGrantUnwatched,
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

  useEffect(() => {
    if (!auth.userId || !state) return;

    for (const request of pendingOwnerRequests) {
      showWorkflowToast({
        notificationType: "location_access_request",
        id: request.id,
        requestId: request.id,
        requesterLabel: requestLabel(request),
        section: "approvals",
      });
    }

    for (const request of requestedByMe) {
      const ownerLabel = requestOwnerLabel(request, recipients);
      if (request.status === "approved") {
        showWorkflowToast({
          notificationType: "location_access_approved",
          id: request.approvedGrantId || request.id,
          requestId: request.id,
          grantId: request.approvedGrantId,
          ownerLabel,
          section: "shared",
          openGrant: Boolean(request.approvedGrantId),
        });
      }
      if (request.status === "denied") {
        showWorkflowToast({
          notificationType: "location_access_denied",
          id: request.id,
          requestId: request.id,
          ownerLabel,
          section: "my_requests",
        });
      }
    }

    // Owners who currently have an ACTIVE share with me. When a person re-shares
    // their location within an existing window, the backend silently supersedes
    // the prior grant (sets it to "revoked" with NO push), so a stale
    // revoked/expired row sits alongside a fresh active one. We must NOT raise a
    // "location removed" / "expired" notification in that case - it is the core
    // source of the false "location removed by this user" spam. Only notify when
    // the owner has genuinely stopped sharing (no active grant remains).
    const ownersWithActiveReceivedGrant = new Set(
      (state.receivedGrants ?? [])
        .filter((grant) => grant.status === "active")
        .map((grant) => String(grant.ownerUserId || "").trim())
        .filter(Boolean),
    );
    for (const grant of state.receivedGrants ?? []) {
      const ownerId = String(grant.ownerUserId || "").trim();
      const supersededByNewerShare =
        Boolean(ownerId) && ownersWithActiveReceivedGrant.has(ownerId);
      // A recipient who unwatched this share does not want any follow-up noise.
      const recipientUnwatched = isOneLocationGrantUnwatched(
        auth.userId,
        grant.id,
      );
      if (supersededByNewerShare || recipientUnwatched) continue;

      if (grant.status === "revoked") {
        showWorkflowToast({
          notificationType: "location_share_revoked",
          id: grant.id,
          grantId: grant.id,
          ownerLabel: receivedGrantOwnerLabel(grant),
          section: "shared",
        });
      }
      if (grant.status === "expired") {
        showWorkflowToast({
          notificationType: "location_share_expired",
          id: grant.id,
          grantId: grant.id,
          ownerLabel: receivedGrantOwnerLabel(grant),
          section: "shared",
        });
      }
    }

    for (const submission of publicSubmissions) {
      if (submission.ownerUserId !== auth.userId) continue;
      showWorkflowToast({
        notificationType: "location_public_invite_submitted",
        id: submission.id,
        submissionId: submission.id,
        visitorLabel: publicSubmissionLabel(submission),
        section: "public_responses",
      });
    }
  }, [
    auth.userId,
    pendingOwnerRequests,
    publicSubmissions,
    recipients,
    requestedByMe,
    showWorkflowToast,
    state,
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
        throw new Error("They need to open One Location once before private sharing can start.");
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

  const resetShareComposer = useCallback(() => {
    suppressAutoRecipientSelectionRef.current = true;
    setSelectedRecipientId("");
    setSelectedRecipientIds([]);
    setShareReviewOpen(false);
  }, []);
  const resetRequestComposer = useCallback(() => {
    suppressAutoRecipientSelectionRef.current = true;
    setSelectedRequestOwnerId("");
    setSelectedRequestOwnerIds([]);
    setRequestMessage("");
  }, []);

  const handleShare = useCallback(async () => {
    if (
      !vaultOwnerToken ||
      !shareReadySelectedRecipients.length ||
      setupNeededSelectedRecipients.length ||
      locationPermissionBlocksSharing(permission)
    )
      return;
    setBusy("share");
    let successCount = 0;
    try {
      const readiness = await ensureForegroundLocationReady({
        capturePoint: true,
        autoOpenSettings: true,
      });
      if (!readiness.ready || !readiness.point) {
        return;
      }
      const point = readiness.point;
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
      resetShareComposer();
      // Signal the redesign hub to close the 3-step share flow and return to
      // the main One Location screen now that sharing finished.
      setShareCompletedTick((value) => value + 1);
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
    ensureForegroundLocationReady,
    permission,
    publishEnvelopeWithRetry,
    refresh,
    resetShareComposer,
    setupNeededSelectedRecipients.length,
    shareReviewOpen,
    shareReadySelectedRecipients,
    vaultOwnerToken,
  ]);

  const handlePublish = useCallback(
    async (grant: OneLocationGrant) => {
      const recipient = recipientForGrant(grant);
      if (!recipient) {
        toast.error("This share needs the recipient to open One Location once.");
        return;
      }
      setBusy("publish");
      try {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
        });
        if (!readiness.ready || !readiness.point) {
          return;
        }
        await publishEnvelopeWithRetry(grant, recipient, "manual", readiness.point);
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
    [ensureForegroundLocationReady, publishEnvelopeWithRetry, recipientForGrant, refresh],
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
              : "Could not view this private location update.",
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

  // Recipient-side "Unwatch": locally hide a received share so it stops
  // appearing in "Shared with me" and stops surfacing notifications. The owner's
  // grant is unaffected server-side (a recipient cannot revoke it); the backend
  // continues to enforce real access. The choice persists across refreshes.
  const handleUnwatch = useCallback(
    (grant: OneLocationGrant) => {
      if (!auth.userId) return;
      markOneLocationGrantUnwatched(auth.userId, grant.id);
      // Optimistically reflect the change even before the event listener fires.
      setUnwatchedTick((value) => value + 1);
      setDecryptedPoints((current) => {
        if (!(grant.id in current)) return current;
        const next = { ...current };
        delete next[grant.id];
        return next;
      });
      toast.success(
        `Stopped watching ${receivedGrantOwnerLabel(grant)}'s location.`,
      );
    },
    [auth.userId],
  );

  // When a received grant is revoked or expires, immediately drop its decrypted
  // map point so the "Shared with me" map view for that person disappears.
  useEffect(() => {
    const activeGrantIds = new Set(
      (state?.receivedGrants ?? [])
        .filter((grant) => grant.status === "active")
        .map((grant) => grant.id),
    );
    setDecryptedPoints((current) => {
      const next: Record<string, PlainLocationPoint> = {};
      let changed = false;
      for (const [grantId, point] of Object.entries(current)) {
        if (activeGrantIds.has(grantId)) {
          next[grantId] = point;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [state?.receivedGrants]);


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
        void refreshLocationPermission();
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
    refreshLocationPermission,
    vaultOwnerToken,
  ]);

  // True LIVE tracking (owner side): while a share is active and the app is in
  // the foreground, subscribe to a continuous geolocation watch and re-publish
  // an encrypted envelope to every active grant as soon as the owner MOVES
  // (>= LIVE_LOCATION_MIN_MOVE_METERS), throttled so GPS jitter / fast motion
  // can't flood the network. This complements the 20s heartbeat above: standing
  // still keeps the point fresh via the interval, while walking/driving streams
  // movement updates so recipients watch the dot move in near real time. The
  // watch is foreground-only and cleans up on unmount or when sharing stops.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!vaultOwnerToken || !activeOwnerGrants.length) return;
    if (
      permission?.state === "denied" ||
      permission?.state === "restricted" ||
      permission?.state === "unavailable"
    ) {
      return;
    }

    let cancelled = false;
    lastPublishedPointRef.current = null;
    lastWatchPublishAtRef.current = 0;

    const publishMovement = async (point: PlainLocationPoint) => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (livePublishInFlightRef.current) return;

      const now = Date.now();
      const previous = lastPublishedPointRef.current;
      const movedMeters = previous
        ? locationDistanceMeters(previous, point)
        : Number.POSITIVE_INFINITY;
      const sincePublishMs = now - lastWatchPublishAtRef.current;

      // Always reflect movement in the owner's own live preview immediately.
      setMyLocationPoint(point);

      if (
        previous &&
        (movedMeters < LIVE_LOCATION_MIN_MOVE_METERS ||
          sincePublishMs < LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS)
      ) {
        return;
      }

      livePublishInFlightRef.current = true;
      try {
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
        lastPublishedPointRef.current = point;
        lastWatchPublishAtRef.current = Date.now();
      } catch (error) {
        console.warn(
          "[OneLocationAgent] Live movement update skipped:",
          error,
        );
      } finally {
        livePublishInFlightRef.current = false;
      }
    };

    void (async () => {
      try {
        const watchId = await OneLocationService.watchCurrentPosition(
          (point) => void publishMovement(point),
          (error) => {
            console.warn("[OneLocationAgent] Live watch error:", error.message);
          },
        );
        if (cancelled) {
          void OneLocationService.clearLocationWatch(watchId).catch(() => null);
          return;
        }
        liveWatchIdRef.current = watchId;
      } catch (error) {
        console.warn("[OneLocationAgent] Could not start live watch:", error);
      }
    })();

    return () => {
      cancelled = true;
      const watchId = liveWatchIdRef.current;
      liveWatchIdRef.current = null;
      if (watchId) {
        void OneLocationService.clearLocationWatch(watchId).catch(() => null);
      }
    };
  }, [
    activeOwnerGrants,
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
      // Track the specific grant being revoked so only its "Stop sharing" card
      // shows the loading state, not every active share at once.
      setRevokingGrantId(grantId);
      try {
        await OneLocationService.revokeGrant({ vaultOwnerToken, grantId });
        toast.success("Location access revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not revoke access.",
        );
      } finally {
        setRevokingGrantId(null);
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
        toast.info("No One users matched from this contact scan.");
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
    if (!auth.user || !auth.userId) {
      toast.error("Refresh your session before sending a location request.");
      return;
    }
    const activeUser = auth.user;
    const activeUserId = auth.userId;
    const activeVaultOwnerToken = vaultOwnerToken;
    setBusy("request");
    let successCount = 0;
    try {
      await AccountIdentityService.syncCurrentUser(activeUser).catch((error) => {
        console.warn("[OneLocation] Failed to sync account identity before request:", error);
      });
      await (async () => {
        try {
          const key = await ensureLocationRecipientKey(activeUserId);
          await OneLocationService.registerRecipientKey({
            vaultOwnerToken: activeVaultOwnerToken,
            keyId: key.keyId,
            publicKeyJwk: key.publicKeyJwk,
            algorithm: key.algorithm,
          });
        } catch (error) {
          console.warn(
            "[OneLocation] Continuing request after key sync failed:",
            error,
          );
        }
      })();
      for (const owner of selectedRequestOwners) {
        await OneLocationService.requestAccess({
          vaultOwnerToken: activeVaultOwnerToken,
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
      resetRequestComposer();
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
  }, [
    auth.user,
    auth.userId,
    refresh,
    requestMessage,
    resetRequestComposer,
    selectedRequestOwners,
    vaultOwnerToken,
  ]);

  const handleCreatePublicInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("publicInvite");
    try {
      const point = await OneLocationService.captureCurrentPosition();
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(durationHours),
        locationSnapshot: point,
      });
      const url = publicInviteUrlLabel(response.publicUrl);
      setPublicInviteUrl(url);
      const copiedToClipboard = url ? await copyToClipboard(url) : false;
      trackEvent("one_location_public_link_created", {
        route_id: "one_location",
        result: "success",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: copiedToClipboard,
        active_invite_count: activePublicInvites.length + 1,
      });
      toast.success(
        copiedToClipboard
          ? "Public location link created and copied."
          : "Public location link created.",
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
        oneLocationErrorMessage(error, "Could not create public location link."),
      );
    } finally {
      setBusy(null);
    }
  }, [activePublicInvites.length, durationHours, refresh, vaultOwnerToken]);

  const handleCopyPublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    try {
      const copiedToClipboard = await copyToClipboard(publicInviteUrl);
      if (copiedToClipboard) {
        toast.success("Public location link copied.");
      } else {
        toast.error("Could not copy the public location link.");
      }
    } catch {
      toast.error("Could not copy the public location link.");
    }
  }, [publicInviteUrl]);

  const handleSharePublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    try {
      const delivery = await shareOneLocationLink({
        title: ONE_LOCATION_SHARE_TITLE,
        text: ONE_LOCATION_PUBLIC_SHARE_COPY,
        url: publicInviteUrl,
        dialogTitle: "Share to contacts",
      });
      if (delivery === "copied") {
        toast.success("Public location link copied.");
      }
    } catch (error) {
      if (isShareAbortError(error)) return;
      toast.error("Could not open the share sheet.");
    }
  }, [publicInviteUrl]);

  const handleShareContactInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("contactInvite");
    try {
      let url = publicInviteUrl;
      if (!url) {
        const point = await OneLocationService.captureCurrentPosition();
        const response = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: Number(durationHours),
          locationSnapshot: point,
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

      const delivery = await shareOneLocationLink({
        title: ONE_LOCATION_SHARE_TITLE,
        text: ONE_LOCATION_PUBLIC_SHARE_COPY,
        url,
        dialogTitle: "Share to contacts",
      });
      if (delivery === "copied") {
        toast.success("Invite link copied.");
      }
    } catch (error) {
      if (isShareAbortError(error)) return;
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

  const handleCreateCircleInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("circleInvite");
    try {
      const response = await OneLocationService.createCircleInvite({
        vaultOwnerToken,
        durationHours: Number(durationHours),
        message: "Join me on One.",
      });
      const url = publicInviteUrlLabel(response.inviteUrl);
      setCircleInviteUrl(url);
      const copiedToClipboard = url ? await copyToClipboard(url) : false;
      trackEvent("one_location_circle_invite_created", {
        route_id: "one_location",
        result: "success",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: copiedToClipboard,
        active_invite_count: activeCircleInvites.length + 1,
      });
      toast.success(
        copiedToClipboard
          ? "Invite to One link created and copied."
          : "Invite to One link created.",
      );
      await refresh();
    } catch (error) {
      trackEvent("one_location_circle_invite_created", {
        route_id: "one_location",
        result: "error",
        duration_bucket: oneLocationDurationBucket(durationHours),
        copied_to_clipboard: false,
        active_invite_count: activeCircleInvites.length,
      });
      toast.error(
        oneLocationErrorMessage(error, "Could not create Invite to One link."),
      );
    } finally {
      setBusy(null);
    }
  }, [activeCircleInvites.length, durationHours, refresh, vaultOwnerToken]);

  const handleCopyCircleInvite = useCallback(async () => {
    if (!circleInviteUrl) return;
    try {
      const copiedToClipboard = await copyToClipboard(circleInviteUrl);
      if (copiedToClipboard) {
        toast.success("Invite to One link copied.");
      } else {
        toast.error("Could not copy the Invite to One link.");
      }
    } catch {
      toast.error("Could not copy the Invite to One link.");
    }
  }, [circleInviteUrl]);

  const handleShareCircleInvite = useCallback(async () => {
    if (!circleInviteUrl) return;
    try {
      const delivery = await shareOneLocationLink({
        title: ONE_LOCATION_SHARE_TITLE,
        text: ONE_LOCATION_CIRCLE_SHARE_COPY,
        url: circleInviteUrl,
        dialogTitle: "Share Invite to One",
      });
      if (delivery === "copied") {
        toast.success("Invite to One link copied.");
      }
    } catch (error) {
      if (isShareAbortError(error)) return;
      toast.error("Could not open the share sheet.");
    }
  }, [circleInviteUrl]);

  const handleRevokeCircleInvite = useCallback(
    async (invite: OneLocationCircleInvite) => {
      if (!vaultOwnerToken || !invite.id) return;
      setBusy("circleRevoke");
      try {
        await OneLocationService.revokeCircleInvite({
          vaultOwnerToken,
          inviteId: invite.id,
        });
        setCircleInviteUrl("");
        toast.success("Invite to One link revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(error, "Could not revoke Invite to One link."),
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

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
        toast.success("Public location link revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(
            error,
            "Could not revoke public location link.",
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
        toast.error("They need to open One Location once before approval can finish.");
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
    !locationPermissionBlocksSharing(permission),
  );
  const handleOpenShareReview = useCallback(async () => {
    if (!canShare) return;
    setBusy("share");
    const readiness = await ensureForegroundLocationReady({
      capturePoint: false,
      autoOpenSettings: true,
    });
    setBusy(null);
    if (!readiness.ready) return;
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
            recipient.recommendationCategory === "professional_network" ||
            recipient.recommendationTier === "kai_network" ||
            Boolean(
              recipient.relationshipType ||
                recipient.profileHeadline ||
                recipient.verificationBadge,
            ),
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
    ensureForegroundLocationReady,
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
  const locationReadiness = useMemo(
    () => readinessCopy(permission),
    [permission],
  );
  const handleRequestLocationPermission = useCallback(async () => {
    setBusy("locationSettings");
    try {
      await ensureForegroundLocationReady({
        capturePoint: false,
        autoOpenSettings: true,
      });
    } finally {
      setBusy(null);
    }
  }, [ensureForegroundLocationReady]);

  const handleShowMyLiveLocation = useCallback(async () => {
    setBusy("selfLocation");
    setMyLocationError(null);
    try {
      const result = await ensureForegroundLocationReady({
        capturePoint: true,
        autoOpenSettings: true,
      });
      if (!result.ready || !result.point) {
        const message = "Live location preview needs device Location permission.";
        setMyLocationError(message);
        return;
      }
      setMyLocationPoint(result.point);
      toast.success("Your live location preview is ready.");
    } catch (error) {
      const message = locationServicesErrorMessage(error);
      setMyLocationError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [ensureForegroundLocationReady]);

  const dismissLocationOnboarding = useCallback(() => {
    // Persist that onboarding is complete so the one-time marketing intro never
    // shows again for this user; only the location-permission screen can
    // re-appear, and only when device location is actually off. We persist on
    // dismissal/completion (not when merely advancing to the permission step)
    // so a partially-seen flow still re-shows next time.
    if (typeof window !== "undefined" && auth.userId) {
      try {
        window.localStorage.setItem(
          `one_location_onboarding_v1:${auth.userId}`,
          "1",
        );
      } catch {
        // localStorage may be unavailable (private mode); intro will simply
        // show again next time, which is acceptable.
      }
    }
    setLocationOnboardingGate("hidden");
    setLocationOnboardingBusy(false);
  }, [auth.userId]);

  const handleContinueLocationOnboardingIntro = useCallback(() => {
    setLocationOnboardingStep("permission");
  }, []);

  const handleDismissFirstRunGuide = useCallback(() => {
    setFirstRunGuideDismissed(true);
    if (typeof window !== "undefined" && auth.userId) {
      try {
        window.localStorage.setItem(
          `${ONE_LOCATION_FIRST_RUN_GUIDE_KEY}:${auth.userId}`,
          "1",
        );
      } catch {
        // localStorage may be unavailable (private mode); the guide will simply
        // show again next time, which is acceptable.
      }
    }
  }, [auth.userId]);

  // Decide whether to show the first-run "how it works" guide. It appears only
  // for genuinely new customers (no shares, requests, or invites yet) who have
  // not dismissed it before. Returning/active users never see it.
  useEffect(() => {
    if (!auth.userId || !state) return;
    let alreadyDismissed = false;
    if (typeof window !== "undefined") {
      try {
        alreadyDismissed =
          window.localStorage.getItem(
            `${ONE_LOCATION_FIRST_RUN_GUIDE_KEY}:${auth.userId}`,
          ) === "1";
      } catch {
        alreadyDismissed = false;
      }
    }
    const hasAnyActivity = Boolean(
      (state.ownerGrants?.length ?? 0) ||
        (state.receivedGrants?.length ?? 0) ||
        (state.requests?.length ?? 0) ||
        (state.publicInvites?.length ?? 0) ||
        (state.circleInvites?.length ?? 0),
    );
    setFirstRunGuideDismissed(alreadyDismissed || hasAnyActivity);
  }, [auth.userId, state]);




  const handleSkipLocationOnboarding = useCallback(() => {
    dismissLocationOnboarding();
  }, [dismissLocationOnboarding]);

  const openLocationSettingsForOnboarding = useCallback(async () => {
    await OneLocationService.openLocationSettings().catch(() => null);
    toast.info("Turn on phone Location, then return to continue.");
    window.setTimeout(() => void refreshLocationPermission(), 1200);
  }, [refreshLocationPermission]);

  const openAppSettingsForOnboarding = useCallback(async () => {
    await OneLocationService.openAppSettings().catch(() => null);
    toast.info("Allow Location for One in Settings, then return.");
    window.setTimeout(() => void refreshLocationPermission(), 1200);
  }, [refreshLocationPermission]);

  const handleLocationOnboardingPermission = useCallback(async () => {
    if (locationOnboardingBusy) return;
    setLocationOnboardingBusy(true);
    try {
      if (isLocationServicesDisabled(permission)) {
        await openLocationSettingsForOnboarding();
        return;
      }

      if (
        permission?.state === "denied" ||
        permission?.state === "restricted"
      ) {
        await openAppSettingsForOnboarding();
        return;
      }

      if (permission?.state === "granted") {
        const refreshedPermission = await refreshLocationPermission();
        if (!isLocationServicesDisabled(refreshedPermission)) {
          dismissLocationOnboarding();
        } else {
          await openLocationSettingsForOnboarding();
        }
        return;
      }

      const requestedPermission =
        await OneLocationService.requestLocationPermission();
      setPermission(requestedPermission);

      if (
        requestedPermission.locationServicesEnabled === false ||
        (requestedPermission.state === "unavailable" &&
          requestedPermission.precise !== false)
      ) {
        await openLocationSettingsForOnboarding();
        return;
      }

      if (requestedPermission.state !== "granted") {
        await openAppSettingsForOnboarding();
        return;
      }

      if (isLocationServicesDisabled(requestedPermission)) {
        await openLocationSettingsForOnboarding();
        return;
      }

      dismissLocationOnboarding();
    } finally {
      setLocationOnboardingBusy(false);
    }
  }, [
    dismissLocationOnboarding,
    locationOnboardingBusy,
    openAppSettingsForOnboarding,
    openLocationSettingsForOnboarding,
    permission,
    refreshLocationPermission,
  ]);

  const nativeTestConfig: OneLocationNativeTestConfig = {
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
  };

  const showLocationOnboarding =
    locationOnboardingGate === "show" &&
    !loadError &&
    Boolean(auth.userId && vaultOwnerToken);

  if (showLocationOnboarding) {
    return (
      <OneLocationOnboardingFlow
        step={locationOnboardingStep}
        busy={locationOnboardingBusy}
        permission={permission}
        nativeTest={nativeTestConfig}
        onContinueIntro={handleContinueLocationOnboardingIntro}
        onRequestPermission={handleLocationOnboardingPermission}
        onSkip={handleSkipLocationOnboarding}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Mobile-first redesign (Figma: one_location_final_fixed_clean_navigation).
  // PRESENTATION ONLY: the view-model below wires the redesigned hub to the
  // EXACT existing state + handlers, so consent gating, crypto, analytics, and
  // routing are unchanged. The full original UI remains intact below and is
  // used for the loading/error states (and as a guaranteed fallback). The
  // global app footer is never touched.
  // ---------------------------------------------------------------------------
  const USE_LOCATION_REDESIGN = true;

  const locationHubVm: LocationHubViewModel = {
    userId: auth.userId ?? null,
    canShare,
    busy,
    revokingGrantId,
    shareCompletedTick,
    readiness: {

      tone: locationReadiness.tone,
      title: locationReadiness.title,
      description: locationReadiness.description,
      actionLabel: locationReadiness.actionLabel ?? null,
    },
    permissionIsPrompt: permission?.state === "prompt",
    myLocationPoint,
    myLocationError,
    recipients: rankedRecipients,
    visibleRecipients,
    activeOwnerGrants,
    receivedGrants: visibleReceivedGrants,
    pendingOwnerRequests,
    requestedByMe,
    latestActivePublicInvite,
    latestActiveCircleInvite,
    activityReceipts: (locationActivity?.events ?? []).map((event) => ({
      id: event.id,
      title: event.title,
      detail: event.detail,
    })),
    recipientSearch,
    selectedRecipientIds,
    selectedRequestOwnerIds,
    durationHours,
    requestMessage,
    shareReviewOpen,
    publicInviteUrl,
    circleInviteUrl,
    setRecipientSearch,
    setDurationHours,
    setRequestMessage,
    setShareReviewOpen,
    toggleShareRecipient: (id) => toggleShareRecipient(id, "section_list"),
    toggleRequestOwner: (id) => toggleRequestOwner(id, "section_list"),
    onRefresh: () => void refresh(),
    onShowMyLocation: () => void handleShowMyLiveLocation(),
    onRequestPermission: () => void handleRequestLocationPermission(),
    onOpenLocationSettings: () => void handleOpenLocationSettings(),
    onSyncContacts: () => void handleSyncContactSignal(),
    onShareToContacts: () => void handleShareContactInvite(),
    onOpenShareReview: () => void handleOpenShareReview(),
    onConfirmShare: () => void handleShare(),
    onSendRequest: () => void handleRequestAccess(),
    onApprove: (request) => void handleApprove(request),
    onDeny: (requestId) => void handleDeny(requestId),
    onViewGrant: (grant) => void handleView(grant),
    onUnwatchGrant: (grant) => handleUnwatch(grant),
    onStopGrant: (grantId) => void handleRevoke(grantId),
    onCreatePublicInvite: () => void handleCreatePublicInvite(),
    onCopyPublicInvite: () => void handleCopyPublicInvite(),
    onSharePublicInvite: () => void handleSharePublicInvite(),
    onRevokePublicInvite: (invite) => void handleRevokePublicInvite(invite),
    onCreateCircleInvite: () => void handleCreateCircleInvite(),
    onCopyCircleInvite: () => void handleCopyCircleInvite(),
    onShareCircleInvite: () => void handleShareCircleInvite(),
    onRevokeCircleInvite: (invite) => void handleRevokeCircleInvite(invite),
    recipientLabel,
    recipientSubtitle: recipientRecommendationLine,
    isRecipientShareReady: isShareReadyRecipient,
    requestOwnerLabel: (request) => requestOwnerLabel(request, recipients),
    requesterLabel: requestLabel,
    grantRecipientLabel: grantCounterpartyLabel,
    grantOwnerLabel: receivedGrantOwnerLabel,
    formatDateTime,
    expiresLabel: (value) =>
      value ? `Live until ${formatDateTime(value)}` : "Live now",
    expiresCountdownLabel: (value) => expiresCountdownLabel(value) ?? "Active",
    renderMapPreview: (point, showNavigation) => (
      <LocalMapPreview point={point} showNavigation={showNavigation} />
    ),
    decryptedPoints,
  };

  if (USE_LOCATION_REDESIGN && !loadError) {
    return (
      <AppPageShell width="standard" nativeTest={nativeTestConfig}>
        <AppPageContentRegion className="mx-auto w-full max-w-[480px] min-w-0 space-y-6 overflow-x-hidden px-3 pb-12 pt-4">
          {showInitialSkeleton ? (
            <LocationRedesignSkeleton />
          ) : (
            <LocationRedesignHub vm={locationHubVm} />
          )}
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell
      width="standard"
      nativeTest={nativeTestConfig}
    >
      <AppPageHeaderRegion className="mx-auto w-full max-w-[720px] min-w-0 overflow-hidden">
        <div className="flex flex-col gap-4 px-1 pt-3 sm:flex-row sm:items-end sm:justify-between">
          <header className="max-w-[560px] min-w-0 space-y-2">
            <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-[#007aff] dark:text-[#76b7ff]">
              Private location sharing
            </span>
            <h1 className="text-[28px] font-medium leading-[1.12] tracking-normal text-[#1c1c1e] sm:text-[32px] dark:text-white">
              Your circle, safely connected.
            </h1>
            <h2 className="sr-only">One Location Agent</h2>
            <p className="max-w-[460px] text-[16px] font-medium leading-snug text-[#8e8e93] dark:text-white/55">
              Let the people you trust see where you are - only when you choose,
              only for as long as you choose. We can never see it.
            </p>
          </header>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy === "load"}
              className="h-9 w-full rounded-full border-black/[0.06] bg-white/80 px-3 text-[#1c1c1e] shadow-sm backdrop-blur-xl hover:bg-[#f2f2f7] hover:text-[#1c1c1e] sm:w-fit dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
            >
              {busy === "load" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mx-auto w-full max-w-[720px] min-w-0 space-y-6 overflow-x-hidden pb-10 sm:pb-8">
        {loadError ? (
          <div className="rounded-[20px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-4 text-sm text-[#ff3b30] dark:text-[#ff9f9a]">
            {loadError}
          </div>
        ) : null}

        {showInitialSkeleton ? (
          <OneLocationInitialSkeleton />
        ) : (
          <div className="flex min-w-0 max-w-full flex-col gap-6">
            <div className="px-1">
              <SegmentedTabs
                value={locationTab}
                onValueChange={(value) =>
                  setLocationTab(normalizeLocationTab(value))
                }
                options={
                  pendingOwnerRequests.length
                    ? LOCATION_TAB_OPTIONS.map((option) =>
                        option.value === "activity"
                          ? {
                              ...option,
                              label: `${option.label} (${pendingOwnerRequests.length})`,
                            }
                          : option,
                      )
                    : LOCATION_TAB_OPTIONS
                }
              />
            </div>

            {!firstRunGuideDismissed ? (
              <div className="px-1">
                <OneLocationFirstRunGuide
                  onDismiss={handleDismissFirstRunGuide}
                />
              </div>
            ) : null}

            <div className="px-1">
              <OneLocationTrustStrip />
            </div>
            {pendingOwnerRequests.length && locationTab !== "activity" ? (
              <button
                type="button"
                onClick={() => setLocationTab("activity")}
                className="mx-1 flex items-center gap-2 rounded-[14px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 px-3.5 py-2.5 text-left text-[13px] font-semibold text-[#b42318] transition-colors hover:bg-[#ff3b30]/15 dark:text-[#ff9f9a]"
              >
                <UserRoundCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {pendingOwnerRequests.length === 1
                    ? "1 person is waiting for you to approve their location request."
                    : `${pendingOwnerRequests.length} people are waiting for you to approve their location requests.`}
                </span>
                <span className="shrink-0 underline">Review</span>
              </button>
            ) : null}

            <div
              className={cn(
                "min-w-0 max-w-full space-y-7",
                locationTab === "compose" ? "" : "hidden",
              )}
            >
              <section className="min-w-0 max-w-full space-y-2 px-1">
                {sectionLabel("Device readiness")}

                <div
                  className={cn(
                    "flex min-w-0 max-w-full flex-col items-center gap-3 overflow-hidden rounded-[20px] border px-4 py-4 text-center shadow-sm sm:flex-row sm:justify-between sm:text-left",
                    locationReadiness.tone === "ready" &&
                      "border-[#34c759]/25 bg-[#34c759]/10 text-[#1c1c1e] dark:text-white",
                    locationReadiness.tone === "warning" &&
                      "border-[#ff9500]/30 bg-[#ff9500]/10 text-[#1c1c1e] dark:text-white",
                    locationReadiness.tone === "blocked" &&
                      "border-[#ff3b30]/30 bg-[#ff3b30]/10 text-[#1c1c1e] dark:text-white",
                    locationReadiness.tone === "checking" &&
                      "border-black/[0.04] bg-white/70 text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-white",
                  )}
                >
                  <div className="flex min-w-0 flex-col items-center gap-3 sm:flex-row sm:items-center">
                    <span
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        locationReadiness.tone === "ready" &&
                          "bg-[#34c759]/15 text-[#2dbd5a]",
                        locationReadiness.tone === "warning" &&
                          "bg-[#ff9500]/15 text-[#ff9500]",
                        locationReadiness.tone === "blocked" &&
                          "bg-[#ff3b30]/15 text-[#ff3b30]",
                        locationReadiness.tone === "checking" &&
                          "bg-[#007aff]/15 text-[#007aff]",
                      )}
                    >
                      {locationReadiness.tone === "ready" ? (
                        <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                      ) : locationReadiness.tone === "checking" ? (
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 space-y-1">
                      <h3 className="break-words text-[16px] font-semibold tracking-tight [overflow-wrap:anywhere]">
                        {locationReadiness.title}
                      </h3>
                      <p className="max-w-[34rem] break-words text-[12.5px] font-medium leading-5 text-[#5f6368] [overflow-wrap:anywhere] dark:text-white/55">
                        {locationReadiness.description}
                      </p>
                    </div>
                  </div>
                  {locationReadiness.actionLabel ? (
                    <ActionButton
                      busy={busy}
                      busyKey="locationSettings"
                      onClick={
                        permission?.state === "prompt"
                          ? () => void handleRequestLocationPermission()
                          : () => void handleOpenLocationSettings()
                      }
                      variant="outline"
                      className="h-10 w-full shrink-0 rounded-full border-black/[0.06] bg-white px-4 text-[13px] font-semibold text-[#1c1c1e] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      {busy !== "locationSettings" ? (
                        <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                      ) : null}
                      {locationReadiness.actionLabel}
                    </ActionButton>
                  ) : null}
                </div>

                <div className="overflow-hidden rounded-[20px] border border-black/[0.06] bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
                  <div className="p-3.5">
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={() => void handleShowMyLiveLocation()}
                      disabled={busy !== null && busy !== "selfLocation"}
                      className="h-11 w-full shrink-0 rounded-full bg-[#007aff] px-4 text-[14px] font-semibold text-white hover:bg-[#006fe6]"
                    >
                      {busy === "selfLocation" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <LocateFixed className="mr-2 h-4 w-4" aria-hidden="true" />
                      )}
                      {myLocationPoint ? "Refresh location" : "Show my location"}
                    </Button>
                  </div>

                  {myLocationError ? (
                    <div className="mx-3.5 mb-3.5 rounded-[14px] border border-[#ff3b30]/25 bg-[#ff3b30]/10 px-3 py-2 text-[12px] font-medium text-[#b42318] dark:text-[#ff9f9a]">
                      {myLocationError}
                    </div>
                  ) : null}

                  {myLocationPoint ? (
                    <div className="px-3.5 pb-3.5">
                      <LocalMapPreview
                        point={myLocationPoint}
                        showNavigation={false}
                      />
                    </div>
                  ) : null}

                </div>
              </section>

              <section className="min-w-0 max-w-full space-y-4 px-1">
                <SegmentedModeControl
                  value={activeMode}
                  onChange={setActiveMode}
                />

                <div className="flex min-w-0 max-w-full flex-col gap-3">
                  {sectionLabel("One Network")}
                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8e8e93]" />
                    <input
                      value={recipientSearch}
                      onChange={(event) =>
                        setRecipientSearch(event.target.value)
                      }
                      className="h-10 w-full rounded-[14px] border border-black/[0.04] bg-white pl-10 pr-4 text-[15px] text-[#1c1c1e] shadow-sm outline-none transition-shadow placeholder:text-[#8e8e93] focus:ring-2 focus:ring-[#007aff]/20 dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white"
                      placeholder="Search One Network..."
                      type="text"
                    />
                  </div>

                  <div className="min-w-0 max-w-full overflow-hidden rounded-[14px] border border-black/[0.04] bg-white/70 p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ActionButton
                        busy={busy}
                        busyKey="contactSync"
                        onClick={() => void handleSyncContactSignal()}
                        disabled={!auth.user || busy === "contactInvite"}
                        variant="outline"
                        className="h-10 w-full min-w-0 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#1c1c1e] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
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
                        className="h-10 w-full min-w-0 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#007aff] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15 dark:hover:text-white"
                      >
                        {busy !== "contactInvite" ? (
                          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        ) : null}
                        Share to Contacts
                      </ActionButton>
                    </div>
                  </div>

                  <div
                    id="one-network-contact-list"
                    className={
                      showExpandedOneNetworkList
                        ? oneScrollablePanelClassName
                        : onePanelClassName
                    }
                  >
                    {visibleRecipients.length ? (
                      displayedVisibleRecipients.map((recipient, index) => {
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
                            className="relative flex min-w-0 max-w-full flex-col gap-2.5 overflow-hidden p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              <AvatarBubble
                                label={label}
                                index={index}
                                size="sm"
                                muted={!recipient.canReceiveLocation}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  <span className="min-w-0 max-w-full truncate text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
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
                                <p className="mt-0.5 break-words text-[12px] font-medium text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
                                <CheckCircle2 className="mt-1 h-[22px] w-[22px] shrink-0 text-[#007aff] dark:text-[#76b7ff]" />
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Select ${recipientLabel(
                                    recipient,
                                  )} from One Network`}
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
                                  className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[#f2f2f7] px-3 text-[12px] font-semibold text-[#007aff] transition-colors hover:bg-[#e5e5ea] hover:text-[#1c1c1e] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15 dark:hover:text-white"
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
                            ? "No One Network matches"
                            : "One Network is empty"
                        }
                        description={
                          recipients.length
                            ? "Try another name, role, or recommendation signal."
                            : "Approval, professional, ready, and setup signals will appear as your One Network grows."
                        }
                      />
                    )}
                  </div>

                  {hasMoreVisibleRecipients ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-controls="one-network-contact-list"
                      aria-expanded={showExpandedOneNetworkList}
                      onClick={() =>
                        setOneNetworkListExpanded((expanded) => !expanded)
                      }
                      className="h-9 w-full rounded-full border-black/[0.06] bg-white text-[13px] font-semibold text-[#007aff] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      {showExpandedOneNetworkList ? (
                        <ChevronUp className="mr-2 h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronDown
                          className="mr-2 h-4 w-4"
                          aria-hidden="true"
                        />
                      )}
                      {showExpandedOneNetworkList
                        ? "Show less"
                        : `View more (${visibleRecipients.length - ONE_NETWORK_PREVIEW_LIMIT})`}
                    </Button>
                  ) : null}

                  <div className="order-first min-w-0 max-w-full overflow-hidden rounded-[18px] border border-black/[0.04] bg-white/80 p-3.5 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]">
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
                              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] hover:text-[#1c1c1e] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25 dark:hover:text-white"
                            >
                              <span className="min-w-0 truncate">
                                {recipientLabel(recipient)}
                              </span>
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
                          need to open One Location once before private sharing
                          can start.
                        </div>
                      ) : null}
                      <p className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                        {selectedShareRecipients.length
                          ? `${peopleCountLabel(
                              selectedShareRecipients.length,
                            )} selected for private sharing.`
                          : "Select one or more One users for private sharing."}
                      </p>
                      {shareReviewOpen ? (
                        <div
                          role="region"
                          aria-label="Share safety review"
                          className="min-w-0 max-w-full space-y-3 overflow-hidden rounded-[14px] border border-[#007aff]/20 bg-[#eef5ff] p-3 text-[13px] leading-5 text-[#17446f] dark:border-[#0a84ff]/30 dark:bg-[#0a84ff]/15 dark:text-[#cfe7ff]"
                        >
                          <div>
                            <p className="font-semibold text-[#0b3d70] dark:text-[#e6f2ff]">
                              Confirm private One user sharing
                            </p>
                            <p className="mt-1">
                              {peopleCountLabel(
                                shareReadySelectedRecipients.length,
                              )}{" "}
                              will receive separate private location access
                              for{" "}
                              {
                                DURATION_OPTIONS.find(
                                  (option) => option.value === durationHours,
                                )?.label
                              }
                              .
                            </p>
                          </div>
                          <p className="flex items-center gap-1.5 text-[12px] font-medium text-[#17446f]/80 dark:text-[#cfe7ff]/80">
                            <ShieldCheck
                              className="h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            Encrypted end-to-end, auto-stops when the timer ends,
                            and you can stop early anytime.
                          </p>
                          <ActionButton
                            busy={busy}
                            busyKey="share"
                            onClick={() => void handleShare()}
                            disabled={!canShare}
                            className="h-10 w-full min-w-0 rounded-full bg-[#007aff] px-4 text-[13px] font-semibold text-white hover:bg-[#006fe6] sm:w-auto"
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
                        onClick={() => void handleOpenShareReview()}
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
                              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] hover:text-[#1c1c1e] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25 dark:hover:text-white"
                            >
                              <span className="min-w-0 truncate">
                                {recipientLabel(recipient)}
                              </span>
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
                          : "Select one or more One users before requesting location access."}
                      </p>
                      <div className="space-y-1">
                        <Textarea
                          value={requestMessage}
                          onChange={(event) =>
                            setRequestMessage(
                              event.target.value.slice(
                                0,
                                REQUEST_MESSAGE_MAX_LENGTH,
                              ),
                            )
                          }
                          placeholder="Optional reason"
                          rows={3}
                          maxLength={REQUEST_MESSAGE_MAX_LENGTH}
                          className="rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
                        />
                        <p className="px-1 text-right text-[11px] font-medium text-[#8e8e93] dark:text-white/45">
                          {requestMessage.length}/{REQUEST_MESSAGE_MAX_LENGTH}
                        </p>
                      </div>

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
                </div>
              </section>
            </div>

            <div
              className={cn(
                "min-w-0 max-w-full space-y-6",
                locationTab === "activity" ? "" : "hidden",
              )}
            >
              {SHOW_LOCATION_ACTIVITY_SECTION ? (

                <section
                  ref={activitySectionRef}
                  tabIndex={-1}
                  className={cn(
                    "min-w-0 max-w-full outline-none",
                    sectionFocusClassName("activity"),
                  )}
                >
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
                </section>
              ) : null}

              {SHOW_OWNER_GRANTS_SECTION ? (
                <section
                  ref={peopleSectionRef}
                  tabIndex={-1}
                  className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("people"))}
                >
                  {sectionLabel("People who can see me")}
                  <div className={oneScrollablePanelClassName}>
                    {(state?.ownerGrants ?? []).length ? (
                      state?.ownerGrants.map((grant, index) => (
                        <div
                          key={grant.id}
                          className="relative flex min-w-0 max-w-full flex-col gap-3 overflow-hidden p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] sm:flex-row sm:items-center last:after:hidden dark:after:border-white/[0.08]"
                        >
                          <AvatarBubble
                            label={grantCounterpartyLabel(grant)}
                            index={index}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <h3 className="break-words text-[16px] font-medium tracking-tight text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                              {grantCounterpartyLabel(grant)}
                            </h3>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <Badge variant={statusVariant(grant.status)}>
                                {grant.status}
                              </Badge>
                              <span className="min-w-0 break-words text-[12px] font-medium text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                                {expiresLabel(grant)} - {grant.durationHours}h
                              </span>
                            </div>
                          </div>
                          {grant.status === "active" ? (
                            <div className="flex w-full shrink-0 justify-end gap-1.5 sm:w-auto">
                              <Button
                                aria-label="Update share"
                                variant="outline"
                                size="icon"
                                onClick={() => void handlePublish(grant)}
                                disabled={busy === "publish"}
                                className="h-8 w-8 rounded-full border-0 bg-[#f2f2f7] text-[#8e8e93] hover:bg-[#e5e5ea] hover:text-[#1c1c1e] dark:bg-white/10 dark:text-white/55 dark:hover:bg-white/15 dark:hover:text-white"
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
              ) : null}

              <section
                ref={approvalsSectionRef}
                tabIndex={-1}
                className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("approvals"))}
              >
                {sectionLabel("Approvals", pendingOwnerRequests.length)}
                <div
                  className={cn(
                    oneScrollablePanelClassName,
                    pendingOwnerRequests.length &&
                      "relative before:absolute before:bottom-0 before:left-0 before:top-0 before:w-1 before:bg-[#ff3b30]",
                  )}
                >
                  {pendingOwnerRequests.length ? (
                    pendingOwnerRequests.map((request) => (
                      <div key={request.id} className="flex min-w-0 max-w-full items-start gap-3 overflow-hidden p-3.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <UserRoundCheck className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <h3 className="break-words text-[16px] font-semibold tracking-tight text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                            {requestLabel(request)}
                          </h3>
                          <p className="text-[13px] font-medium leading-relaxed text-[#8e8e93] dark:text-white/55">
                            {request.message ||
                              `Requested ${formatDateTime(request.requestedAt)}`}
                          </p>
                          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
                            <Button
                              variant="outline"
                              onClick={() => void handleDeny(request.id)}
                              disabled={busy === "deny"}
                              className="h-9 flex-1 rounded-[12px] border-0 bg-[#f2f2f7] font-semibold text-[#1c1c1e] hover:bg-[#e5e5ea] hover:text-[#1c1c1e] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
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

              <section className="min-w-0 max-w-full space-y-2 px-1">
                {sectionLabel("Invite to One")}
                <div className={cn(onePanelClassName, "space-y-4 p-3.5")}>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <div className={cn(oneInsetClassName, "min-w-0 px-3 py-2 text-sm")}>
                      {circleInviteUrl ? (
                        <span
                          title={circleInviteUrl}
                          aria-label={`Invite to One link ${circleInviteUrl}`}
                          className="block truncate text-[13px] font-medium text-[#1c1c1e] dark:text-white"
                        >
                          {publicInviteUrlPreview(circleInviteUrl)}
                        </span>
                      ) : (
                        <span className={cn(oneSecondaryTextClassName, "block text-[13px] leading-5")}>
                          Share an Invite to One link. After they sign in, verify phone, and accept it, both of you become One Network connections. Live location sharing still starts only from an explicit Share Location action.
                        </span>
                      )}
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
                  <div className="grid min-w-0 max-w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                    <ActionButton
                      busy={busy}
                      busyKey="circleInvite"
                      onClick={() => void handleCreateCircleInvite()}
                      disabled={!vaultOwnerToken}
                      className="w-full min-w-0 rounded-full bg-[#007aff] text-white hover:bg-[#0066ff] sm:w-auto"
                    >
                      <UserPlus className="mr-2 h-4 w-4" />
                      Create Circle Invite
                    </ActionButton>
                    <Button
                      variant="outline"
                      onClick={() => void handleShareCircleInvite()}
                      disabled={!circleInviteUrl}
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-white hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyCircleInvite()}
                      disabled={!circleInviteUrl}
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-white hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                  </div>
                  {latestActiveCircleInvite ? (
                    <div className="space-y-2">
                      <div className="flex flex-col gap-3 rounded-[14px] bg-[#f2f2f7] p-3 sm:flex-row sm:items-center sm:justify-between dark:bg-white/10">
                        <div className="min-w-0">
                          <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                            Latest active Invite to One link
                          </p>
                          <p className="break-words text-[12px] text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                            Expires {formatDateTime(latestActiveCircleInvite.expiresAt)}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleRevokeCircleInvite(latestActiveCircleInvite)
                          }
                          disabled={busy === "circleRevoke"}
                          className="w-full rounded-full border-black/[0.06] bg-white text-[#1c1c1e] hover:bg-[#f2f2f7] hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="min-w-0 max-w-full space-y-2 px-1">
                {sectionLabel("Create public link")}
                <div className={cn(onePanelClassName, "space-y-4 p-3.5")}>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <div className={cn(oneInsetClassName, "min-w-0 px-3 py-2 text-sm")}>
                      {publicInviteUrl ? (
                        <span
                          title={publicInviteUrl}
                          aria-label={`Public location link ${publicInviteUrl}`}
                          className="block truncate text-[13px] font-medium text-[#1c1c1e] dark:text-white"
                        >
                          {publicInviteUrlPreview(publicInviteUrl)}
                        </span>
                      ) : (
                        <span className={cn(oneSecondaryTextClassName, "block text-[13px] leading-5")}>
                          Create a fresh public location link to copy or share.
                        </span>
                      )}
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
                  <div className="grid min-w-0 max-w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                    <ActionButton
                      busy={busy}
                      busyKey="publicInvite"
                      onClick={() => void handleCreatePublicInvite()}
                      disabled={!vaultOwnerToken}
                      className="w-full min-w-0 rounded-full bg-[#007aff] text-white hover:bg-[#0066ff] sm:w-auto"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Create Public Link
                    </ActionButton>
                    <Button
                      variant="outline"
                      onClick={() => void handleSharePublicInvite()}
                      disabled={!publicInviteUrl}
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-white hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyPublicInvite()}
                      disabled={!publicInviteUrl}
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-white hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                  </div>
                  {latestActivePublicInvite ? (
                    <div className="space-y-2">
                      <div className="flex flex-col gap-3 rounded-[14px] bg-[#f2f2f7] p-3 sm:flex-row sm:items-center sm:justify-between dark:bg-white/10">
                        <div className="min-w-0">
                          <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                            Latest active public link
                          </p>
                          <p className="break-words text-[12px] text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                            Expires {formatDateTime(latestActivePublicInvite.expiresAt)}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleRevokePublicInvite(latestActivePublicInvite)
                          }
                          disabled={busy === "publicRevoke"}
                          className="w-full rounded-full border-black/[0.06] bg-white text-[#1c1c1e] hover:bg-[#f2f2f7] hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <section
                ref={sharedSectionRef}
                tabIndex={-1}
                className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("shared"))}
              >
                {sectionLabel("Shared with me")}
                <div className={oneScrollablePanelClassName}>
                  {visibleReceivedGrants.length ? (
                    visibleReceivedGrants.map((grant, index) => {
                      const point = decryptedPoints[grant.id];
                      return (
                        <div
                          key={grant.id}
                          className="min-w-0 max-w-full overflow-hidden border-b border-black/[0.05] last:border-b-0 dark:border-white/[0.08]"
                        >
                          <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center">
                            <AvatarBubble
                              label={receivedGrantOwnerLabel(grant)}
                              index={index + 2}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <h3 className="break-words text-[16px] font-medium tracking-tight text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                                {receivedGrantOwnerLabel(grant)}
                              </h3>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <Badge variant={statusVariant(grant.status)}>
                                  {grant.status}
                                </Badge>
                                {grant.status === "active" &&
                                expiresCountdownLabel(grant.expiresAt) ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[#34c759]/12 px-2 py-0.5 text-[11px] font-semibold text-[#2dbd5a] dark:bg-[#34c759]/15">
                                    <Clock3
                                      className="h-3 w-3"
                                      aria-hidden="true"
                                    />
                                    {expiresCountdownLabel(grant.expiresAt)}
                                  </span>
                                ) : null}
                                <span className="min-w-0 break-words text-[12px] font-medium text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                                  {expiresLabel(grant)}
                                </span>
                              </div>
                            </div>
                            {grant.status === "active" ? (
                              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleView(grant)}
                                  disabled={busy === "view"}
                                  className="w-full rounded-full border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] hover:bg-white hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
                                >
                                  {busy === "view" ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <ShieldCheck className="mr-2 h-4 w-4" />
                                  )}
                                  View
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={`Stop watching ${receivedGrantOwnerLabel(grant)}'s location`}
                                  onClick={() => handleUnwatch(grant)}
                                  className="w-full rounded-full border-black/[0.06] bg-transparent text-[#8e8e93] hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] sm:w-auto dark:border-white/[0.08] dark:text-white/55 dark:hover:bg-[#ff453a]/15 dark:hover:text-[#ff9f9a]"
                                >
                                  <X className="mr-2 h-4 w-4" />
                                  Unwatch
                                </Button>
                              </div>
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
                        unwatchedActiveReceivedGrantCount > 0
                          ? "You unwatched your active shares"
                          : "Nothing shared with you"
                      }
                      description={
                        unwatchedActiveReceivedGrantCount > 0
                          ? "Refresh to start watching a hidden share again, or ask them to re-share."
                          : "When someone shares their live location with you, it appears here automatically - no need to open a notification."
                      }
                    />
                  )}
                </div>
              </section>

              {SHOW_PUBLIC_RESPONSES_SECTION ? (
                <section
                  ref={publicResponsesSectionRef}
                  tabIndex={-1}
                  className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("public_responses"))}
                >
                  {sectionLabel("Public link responses")}
                  <div className={oneScrollablePanelClassName}>
                    {publicSubmissions.length ? (
                      publicSubmissions.map((submission) => (
                        <div
                          key={submission.id}
                          className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden p-3.5 sm:flex-row sm:items-center"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                            <ExternalLink className="h-[18px] w-[18px]" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <h3 className="break-words text-[16px] font-medium text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                              {publicSubmissionLabel(submission)}
                            </h3>
                            <p className="break-words text-[12px] text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
                        description="Responses from your public location link show up here after visitors open it."
                      />
                    )}
                  </div>
                </section>
              ) : null}

              {SHOW_REFERRAL_SECTION ? (
                <section className="min-w-0 max-w-full space-y-2 px-1">
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
                            className="grid min-w-0 max-w-full gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
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
                              className="w-full min-w-0 rounded-full border-black/[0.06] bg-white text-[#1c1c1e] hover:bg-[#f2f2f7] hover:text-[#1c1c1e] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15 dark:hover:text-white"
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
              ) : null}

              {requestedByMe.length ? (
                <section
                  ref={myRequestsSectionRef}
                  tabIndex={-1}
                  className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("my_requests"))}
                >
                  {sectionLabel("My requests")}
                  <div className={oneScrollablePanelClassName}>
                    {requestedByMe.map((request) => (
                      <div
                        key={request.id}
                        className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden p-3.5 sm:flex-row sm:items-center"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <Clock3 className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="break-words text-[16px] font-medium text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                            {requestOwnerLabel(request, recipients)}
                          </h3>
                          <p className="break-words text-[12px] text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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

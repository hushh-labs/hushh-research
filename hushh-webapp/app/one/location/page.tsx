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
  Sparkles,
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
  buildOneLocationWorkflowHref,
  isOneLocationGrantOpened,
  locationShareNotificationDescription,
  locationWorkflowNotificationCopy,
  markOneLocationGrantOpened,
  ONE_LOCATION_GRANT_ID_PARAM,
  ONE_LOCATION_GRANT_OPENED_EVENT,
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
  OneLocationOnboardingOverlay,
  useOneLocationOnboarding,
  type OneLocationTourStepId,
  type OneLocationTourTargets,
} from "@/components/one-location/onboarding-overlay";
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
  | "locationSettings"
  | "selfLocation"
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
type OneLocationFocusTarget = OneLocationNotificationSection;
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
    title: "Location-ready One users",
    description: "One users ready for private sharing.",
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
    title: "No ready One users yet",
    description: "One users with location keys will appear here.",
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
        ? "No One users matched from this scan."
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
  "w-full min-w-0 max-w-full overflow-hidden rounded-[20px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_38px_rgba(0,0,0,0.28)]";
const oneInsetClassName =
  "w-full min-w-0 max-w-full overflow-hidden rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white";
const oneSecondaryTextClassName = "text-[#8e8e93] dark:text-white/55";

function sectionLabel(title: string, count?: number) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45"
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
    <div className="flex w-full min-w-0 max-w-full items-start gap-3 overflow-hidden rounded-[20px] border border-black/[0.06] bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.06)] sm:gap-4 dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
          toneClassName,
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[16px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
          {title}
        </h3>
        <p className="mt-1 break-words text-[14px] font-medium leading-snug text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
    <div className="flex h-9 w-full min-w-0 max-w-full items-center overflow-hidden rounded-[9px] bg-[#efeff0] p-[3px] dark:bg-white/10">
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
        : "Foreground location is ready for encrypted sharing.",
    tone: permission.precise === false ? "warning" : "ready",
  };
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

function OneLocationAgentPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useRequireAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [state, setState] = useState<OneLocationState | null>(null);
  const [permission, setPermission] =
    useState<HushhLocationPermissionState | null>(null);
  const {
    shouldShow: showOnboarding,
    dismiss: dismissOnboarding,
    showTour,
  } = useOneLocationOnboarding();
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
  const [myLocationPoint, setMyLocationPoint] =
    useState<PlainLocationPoint | null>(null);
  const [myLocationError, setMyLocationError] = useState<string | null>(null);
  const [decryptedPoints, setDecryptedPoints] = useState<
    Record<string, PlainLocationPoint>
  >({});
  const [openedGrantTick, setOpenedGrantTick] = useState(0);
  const [focusedSection, setFocusedSection] =
    useState<OneLocationFocusTarget | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const permissionPromptInFlightRef = useRef(false);
  const peopleSectionRef = useRef<HTMLElement | null>(null);
  const approvalsSectionRef = useRef<HTMLElement | null>(null);
  const sharedSectionRef = useRef<HTMLElement | null>(null);
  const myRequestsSectionRef = useRef<HTMLElement | null>(null);
  const publicResponsesSectionRef = useRef<HTMLElement | null>(null);
  const activitySectionRef = useRef<HTMLElement | null>(null);
  const readinessTourRef = useRef<HTMLElement | null>(null);
  const promisesTourRef = useRef<HTMLElement | null>(null);
  const oneNetworkTourRef = useRef<HTMLElement | null>(null);
  const contactSignalTourRef = useRef<HTMLDivElement | null>(null);
  const shareRequestTourRef = useRef<HTMLDivElement | null>(null);
  const accessHistoryTourRef = useRef<HTMLDivElement | null>(null);
  const focusClearRef = useRef<number | null>(null);
  const livePublishInFlightRef = useRef(false);
  const liveViewInFlightRef = useRef(false);
  const [activeTourStep, setActiveTourStep] =
    useState<OneLocationTourStepId | null>(null);

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
  const onboardingTourTargets = useMemo<OneLocationTourTargets>(
    () => ({
      readiness: readinessTourRef,
      promises: promisesTourRef,
      one_network: oneNetworkTourRef,
      contact_signal: contactSignalTourRef,
      share_request: shareRequestTourRef,
      activity: activitySectionRef,
      access_history: accessHistoryTourRef,
    }),
    [],
  );

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
      window.setTimeout(() => {
        const element = sectionRefs[target]?.current;
        if (!element) return;
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        element.focus({ preventScroll: true });
        setFocusedSection(target);
        if (focusClearRef.current) {
          window.clearTimeout(focusClearRef.current);
        }
        focusClearRef.current = window.setTimeout(() => {
          setFocusedSection((current) => (current === target ? null : current));
        }, 2200);
      }, 80);
    },
    [],
  );

  const sectionFocusClassName = useCallback(
    (target: OneLocationFocusTarget) =>
      focusedSection === target
        ? "rounded-[22px] ring-2 ring-[#007aff]/35 ring-offset-2 ring-offset-transparent"
        : "",
    [focusedSection],
  );
  const tourSectionClassName = useCallback(
    (target: OneLocationTourStepId) =>
      activeTourStep === target
        ? "relative rounded-[22px] ring-2 ring-[#007aff]/50 ring-offset-4 ring-offset-white/80 transition-shadow duration-300 dark:ring-offset-[#111113]/80"
        : "transition-shadow duration-300",
    [activeTourStep],
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
    }): Promise<{ ready: boolean; point?: PlainLocationPoint }> => {
      const shouldCapturePoint = Boolean(options?.capturePoint);
      const shouldOpenSettings = options?.autoOpenSettings !== false;
      const currentPermission = await refreshLocationPermission();

      if (isLocationServicesDisabled(currentPermission)) {
        toast.error("Turn on phone Location before sharing.");
        if (shouldOpenSettings) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false };
      }

      if (
        currentPermission.state === "denied" ||
        currentPermission.state === "restricted"
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
    if (
      !auth.userId ||
      !state ||
      permission?.state !== "prompt" ||
      permissionPromptInFlightRef.current
    ) {
      return;
    }

    let cancelled = false;
    permissionPromptInFlightRef.current = true;
    const promptForForegroundLocation = async () => {
      try {
        await ensureForegroundLocationReady({
          capturePoint: false,
          autoOpenSettings: false,
        });
      } finally {
        if (!cancelled) {
          permissionPromptInFlightRef.current = false;
        }
      }
    };

    void promptForForegroundLocation();

    return () => {
      cancelled = true;
      permissionPromptInFlightRef.current = false;
    };
  }, [auth.userId, ensureForegroundLocationReady, permission?.state, state]);

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

    for (const grant of state.receivedGrants ?? []) {
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
    ensureForegroundLocationReady,
    permission,
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
      const point = await OneLocationService.captureCurrentPosition();
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(durationHours),
        locationSnapshot: point,
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
      toast.success("Public location link created and copied.");
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
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Public location link copied.");
    } catch {
      toast.error("Could not copy the public location link.");
    }
  }, [publicInviteUrl]);

  const handleSharePublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    const text =
      "View my One Location location update here after entering your details.";
    try {
      if (navigator.share) {
        await navigator.share({
          title: "View my location",
          text,
          url: publicInviteUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Public location link copied.");
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

      const text =
        "Join my KAI Circle on One Location. You can view my public location update here after entering your details.";
      if (navigator.share && url) {
        await navigator.share({
          title: "Join my One Network",
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
      toast.info("Create a public location link, then share it with your contacts.");
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
        errorCode: loadError
          ? "one_location_unavailable"
          : null,
        errorMessage: loadError,
      }}
    >
      <AppPageHeaderRegion className="mx-auto w-full max-w-[1120px] min-w-0 overflow-hidden">
        <div className="flex flex-col gap-4 px-1 pt-3 sm:flex-row sm:items-end sm:justify-between">
          <header className="max-w-[560px] min-w-0 space-y-2">
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={showTour}
              className="h-9 w-auto rounded-full border-[#007aff]/20 bg-[#eaf3ff] px-3 text-[#007aff] shadow-sm hover:bg-[#daeeff] dark:border-[#0a84ff]/25 dark:bg-[#0a84ff]/10 dark:text-[#76b7ff] dark:hover:bg-[#0a84ff]/15"
              aria-label="Show onboarding tour"
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Take Tour
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy === "load"}
              className="h-9 w-full rounded-full border-black/[0.06] bg-white/80 px-3 text-[#1c1c1e] shadow-sm backdrop-blur-xl hover:bg-[#f2f2f7] sm:w-fit dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
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

      <AppPageContentRegion className="mx-auto w-full max-w-[1120px] min-w-0 space-y-6 overflow-hidden pb-36 sm:pb-8">
        {loadError ? (
          <div className="rounded-[20px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-4 text-sm text-[#ff3b30] dark:text-[#ff9f9a]">
            {loadError}
          </div>
        ) : null}

        {showInitialSkeleton ? (
          <OneLocationInitialSkeleton />
        ) : (
          <div className="grid min-w-0 max-w-full gap-6 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] xl:items-start">
            <div className="min-w-0 max-w-full space-y-7">
              <section
                ref={readinessTourRef}
                tabIndex={-1}
                className={cn(
                  "min-w-0 max-w-full space-y-2 px-1 outline-none",
                  tourSectionClassName("readiness"),
                )}
              >
                {sectionLabel("Device readiness")}
                <div
                  className={cn(
                    "flex min-w-0 max-w-full flex-col gap-3 overflow-hidden rounded-[20px] border p-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between",
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
                  <div className="flex min-w-0 items-start gap-3">
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
                    <div className="min-w-0">
                      <h3 className="break-words text-[16px] font-bold tracking-tight [overflow-wrap:anywhere]">
                        {locationReadiness.title}
                      </h3>
                      <p className="mt-1 break-words text-[13px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
                      className="h-10 w-full shrink-0 rounded-full border-black/[0.06] bg-white px-4 text-[13px] font-semibold text-[#1c1c1e] shadow-sm hover:bg-[#f2f2f7] sm:w-auto dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                    >
                      {busy !== "locationSettings" ? (
                        <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
                      ) : null}
                      {locationReadiness.actionLabel}
                    </ActionButton>
                  ) : null}
                </div>

                <div className="overflow-hidden rounded-[20px] border border-black/[0.06] bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
                  <div className="flex min-w-0 flex-col gap-3 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
                        <LocateFixed className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="break-words text-[16px] font-bold tracking-tight text-[#1c1c1e] [overflow-wrap:anywhere] dark:text-white">
                          My live location
                        </h3>
                        <p className="mt-1 break-words text-[13px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                          Preview your current GPS location privately before you
                          share it with anyone.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant={myLocationPoint ? "outline" : "default"}
                      size="sm"
                      onClick={() => void handleShowMyLiveLocation()}
                      disabled={busy !== null && busy !== "selfLocation"}
                      className={cn(
                        "h-10 w-full shrink-0 rounded-full px-4 text-[13px] font-semibold sm:w-auto",
                        myLocationPoint
                          ? "border-[#0a84ff]/30 bg-[#0a84ff]/10 text-[#0066cc] hover:bg-[#0a84ff]/15 dark:text-[#76b7ff]"
                          : "bg-[#007aff] text-white hover:bg-[#006fe6]",
                      )}
                    >
                      {busy === "selfLocation" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <LocateFixed className="mr-2 h-4 w-4" aria-hidden="true" />
                      )}
                      {myLocationPoint ? "Refresh my location" : "Show my location"}
                    </Button>
                  </div>

                  {myLocationError ? (
                    <div className="mx-3.5 mb-3.5 rounded-[14px] border border-[#ff3b30]/25 bg-[#ff3b30]/10 px-3 py-2 text-[12px] font-medium text-[#b42318] dark:text-[#ff9f9a]">
                      {myLocationError}
                    </div>
                  ) : null}

                  {myLocationPoint ? (
                    <div className="space-y-2 px-3.5 pb-3.5">
                      <LocalMapPreview point={myLocationPoint} />
                      <p className="text-[12px] font-medium leading-5 text-[#8e8e93] dark:text-white/55">
                        This preview stays on this device. It does not create a
                        private grant, public link, or access request.
                      </p>
                    </div>
                  ) : (
                    <div className="mx-3.5 mb-3.5 rounded-[16px] border border-dashed border-black/[0.08] bg-[#f8f8fb] p-3 text-[13px] font-medium leading-5 text-[#8e8e93] dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white/55">
                      This preview stays on this device. It does not create a
                      private grant, public link, or access request.
                    </div>
                  )}
                </div>
              </section>

              <section
                ref={promisesTourRef}
                tabIndex={-1}
                className={cn(
                  "min-w-0 max-w-full space-y-3 px-1 outline-none",
                  tourSectionClassName("promises"),
                )}
              >
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

              <section
                ref={oneNetworkTourRef}
                tabIndex={-1}
                className={cn(
                  "min-w-0 max-w-full space-y-4 px-1 outline-none",
                  tourSectionClassName("one_network"),
                )}
              >
                <SegmentedModeControl
                  value={activeMode}
                  onChange={setActiveMode}
                />

                <div className="min-w-0 max-w-full space-y-2">
                  {sectionLabel("One Network")}
                  <div className="flex max-w-full gap-4 overflow-x-auto overscroll-x-contain px-1 pb-2 pt-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                            )} from One Network`}
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
                        One Network recommendations will appear here.
                      </p>
                    )}
                  </div>
                </div>

                <div className="min-w-0 max-w-full space-y-3">
                  <div className="relative">
                    <Search
                      className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8e8e93]"
                      aria-hidden="true"
                    />
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

                  <div
                    aria-label="One Network section states"
                    className="grid min-w-0 max-w-full gap-2 sm:grid-cols-2"
                  >
                    {kaiCircleSections.map((section) => {
                      const emptyCopy =
                        KAI_CIRCLE_SECTION_EMPTY_COPY[section.key];
                      return (
                        <div
                          key={section.key}
                          className="min-w-0 max-w-full overflow-hidden rounded-[14px] border border-black/[0.04] bg-white/70 p-3 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.06]"
                        >
                          {sectionLabel(section.title, section.recipients.length)}
                          <p className="mt-1 break-words text-[12px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                            {section.recipients.length
                              ? section.description
                              : `${emptyCopy.title}. ${emptyCopy.description}`}
                          </p>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    ref={contactSignalTourRef}
                    tabIndex={-1}
                    className={cn(
                      "min-w-0 max-w-full overflow-hidden rounded-[14px] border border-black/[0.04] bg-white/70 p-3 shadow-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.06]",
                      tourSectionClassName("contact_signal"),
                    )}
                  >
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
                        <p className="mt-1 break-words text-[12px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
                        type="button"
                        busy={busy}
                        busyKey="contactSync"
                        onClick={() => void handleSyncContactSignal()}
                        disabled={!auth.user || busy === "contactInvite"}
                        variant="outline"
                        className="h-10 w-full min-w-0 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#1c1c1e] shadow-sm hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                      >
                        {busy !== "contactSync" ? (
                          <ContactRound className="mr-2 h-4 w-4" aria-hidden="true" />
                        ) : null}
                        Sync Contacts
                      </ActionButton>
                      <ActionButton
                        type="button"
                        busy={busy}
                        busyKey="contactInvite"
                        onClick={() => void handleShareContactInvite()}
                        disabled={!vaultOwnerToken || busy === "contactSync"}
                        variant="outline"
                        className="h-10 w-full min-w-0 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[#007aff] shadow-sm hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15"
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
                                  className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[#f2f2f7] px-3 text-[12px] font-semibold text-[#007aff] transition-colors hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15"
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

                  <div
                    ref={shareRequestTourRef}
                    tabIndex={-1}
                    className={cn(
                      "outline-none",
                      tourSectionClassName("share_request"),
                    )}
                  >
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
                              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25"
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
                          need One Location setup before private sharing can
                          start.
                        </div>
                      ) : null}
                      <p className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                        {selectedShareRecipients.length
                          ? `${peopleCountLabel(
                              selectedShareRecipients.length,
                            )} selected for private encrypted sharing.`
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
                              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[#eef5ff] px-3 text-[12px] font-semibold text-[#005bb5] transition-colors hover:bg-[#dfefff] dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff] dark:hover:bg-[#0a84ff]/25"
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
                </div>
              </section>
            </div>

            <div
              ref={accessHistoryTourRef}
              tabIndex={-1}
              className={cn(
                "min-w-0 max-w-full space-y-6 outline-none",
                tourSectionClassName("access_history"),
              )}
            >
              <section
                ref={activitySectionRef}
                tabIndex={-1}
                className={cn(
                  "min-w-0 max-w-full outline-none",
                  sectionFocusClassName("activity"),
                  tourSectionClassName("activity"),
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

              <section
                ref={peopleSectionRef}
                tabIndex={-1}
                className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("people"))}
              >
                {sectionLabel("People who can see me")}
                <div className={onePanelClassName}>
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

              <section
                ref={approvalsSectionRef}
                tabIndex={-1}
                className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("approvals"))}
              >
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

              <section className="min-w-0 max-w-full space-y-2 px-1">
                {sectionLabel("Create public link")}
                <div className={cn(onePanelClassName, "space-y-4 p-3.5")}>
                  <p className="break-words text-[13px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                    Share a public location link. Visitors enter their details
                    and can view this link's captured location.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <div className={cn(oneInsetClassName, "min-w-0 px-3 py-2 text-sm")}>
                      <span className={cn(oneSecondaryTextClassName, "break-all")}>
                        {publicInviteUrl ||
                          "Create a fresh public location link to copy or share."}
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
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] sm:w-auto dark:border-white/[0.08] dark:bg-white/10"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyPublicInvite()}
                      disabled={!publicInviteUrl}
                      className="w-full min-w-0 rounded-full border-black/[0.06] bg-[#f2f2f7] sm:w-auto dark:border-white/[0.08] dark:bg-white/10"
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
                          className="flex flex-col gap-3 rounded-[14px] bg-[#f2f2f7] p-3 sm:flex-row sm:items-center sm:justify-between dark:bg-white/10"
                        >
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                              Active public location link
                            </p>
                            <p className="break-words text-[12px] text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
                              Public viewing expires{" "}
                              {formatDateTime(invite.expiresAt)} -{" "}
                              {invite.durationHours}h
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRevokePublicInvite(invite)}
                            disabled={busy === "publicRevoke"}
                            className="w-full rounded-full sm:w-auto"
                          >
                            Revoke
                          </Button>
                        </div>
                      ))}
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
                <div className={onePanelClassName}>
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
                                <span className="min-w-0 break-words text-[12px] font-medium text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
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
                                className="w-full rounded-full border-black/[0.06] bg-[#f2f2f7] sm:w-auto dark:border-white/[0.08] dark:bg-white/10"
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

              <section
                ref={publicResponsesSectionRef}
                tabIndex={-1}
                className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("public_responses"))}
              >
                {sectionLabel("Public link responses")}
                <div className={onePanelClassName}>
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
                            className="w-full min-w-0 rounded-full sm:w-auto"
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
                <section
                  ref={myRequestsSectionRef}
                  tabIndex={-1}
                  className={cn("min-w-0 max-w-full space-y-2 px-1 outline-none", sectionFocusClassName("my_requests"))}
                >
                  {sectionLabel("My requests")}
                  <div className={onePanelClassName}>
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

      {showOnboarding && (
        <OneLocationOnboardingOverlay
          onDismiss={dismissOnboarding}
          onStepChange={setActiveTourStep}
          targets={onboardingTourTargets}
        />
      )}
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

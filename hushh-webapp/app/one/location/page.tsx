"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
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
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CapabilityExploreCard } from "@/components/onboarding/setup/capability-explore-card";
import {
  OneLocationOnboardingFlow as OneLocationOnboardingExperience,
  type ConnectionRequestResult,
} from "@/components/one-location/onboarding/one-location-onboarding-flow";
import { SaveLocationModal } from "@/components/one-location/onboarding/save-location-modal";
import type { PickedLocation } from "@/components/one-location/onboarding/location-picker-map";
import {
  addSavedLocation,
  DuplicateSavedLocationError,
  type SavedLocationCategory,
} from "@/lib/one-location/saved-locations";
import {
  buildSavedLocationAddress,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";

import { useConsentNotificationState } from "@/components/consent/notification-provider";

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

/**
 * Renders children into a portal attached to document.body, escaping any
 * ancestor stacking context. The app shell wraps page content in a
 * `position: relative; z-10` scroll root (providers.tsx), which would otherwise
 * trap a descendant overlay's z-index beneath the global chrome (agent bar /
 * bottom nav). Mounting to <body> lets a full-screen takeover sit above all
 * chrome. SSR-safe: renders nothing until mounted on the client.
 */
function BodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

import type { HushhLocationPermissionState } from "@/lib/capacitor";
import { isWeb } from "@/lib/capacitor/platform";
import { apiErrorCode } from "@/lib/services/api-client";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";


import {
  RECIPIENT_KEY_UNAVAILABLE_MESSAGE,
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureLocationRecipientKey,
  ensureVaultSyncedRecipientKey,
} from "@/lib/one-location/encryption";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import {
  isOneLocationGrantUnwatched,
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
  playOneLocationNotificationSound,
  type OneLocationNotificationSection,
} from "@/lib/one-location/notifications";
import { driveEtaText } from "@/app/one/location/drive-eta";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import {
  syncOneLocationContactSignals,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import { OneLocationActivityDashboard } from "@/components/one-location/activity-dashboard";
import {
  LocationRedesignHub,
  ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS,
  type LocationHubViewModel,
  type PrivateCheckInRequest,
  type PrivateCheckInResult,
} from "@/components/one-location/redesign/location-redesign-hub";
import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { buildOneLocationActivityFallback } from "@/lib/one-location/activity";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import {
  clearLocationWorkspaceMemory,
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
  type LocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import { updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import {
  isOneLocationNearbyCheckInAvailable,
  ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS,
} from "@/lib/one-location/nearby-check-in-availability";

import {
  clearSosIncident,
  loadSosIncident,
  reconcileSosIncident,
  saveSosIncident,
  type SosIncident,
} from "@/lib/one-location/sos-incident";
import {
  isSosShareReadyRecipient,
  runSosPanic,
  selectSmsRecipients,
  selectShareReadyRecipients,
  SosPanicError,
} from "@/lib/one-location/sos-trigger";
import {
  emergencyInfoForCountryCode,
  type EmergencyInfo,
  type EmergencyNumberLookupStatus,
} from "@/lib/one-location/emergency-numbers";
import type {
  DriveDestination,
  DriveSharePayload,
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationCircleInvite,
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecommendationReason,
  OneLocationRecipient,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  addRecentDestination,
  loadRecentDestinations,
} from "@/lib/one-location/drive-recents";
import { CacheService } from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  loadPersistedDriveSession,
  restoreDriveSession,
  saveDriveSession,
} from "@/lib/one-location/drive-session-store";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  ConnectionsService,
  type ConnectionSummaryEntry,
  type DirectoryPerson,
} from "@/lib/services/connections-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { toDurationBucket, trackEvent } from "@/lib/observability/client";
import { useVault } from "@/lib/vault/vault-context";
import { cn } from "@/lib/utils";
import { LiveMap } from "@/components/one-location/live-map";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";
import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";
import { locationPreviewFreshness } from "@/lib/one-location/freshness";
import { shouldStreamSelfPreview } from "@/lib/one-location/self-preview";
import {
  DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
  DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS,
} from "@/lib/one-location/eta-recompute";
import { getApiBaseUrl } from "@/lib/services/api-service";
import { copyToClipboard } from "@/lib/utils/clipboard";

const DURATION_OPTIONS = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;
// Recipients poll faster than the owner's publish heartbeat so the shared dot
// stays fresh; the LiveMap marker interpolates between these reads.
const LIVE_VIEW_REFRESH_INTERVAL_MS = 5_000;
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
const ONE_LOCATION_PUBLIC_SHARE_COPY = "Join my Location circle";
const ONE_LOCATION_CIRCLE_SHARE_COPY = "Join me on One";
const SHOW_LOCATION_ACTIVITY_SECTION = false;
const SHOW_OWNER_GRANTS_SECTION = false;
const SHOW_PUBLIC_RESPONSES_SECTION = false;
const SHOW_REFERRAL_SECTION = false;

// The mobile-first redesign hub (Now | People | Links) is the active UI.
// The legacy compose/activity sections only render as a fallback when the page
// hits a hard load error. Deep-link focus (from notification "Open" buttons)
// must therefore be handled by the hub's own searchParams-driven tab switching,
// NOT the legacy scroll-to-section path — which switched to a non-existent
// "activity" page tab and, worse, clobbered the deep-link query params via a
// stale `searchParams` closure inside `setLocationTab`, so the hub never saw the
// `section`/`grantId`/`requestId` and never switch to a mixed inbox surface.
// Typed as `boolean` (not the inferred literal `true`) so the redesign-mode
// early-return inside `focusOneLocationSection` does not make the legacy
// scroll-to-section path statically unreachable code.
const USE_LOCATION_REDESIGN: boolean = true;

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
  | "sos"
  | "locationSettings"
  | "selfLocation"
  | "driveTo"
  | "safeArrival"
  | "contactSync"
  | "contactInvite"
  | "publicInvite"
  | "publicRevoke"
  | "circleInvite"
  | "circleRevoke"
  | `sms-contact:${string}`
  | null;

type OneLocationSelectionSurface =
  "quick_circle" | "section_list" | "select_menu";

type OneLocationDurationBucket = "15m" | "30m" | "1h" | "4h" | "24h" | "custom";
type OneLocationForegroundOperation = "publish" | "view";
type OneLocationForegroundTrigger = "manual" | "foreground_interval";
type OneLocationFocusTarget = OneLocationNotificationSection;
type OneLocationOnboardingStep = "welcome" | "permissions";
type OneLocationOnboardingGate = "checking" | "show" | "hidden";
type OneLocationNativeTestConfig = ComponentProps<typeof NativeTestBeacon>;
type OneLocationBackoffBucket =
  "none" | "lt_500ms" | "500ms_1s" | "1s_3s" | "gte_3s";

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
      return "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-deep)]";
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
      : "Needs to open Location once")
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
    .filter((recipient): recipient is OneLocationRecipient =>
      Boolean(recipient),
    );
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
    recipient.canReceiveLocation && recipient.keyId && recipient.publicKeyJwk,
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

function isVaultOwnerAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 401;
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
      : String(
          (error as { message?: unknown })?.message || error || "",
        ).toLowerCase();
  if (name === "aborterror" || message.includes("abort")) return "aborted";
  if (message.includes("network") || message.includes("fetch"))
    return "network";
  if (message.includes("permission") || message.includes("location"))
    return "permission";
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

/** "Parth", "Parth and Aarav", "Parth, Aarav and 2 others". */
function formatNameList(names: string[]): string {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (cleaned.length === 0) return "someone";
  if (cleaned.length === 1) return cleaned[0]!;
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned[0]}, ${cleaned[1]} and ${cleaned.length - 2} others`;
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
      const shouldRetry = retryDelayMs > 0 && isRetryableForegroundError(error);
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

// Consumer UI must never surface raw backend or database internals such as SQL
// text, driver errors, stack traces, encrypted key blobs, or table and column
// identifiers. Those belong in logs and developer tooling only. We only let
// short, human-readable messages through; anything that looks like an internal
// dump is replaced with a friendly summary. This keeps the vault and PKM data
// boundary intact and stops raw driver errors from reaching users.

const ONE_LOCATION_UNSAFE_ERROR_MARKERS = [
  "psycopg2",
  "sqlalchemy",
  "sql:",
  "select ",
  "insert into",
  "update ",
  "delete from",
  "relation ",
  "column ",
  "constraint",
  "traceback",
  "jsonb",
  "public_key",
  "encrypted_",
  "jwk",
  "background on this error",
  "undefinedcolumn",
];

function isSafeUserFacingMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  // Long strings or multi-line payloads are almost always internal dumps.
  if (trimmed.length > 160) return false;
  if (/[\n\r]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return !ONE_LOCATION_UNSAFE_ERROR_MARKERS.some((marker) =>
    lower.includes(marker),
  );
}

function oneLocationErrorMessage(error: unknown, fallback: string): string {
  if (isTransientOneApiError(error)) {
    return "One is still catching up. Please refresh once, then check this page before retrying.";
  }
  const raw = error instanceof Error ? error.message : "";
  return isSafeUserFacingMessage(raw) ? raw : fallback;
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

function googleMapsLocationUrl(point: PlainLocationPoint): string {
  const query = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function googleMapsDirectionsUrl(point: PlainLocationPoint): string {
  const destination = encodeURIComponent(locationCoordinateQuery(point));
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

function locationAccuracyLabel(point: PlainLocationPoint): string | null {
  const accuracyM = point.accuracyM;
  if (
    typeof accuracyM !== "number" ||
    !Number.isFinite(accuracyM) ||
    accuracyM <= 0
  ) {
    return null;
  }
  if (accuracyM >= 1000) {
    const kilometers = accuracyM / 1000;
    return `Accuracy +/- ${kilometers >= 10 ? Math.round(kilometers) : kilometers.toFixed(1)} km`;
  }
  return `Accuracy +/- ${Math.round(accuracyM)} m`;
}

function locationSourceLabel(
  sourcePlatform: PlainLocationPoint["sourcePlatform"],
): string {
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
  viewportResetKey,
}: {
  point: PlainLocationPoint;
  // Self-location previews do not need Directions/Start - you are already there.
  showNavigation?: boolean;
  viewportResetKey?: string | number;
}) {
  const captured = formatDateTime(point.capturedAt);
  const accuracy = locationAccuracyLabel(point);
  const directionsUrl = googleMapsDirectionsUrl(point);
  const freshness = locationPreviewFreshness({
    capturedAtISO: point.capturedAt,
    nowMs: Date.now(),
    staleThresholdMs: LIVE_LOCATION_STALE_THRESHOLD_MS,
    fixedCheckIn: Boolean(point.checkIn),
  });
  const isStale = freshness.state === "paused";
  const statusLabel =
    freshness.state === "check_in"
      ? `Checked in · ${freshness.agoLabel}`
      : freshness.state === "live"
        ? `Live · ${freshness.agoLabel}`
        : `Paused · last seen ${freshness.agoLabel}`;

  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-48 max-w-full overflow-hidden bg-[#e5e5ea] sm:h-56 dark:bg-[#111113]">
        <LiveMap point={point} viewportResetKey={viewportResetKey} />
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
                isStale
                  ? "bg-amber-300"
                  : freshness.state === "check_in"
                    ? "bg-emerald-300"
                    : "animate-pulse bg-emerald-300",
              )}
              aria-hidden="true"
            />
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="break-words text-[12px] font-medium text-muted-foreground [overflow-wrap:anywhere]">
            Updated {captured}
            {accuracy ? ` - ${accuracy}` : ""} -{" "}
            {locationSourceLabel(point.sourcePlatform)}
          </p>
        </div>

        {point.drive ? (
          <div className="rounded-[12px] border border-sky-500/30 bg-sky-500/[0.08] p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-sky-700 dark:text-sky-300">
              <Route className="h-3.5 w-3.5" aria-hidden="true" />
              Driving to {point.drive.destination.label}
            </p>
            <p className="mt-0.5 text-[13px] font-semibold text-foreground">
              {driveEtaText(point.drive.etaSeconds)}
            </p>
          </div>
        ) : null}

        {showNavigation ? (
          <div className="grid gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-10 w-full min-w-0 rounded-full border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)] hover:bg-[color:var(--app-accent-surface-strong)] dark:text-[color:var(--app-accent-deep)]"
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
          </div>
        ) : null}
      </div>

      {isStale ? (
        <div
          role="status"
          className="mx-3 mb-3 flex min-w-0 items-start gap-2 rounded-[12px] border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[12px] font-medium text-amber-800 dark:text-amber-100"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
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

function onboardingPeopleFromRecipients(
  recipients: OneLocationRecipient[],
): DirectoryPerson[] {
  return recipients
    .filter((recipient) => Boolean(recipient.userId))
    .map((recipient) => ({
      userId: recipient.userId,
      displayName: displayNameFromRecipient(recipient),
      photoUrl: null,
      email: null,
      relationship: "none" as const,
    }));
}

function mergeOnboardingPeople(
  primary: DirectoryPerson[],
  fallback: DirectoryPerson[],
): DirectoryPerson[] {
  const merged = [...primary];
  const seen = new Set(primary.map((person) => person.userId));
  for (const person of fallback) {
    if (!person.userId || seen.has(person.userId)) continue;
    seen.add(person.userId);
    merged.push(person);
  }
  return merged;
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
    "bg-[color:var(--app-accent)]",
    "bg-[#34c759]",
    "bg-[#5856d6]",
    "bg-[#ff9500]",
    "bg-[#ff3b30]",
  ];
  return colors[index % colors.length] || "bg-[color:var(--app-accent)]";
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
      aria-label="How Location works"
      className="relative min-w-0 max-w-full overflow-hidden rounded-[20px] border border-[color:var(--app-accent-border)] bg-gradient-to-b from-[color:var(--app-accent-surface)] to-white p-4 shadow-sm dark:border-[color:var(--app-accent-border)] dark:from-[color:var(--app-accent-tint)] dark:to-transparent"
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
        {ONE_LOCATION_FIRST_RUN_STEPS.map(
          ({ icon: Icon, title, detail }, index) => (
            <li
              key={title}
              className="flex min-w-0 items-start gap-2.5 rounded-[14px] border border-black/[0.04] bg-white/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.06]"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-deep)]">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-[#1c1c1e] dark:text-white">
                  <span className="text-[color:var(--app-accent)] dark:text-[color:var(--app-accent-deep)]">
                    {index + 1}.
                  </span>
                  {title}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[#8e8e93] dark:text-white/55">
                  {detail}
                </span>
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

// Compact reassurance row shown above the tabs so a first-time user immediately
// sees the three trust promises ("why this is safe") before doing anything.
function OneLocationTrustStrip() {
  return (
    <ul
      aria-label="How Location keeps you safe"
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
    const { Share } =
      (await import("@capacitor/share")) as typeof import("@capacitor/share");
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

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function"
  ) {
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
      description:
        "One is checking whether this device can share your current location.",
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
    title:
      permission.precise === false
        ? "Approximate location ready"
        : "Location ready",
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
      aria-label="Loading Location"
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

type OneLocationAgentPageProps = {
  mode?: "workspace" | "setup";
  /** Nested map route retains the same in-memory, vault-scoped workspace. */
  surface?: "hub" | "map";
  onSetupReadinessChange?: (ready: boolean) => void;
  onSetupComplete?: () => void | Promise<void>;
  onSetupSkip?: () => void | Promise<void>;
};

const SAVED_LOCATION_PROMPT_LEGACY_KEY_PREFIX =
  "one_location_saved_location_prompt_v1";
const SAVED_LOCATION_PROMPT_OUTCOME_KEY_PREFIX =
  "one_location_saved_location_prompt_v2";

function savedLocationPromptKey(prefix: string, userId: string): string {
  return `${prefix}:${userId}`;
}

export function OneLocationAgentPageContent({
  mode = "workspace",
  surface = "hub",
  onSetupReadinessChange,
  onSetupComplete,
  onSetupSkip,
}: OneLocationAgentPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useRequireAuth();
  const {
    deliveryMode: notificationDeliveryMode,
    retryPushRegistration,
    isRetryingPushRegistration,
  } = useConsentNotificationState();
  const { vaultOwnerToken, vaultKey } = useVault();
  const pendingCircleInviteToken = useMemo(
    () => String(searchParams.get("circleInviteToken") || "").trim(),
    [searchParams],
  );
  const [stateEntry, setStateEntry] = useState<{
    userId: string;
    state: OneLocationState;
  } | null>(() => {
    if (!auth.userId) return null;
    const snapshot = OneLocationStateResource.peek(auth.userId);
    return snapshot ? { userId: auth.userId, state: snapshot.data } : null;
  });
  // A previous account's state must never survive an auth transition, even for
  // one render. The resource is scoped to the signed-in owner and memory-only.
  const state = stateEntry?.userId === auth.userId ? stateEntry.state : null;

  useEffect(() => {
    const userId = auth.userId;
    if (!userId) {
      setStateEntry(null);
      return;
    }

    const key = OneLocationStateResource.key(userId);
    const cache = CacheService.getInstance();
    const applySnapshot = () => {
      const snapshot = OneLocationStateResource.peek(userId);
      setStateEntry(snapshot ? { userId, state: snapshot.data } : null);
    };

    applySnapshot();
    return cache.subscribe((event) => {
      if (
        (event.type === "set" && event.key === key) ||
        (event.type === "invalidate" && event.keys.includes(key)) ||
        (event.type === "invalidate_user" &&
          event.userId === userId &&
          event.keys.includes(key)) ||
        event.type === "clear"
      ) {
        applySnapshot();
      }
    });
  }, [auth.userId]);
  const [permission, setPermission] =
    useState<HushhLocationPermissionState | null>(null);
  useEffect(() => {
    onSetupReadinessChange?.(
      permission?.state === "granted" &&
        !isLocationServicesDisabled(permission),
    );
  }, [onSetupReadinessChange, permission]);
  const [busy, setBusy] = useState<BusyState>(null);
  // Per-grant revoke tracking so "Stop sharing" only spins on the specific
  // active-share card the user tapped, not every active share at once.
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  // Opt-in: keep publishing location while the app is backgrounded (native only).
  const [backgroundShareEnabled, setBackgroundShareEnabled] = useState(false);
  // Monotonic counter bumped each time a share completes successfully, so the
  // redesign hub can close the 3-step share flow and return to the main screen.
  const [shareCompletedTick, setShareCompletedTick] = useState(0);

  const [sosIncident, setSosIncident] = useState<SosIncident | null>(null);
  const [sosEmergency, setSosEmergency] = useState<EmergencyInfo | null>(null);
  const [sosEmergencyStatus, setSosEmergencyStatus] =
    useState<EmergencyNumberLookupStatus>("idle");
  const sosLocationResolutionRef =
    useRef<Promise<PlainLocationPoint | null> | null>(null);
  const sosEmergencyLookupIdRef = useRef(0);

  // Hydrate the persisted SOS incident once on mount.
  useEffect(() => {
    setSosIncident(loadSosIncident());
  }, []);

  const [locationOnboardingGate, setLocationOnboardingGate] =
    useState<OneLocationOnboardingGate>("checking");
  const [locationOnboardingStep, setLocationOnboardingStep] =
    useState<OneLocationOnboardingStep>("welcome");
  const [locationOnboardingBusy, setLocationOnboardingBusy] = useState(false);
  // Saved-place prompt shown once per mounted journey after Location is ready.
  // Active root-setup replay deliberately gets a fresh opportunity.
  const [saveLocationModalOpen, setSaveLocationModalOpen] = useState(false);
  const [saveLocationPoint, setSaveLocationPoint] =
    useState<PlainLocationPoint | null>(null);
  const [saveLocationAddress, setSaveLocationAddress] = useState<string | null>(
    null,
  );
  const [saveLocationAddressLoading, setSaveLocationAddressLoading] =
    useState(false);
  const [saveLocationSaving, setSaveLocationSaving] = useState(false);
  const [savedLocationRendererAccepted, setSavedLocationRendererAccepted] =
    useState(false);
  const [savedLocationSessionUserId, setSavedLocationSessionUserId] = useState(
    auth.userId,
  );
  const savedLocationPromptedRef = useRef(false);
  const savedLocationPromptInFlightRef = useRef<Promise<boolean> | null>(null);
  const savedLocationAddressResolutionIdRef = useRef(0);
  const savedLocationSessionEpochRef = useRef(0);
  const savedLocationPointUserIdRef = useRef<string | null>(null);
  const locationOnboardingRetryOnResumeRef = useRef(false);
  const notificationOnboardingAttemptRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setSavedLocationRendererAccepted(false);
    if (!vaultOwnerToken) return () => undefined;

    void OneLocationService.getMapState(vaultOwnerToken)
      .then((state) => {
        if (cancelled) return;
        setSavedLocationRendererAccepted(
          state.preferences.rendererConsentVersion ===
            GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
        );
      })
      .catch(() => {
        // Fail closed and show the disclosure when canonical preference state
        // is unavailable. Root setup without a vault stays session-only.
      });

    return () => {
      cancelled = true;
    };
  }, [auth.userId, vaultOwnerToken]);

  const notificationOnboardingObservedBusyRef = useRef(false);
  const notificationOnboardingRetryOnFocusRef = useRef(false);
  const [locationOnboardingPeople, setLocationOnboardingPeople] = useState<
    DirectoryPerson[]
  >([]);
  const [locationOnboardingConnections, setLocationOnboardingConnections] =
    useState<ConnectionSummaryEntry[]>([]);
  const [locationOnboardingPeopleLoading, setLocationOnboardingPeopleLoading] =
    useState(false);
  const [locationOnboardingPeopleError, setLocationOnboardingPeopleError] =
    useState<string | null>(null);
  const [locationOnboardingPeopleRefresh, setLocationOnboardingPeopleRefresh] =
    useState(0);
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
  const [shareRecipientSearch, setShareRecipientSearch] = useState("");
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
  const [shareDurationHours, setShareDurationHours] = useState(
    ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS,
  );
  const [shareMessage, setShareMessage] = useState("");
  const [durationHours, setDurationHours] = useState("1");
  const [requestMessage, setRequestMessage] = useState("");
  const [referralTargets, setReferralTargets] = useState<
    Record<string, string>
  >({});
  const [publicInviteUrl, setPublicInviteUrl] = useState("");
  const [circleInviteUrl, setCircleInviteUrl] = useState("");
  const [locationWorkspace, setLocationWorkspace] =
    useState<LocationWorkspaceMemory>(() =>
      readLocationWorkspaceMemory(auth.userId),
    );
  const locationControl = useOneLocationControlState(auth.userId);
  const automaticPrivatePublishingAllowedRef = useRef(
    !locationControl.paused && locationControl.autoShareEnabled,
  );
  useEffect(() => {
    automaticPrivatePublishingAllowedRef.current =
      !locationControl.paused && locationControl.autoShareEnabled;
  }, [locationControl.autoShareEnabled, locationControl.paused]);
  const nearbyCheckInAvailable = isOneLocationNearbyCheckInAvailable();
  useEffect(() => {
    setLocationWorkspace(readLocationWorkspaceMemory(auth.userId));
  }, [auth.userId]);
  const previousWorkspaceUserId = useRef<string | null>(auth.userId ?? null);
  useEffect(() => {
    const previousUserId = previousWorkspaceUserId.current;
    if (previousUserId && previousUserId !== auth.userId) {
      clearLocationWorkspaceMemory(previousUserId);
    }
    previousWorkspaceUserId.current = auth.userId ?? null;
  }, [auth.userId]);
  useEffect(() => {
    if (savedLocationSessionUserId === auth.userId) return;

    const previousUserId = savedLocationSessionUserId;
    savedLocationSessionEpochRef.current += 1;
    savedLocationAddressResolutionIdRef.current += 1;
    savedLocationPromptedRef.current = false;
    savedLocationPromptInFlightRef.current = null;
    savedLocationPointUserIdRef.current = null;
    setSaveLocationModalOpen(false);
    setSaveLocationPoint(null);
    setSaveLocationAddress(null);
    setSaveLocationAddressLoading(false);
    setSaveLocationSaving(false);
    if (previousUserId) {
      PreVaultSensitiveDraftService.clearForUser(previousUserId);
    }
    setSavedLocationSessionUserId(auth.userId);
  }, [auth.userId, savedLocationSessionUserId]);
  useEffect(() => {
    if (!vaultOwnerToken && mode !== "setup") {
      clearLocationWorkspaceMemory(auth.userId);
      setLocationWorkspace(readLocationWorkspaceMemory(auth.userId));
    }
  }, [auth.userId, mode, vaultOwnerToken]);
  const updateLocationWorkspace = useCallback(
    (
      updater: (current: LocationWorkspaceMemory) => LocationWorkspaceMemory,
    ) => {
      setLocationWorkspace((current) => {
        const next = updater(current);
        writeLocationWorkspaceMemory(auth.userId, next);
        return next;
      });
    },
    [auth.userId],
  );
  const myLocationPoint = locationWorkspace.myLocationPoint;
  const setMyLocationPoint = useCallback(
    (next: SetStateAction<PlainLocationPoint | null>) => {
      updateLocationWorkspace((current) => ({
        ...current,
        myLocationPoint:
          typeof next === "function"
            ? (
                next as (
                  value: PlainLocationPoint | null,
                ) => PlainLocationPoint | null
              )(current.myLocationPoint)
            : next,
      }));
    },
    [updateLocationWorkspace],
  );
  const activateMyLocation = useCallback(
    (point: PlainLocationPoint) => {
      automaticPrivatePublishingAllowedRef.current =
        locationControl.autoShareEnabled;
      updateLocationWorkspace((current) => ({
        ...current,
        myLocationPoint: point,
      }));
      updateOneLocationControlState(auth.userId, (current) => ({
        ...current,
        paused: false,
        selfPreviewEnabled: true,
      }));
    },
    [auth.userId, locationControl.autoShareEnabled, updateLocationWorkspace],
  );
  const clearMyLocationPreview = useCallback(() => {
    updateLocationWorkspace((current) => ({
      ...current,
      myLocationPoint: null,
    }));
  }, [updateLocationWorkspace]);
  const [myLocationError, setMyLocationError] = useState<string | null>(null);
  const [mapViewportResetKey, setMapViewportResetKey] = useState(0);
  // True once the owner taps "Show my location" — keeps their own preview
  // streaming live (foreground) even before any share exists.
  const decryptedPoints = locationWorkspace.decryptedPoints;
  const setDecryptedPoints = useCallback(
    (next: SetStateAction<Record<string, PlainLocationPoint>>) => {
      updateLocationWorkspace((current) => ({
        ...current,
        decryptedPoints:
          typeof next === "function"
            ? (
                next as (
                  value: Record<string, PlainLocationPoint>,
                ) => Record<string, PlainLocationPoint>
              )(current.decryptedPoints)
            : next,
      }));
    },
    [updateLocationWorkspace],
  );
  // Per-grant, recipient-facing message shown when a received share can't be
  // decrypted because the on-device key no longer matches (e.g. the key rotated
  // after WKWebView storage loss). Drives the inline "ask them to share again"
  // recovery state instead of a raw crypto error. Keyed by grant id, mirrors
  // `decryptedPoints`.
  const [grantViewErrors, setGrantViewErrors] = useState<
    Record<string, string>
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
  const workspaceBootstrapUserRef = useRef<string | null>(null);
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
  const shareReviewAttemptRef = useRef(0);
  const shareReviewPendingRef = useRef(false);
  // Continuous movement-driven live tracking (owner side). Holds the active
  // geolocation watch id, the last point we actually published (to measure
  // movement), and the timestamp of that publish (to throttle bursts).
  const liveWatchIdRef = useRef<string | null>(null);
  const selfWatchIdRef = useRef<string | null>(null);
  const lastPublishedPointRef = useRef<PlainLocationPoint | null>(null);
  const lastWatchPublishAtRef = useRef(0);
  // Throttles updates to the owner's OWN live-preview marker so it refreshes at
  // the same cadence a viewer sees a shared dot (LIVE_VIEW_REFRESH_INTERVAL_MS),
  // instead of re-rendering/animating on every raw GPS fix (~1s), which needlessly
  // burns compute. Does NOT affect GPS accuracy or the publish heartbeat.
  const lastSelfMarkerAtRef = useRef(0);
  const driveSessionRef = useRef<{
    grantIds: Set<string>;
    destination: DriveDestination;
    etaSeconds: number | null;
    distanceMeters: number | null;
    etaComputedAt: string;
    lastEtaPoint: PlainLocationPoint | null;
    lastEtaAt: number;
  } | null>(null);
  // Maps each fixed-pickup grantId to the PlainLocationPoint anchored at request
  // time. Using a Map (rather than a single shared object) means a second "Pick
  // Me Up" request no longer overwrites the first grant's fixed spot, which
  // would otherwise cause it to drift back to live GPS.
  const pickupSessionRef = useRef<Map<string, PlainLocationPoint>>(new Map());
  const [_recentDestinations, setRecentDestinations] = useState<
    DriveDestination[]
  >([]);

  const recipients = useMemo(
    () => state?.recipients ?? [],
    [state?.recipients],
  );
  const locationOnboardingRecipientsRef = useRef(recipients);
  useEffect(() => {
    locationOnboardingRecipientsRef.current = recipients;
    if (locationOnboardingGate !== "show" || recipients.length === 0) return;
    setLocationOnboardingPeople((current) =>
      mergeOnboardingPeople(
        current,
        onboardingPeopleFromRecipients(recipients),
      ),
    );
    setLocationOnboardingPeopleError(null);
    setLocationOnboardingPeopleLoading(false);
  }, [locationOnboardingGate, recipients]);
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
  const visibleShareRecipients = useMemo(() => {
    const query = shareRecipientSearch.trim().toLowerCase();
    if (!query) return rankedRecipients;
    return rankedRecipients.filter((recipient) =>
      recommendationSearchText(recipient).includes(query),
    );
  }, [rankedRecipients, shareRecipientSearch]);
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
    () =>
      recipientSelectionFromIds(contactSignalRecipients, selectedRecipientIds),
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
      recipientSelectionFromIds(
        contactSignalRecipients,
        selectedRequestOwnerIds,
      ),
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
  const activeReceivedGrants = useMemo(
    () =>
      (state?.receivedGrants ?? []).filter(
        (grant) => grant.status === "active",
      ),
    [state?.receivedGrants],
  );
  const visibleReceivedGrants = useMemo(() => {
    void openedGrantTick;
    void unwatchedTick;
    return activeReceivedGrants.filter(
      (grant) => !isOneLocationGrantUnwatched(auth.userId, grant.id),
    );
  }, [activeReceivedGrants, auth.userId, openedGrantTick, unwatchedTick]);
  const activeOwnerGrants = useMemo(
    () =>
      (state?.ownerGrants ?? []).filter((grant) => grant.status === "active"),
    [state?.ownerGrants],
  );
  const locationEnabled =
    !locationControl.paused &&
    (locationControl.selfPreviewEnabled ||
      locationControl.nearbyPresenceActive ||
      (locationControl.autoShareEnabled && activeOwnerGrants.length > 0));
  // "Location limited" is a signal-quality badge, not an admission gate, so it
  // tracks the coarse threshold rather than the hard check-in ceiling. Those two
  // are now far apart: a 1 km browser fix is genuinely limited but still
  // perfectly usable for picking the venue you are standing in.
  const locationAccuracyLimited =
    locationEnabled &&
    (permission?.state !== "granted" ||
      permission?.precise === false ||
      (typeof myLocationPoint?.accuracyM === "number" &&
        Number.isFinite(myLocationPoint.accuracyM) &&
        myLocationPoint.accuracyM > ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS));

  useEffect(() => {
    if (!nearbyCheckInAvailable || !auth.userId || !vaultOwnerToken) {
      return;
    }
    const userId = auth.userId;
    const ownerToken = vaultOwnerToken;
    let cancelled = false;

    void OneLocationService.getNearbyPresence({
      vaultOwnerToken: ownerToken,
    })
      .then(async (next) => {
        if (cancelled) return;
        if (locationControl.paused && next.presence) {
          try {
            const checkedOut = await OneLocationService.checkoutNearby({
              vaultOwnerToken: ownerToken,
            });
            if (cancelled) return;
            next = checkedOut;
          } catch {
            if (cancelled) return;
            updateOneLocationControlState(userId, (current) => ({
              ...current,
              paused: false,
              nearbyPresenceActive: true,
              nearbyCheckedInAt: next.presence?.checkedInAt ?? null,
            }));
            toast.error(
              "Nearby checkout did not complete. Location is still on; try pausing again.",
            );
            return;
          }
        }
        updateOneLocationControlState(userId, (current) => ({
          ...current,
          nearbyPresenceActive: Boolean(next.presence),
          nearbyCheckedInAt: next.presence?.checkedInAt ?? null,
        }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    auth.userId,
    locationControl.paused,
    nearbyCheckInAvailable,
    vaultOwnerToken,
  ]);

  // The remaining location actions (Alert and Check-In) share the same
  // recipients: connections ready for private sharing.
  // Recipients are already scoped to the connections graph server-side.
  const sosActionRecipients = useMemo(
    () => selectShareReadyRecipients(rankedRecipients),
    [rankedRecipients],
  );
  const smsContactUserIds = useMemo(
    () => state?.smsContactUserIds ?? [],
    [state?.smsContactUserIds],
  );
  const smsActionRecipients = useMemo(
    () => selectSmsRecipients(sosActionRecipients, smsContactUserIds),
    [smsContactUserIds, sosActionRecipients],
  );

  // Ref kept in sync with the latest sosIncident value so the reconcile effect
  // can read it without adding it as a dependency (preventing infinite loops).
  const sosIncidentRef = useRef(sosIncident);
  useEffect(() => {
    sosIncidentRef.current = sosIncident;
  }, [sosIncident]);

  // Reconcile the incident against live grants: drop grant ids that are no longer
  // active (revoked/expired). Clears the banner automatically when the incident ends.
  // Guard: skip until state has loaded so a reload doesn't wipe a just-hydrated
  // incident by reconciling against an empty activeOwnerGrants array.
  useEffect(() => {
    if (!state) return;
    const activeIds = activeOwnerGrants.map((grant) => grant.id);
    const current = sosIncidentRef.current;
    const reconciled = reconcileSosIncident(current, activeIds);
    if (reconciled !== current) {
      if (reconciled) saveSosIncident(reconciled);
      else clearSosIncident();
      setSosIncident(reconciled);
    }
  }, [state, activeOwnerGrants]);

  // The focused shared-with-me view keeps every active share live-refreshing when a
  // legacy build previously persisted an "unwatched" id. In the redesigned
  // UX, Dismiss owns preview presentation only and never changes grant reachability.
  const activeVisibleReceivedGrants = USE_LOCATION_REDESIGN
    ? activeReceivedGrants
    : visibleReceivedGrants;
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
    return (
      [...activePublicInvites].sort(
        (left, right) => inviteTime(right) - inviteTime(left),
      )[0] ?? null
    );
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
    return (
      [...activeCircleInvites].sort(
        (left, right) => inviteTime(right) - inviteTime(left),
      )[0] ?? null
    );
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
      // REDESIGN MODE (active): the legacy compose/activity sections below are
      // NOT rendered — the LocationRedesignHub (Now | People | Links)
      // is. The hub consumes the deep-link query params (`section`, `grantId`,
      // `requestId`, `submissionId`) itself and switches to the correct swipe
      // tab (focused detail for shared/approvals/my_requests/grant/request, Links for
      // public_responses, People for people). We MUST NOT run the legacy
      // scroll-to-section path here, because it calls `setLocationTab("activity")`
      // which does a `router.replace` built from a STALE `searchParams` closure —
      // that strips the very `grantId`/`section`/`locationNotification` params
      // the notification just pushed, so the hub's own effect never sees them and
      // the user is stranded on the wrong tab. Returning early keeps the pushed
      // deep-link URL intact so the hub can route to its focused detail view.
      if (USE_LOCATION_REDESIGN) return;

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
        ? "rounded-[22px] ring-2 ring-[color:var(--app-accent-ring)] ring-offset-2 ring-offset-transparent"
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
        setActivityError(
          "Showing current page activity while history sync catches up.",
        );
      })
      .finally(() => {
        if (active) setActivityLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activityRange, auth.userId, state, vaultOwnerToken]);

  useEffect(() => {
    if (!pendingCircleInviteToken || !vaultOwnerToken) return;
    router.push(
      `/one/location/invite/${encodeURIComponent(pendingCircleInviteToken)}`,
    );
  }, [pendingCircleInviteToken, router, vaultOwnerToken]);

  const refresh = useCallback(
    async (options?: { background?: boolean }) => {
      if (!auth.userId) {
        setBusy(null);
        setLoadError("Sign in before loading location sharing.");
        return;
      }
      if (!vaultOwnerToken) {
        setBusy(null);
        // `/one/location` is already protected by OneAuthGate -> VaultLockGuard.
        // A missing owner token means that canonical hard gate is taking over;
        // do not flash a second route-local unlock/error presentation first.
        setLoadError(null);
        return;
      }
      if (refreshInFlightRef.current) {
        return refreshInFlightRef.current;
      }
      const activeUserId = auth.userId;
      const activeUser = auth.user;
      const activeVaultOwnerToken = vaultOwnerToken;
      const hasUsableState = stateEntry?.userId === activeUserId;
      // A memory snapshot is safe only for this unlocked session. Keep it visible
      // while the network reconciles instead of replacing a usable Location page
      // with the same foreground loader on every focus, push, or route re-entry.
      const showForegroundLoad = !options?.background && !hasUsableState;
      if (showForegroundLoad) {
        setBusy((current) => current ?? "load");
      }
      const task = (async () => {
        setLoadError(null);
        try {
          if (!activeUser) {
            throw new Error(
              "Refresh your session before loading location sharing.",
            );
          }
          if (workspaceBootstrapUserRef.current !== activeUserId) {
            await AccountIdentityService.syncCurrentUser(activeUser).catch(
              (error) => {
                console.warn(
                  "[OneLocation] Failed to sync account identity:",
                  error,
                );
              },
            );
            const key = await ensureLocationRecipientKey(activeUserId);
            await OneLocationService.registerRecipientKey({
              vaultOwnerToken: activeVaultOwnerToken,
              keyId: key.keyId,
              publicKeyJwk: key.publicKeyJwk,
              algorithm: key.algorithm,
            });
            workspaceBootstrapUserRef.current = activeUserId;
          }
          const [nextPermission, nextState] = await Promise.all([
            OneLocationService.getPermissionState().catch(() => ({
              state: "unavailable" as const,
              precise: false,
              background: "unavailable" as const,
            })),
            OneLocationStateResource.load(activeUserId, () =>
              OneLocationService.getState(activeVaultOwnerToken),
            ),
          ]);
          setPermission(nextPermission);
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
          // ApiService handles rejected VAULT_OWNER tokens for web and native by
          // locking the vault. Do not briefly render the backend auth message
          // while VaultLockGuard switches to the standard re-unlock flow.
          if (!isVaultOwnerAuthError(error)) {
            setLoadError(
              oneLocationErrorMessage(
                error,
                "Could not load location sharing.",
              ),
            );
          }
        } finally {
          refreshInFlightRef.current = null;
          if (showForegroundLoad) setBusy(null);
        }
      })();
      refreshInFlightRef.current = task;
      return task;
    },
    [
      auth.user,
      auth.userId,
      contactMatchedUserIds,
      stateEntry?.userId,
      vaultOwnerToken,
    ],
  );

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
          ? "Turn on Location, then return here and refresh."
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
        toast.error(
          "Location is unavailable. Check your phone Location settings.",
        );
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
        const nextPermission =
          await OneLocationService.getPermissionState().catch(() => null);
        setPermission(
          nextPermission ?? {
            state: "granted",
            precise: null,
            background: "foreground-only",
            locationServicesEnabled: true,
          },
        );
        if (shouldCapturePoint) {
          activateMyLocation(point);
        }
        return shouldCapturePoint ? { ready: true, point } : { ready: true };
      } catch (error) {
        const nextPermission =
          await OneLocationService.getPermissionState().catch(() => null);
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
    [activateMyLocation, refreshLocationPermission],
  );

  useEffect(() => {
    if (!auth.loading) {
      void refresh({ background: Boolean(stateEntry?.userId === auth.userId) });
    }
  }, [auth.loading, auth.userId, refresh, stateEntry?.userId]);

  useEffect(() => {
    if (locationOnboardingGate !== "show" || !auth.user) {
      return;
    }

    const authenticatedUser = auth.user;
    let cancelled = false;
    const loadPeople = async () => {
      setLocationOnboardingPeopleLoading(true);
      setLocationOnboardingPeopleError(null);
      try {
        const idToken = await authenticatedUser.getIdToken();
        let directorySucceeded = false;
        let renderedPeople = false;
        let directoryError: unknown = null;
        let connectionsError: unknown = null;

        const directoryTask = ConnectionsService.searchDirectory({
          idToken,
          page: 1,
          limit: 12,
        })
          .then((result) => {
            directorySucceeded = true;
            if (cancelled) return;
            const items = result.items ?? [];
            if (items.length === 0) return;
            renderedPeople = true;
            setLocationOnboardingPeople((current) =>
              mergeOnboardingPeople(items, current),
            );
            setLocationOnboardingPeopleError(null);
            setLocationOnboardingPeopleLoading(false);
          })
          .catch((error: unknown) => {
            directoryError = error;
          });

        const connectionsTask = ConnectionsService.listConnections({ idToken })
          .then((result) => {
            if (cancelled) return;
            setLocationOnboardingConnections(result);
            if (renderedPeople || result.length === 0) return;
            renderedPeople = true;
            setLocationOnboardingPeople((current) =>
              mergeOnboardingPeople(
                result.map((connection) => ({
                  userId: connection.userId,
                  displayName: connection.displayName,
                  photoUrl: connection.photoUrl,
                  email: null,
                  relationship: "connected" as const,
                })),
                current,
              ),
            );
            setLocationOnboardingPeopleError(null);
            setLocationOnboardingPeopleLoading(false);
          })
          .catch((error: unknown) => {
            connectionsError = error;
            if (!cancelled) setLocationOnboardingConnections([]);
          });

        await Promise.allSettled([directoryTask, connectionsTask]);
        if (cancelled) return;

        if (!renderedPeople) {
          const fallbackPeople = onboardingPeopleFromRecipients(
            locationOnboardingRecipientsRef.current,
          );
          setLocationOnboardingPeople((current) =>
            mergeOnboardingPeople(fallbackPeople, current),
          );
          if (fallbackPeople.length > 0) {
            setLocationOnboardingPeopleError(null);
          } else if (!directorySucceeded) {
            const error = directoryError ?? connectionsError;
            setLocationOnboardingPeopleError(
              error instanceof Error
                ? error.message
                : "Could not load recommended people.",
            );
          }
        }
      } catch (error) {
        if (cancelled) return;
        const fallbackPeople = onboardingPeopleFromRecipients(
          locationOnboardingRecipientsRef.current,
        );
        setLocationOnboardingPeople((current) =>
          mergeOnboardingPeople(fallbackPeople, current),
        );
        setLocationOnboardingConnections([]);
        setLocationOnboardingPeopleError(
          fallbackPeople.length > 0
            ? null
            : error instanceof Error
              ? error.message
              : "Could not load recommended people.",
        );
      } finally {
        if (!cancelled) setLocationOnboardingPeopleLoading(false);
      }
    };

    void loadPeople();
    return () => {
      cancelled = true;
    };
  }, [auth.user, locationOnboardingGate, locationOnboardingPeopleRefresh]);

  useEffect(() => {
    if (auth.loading) {
      setLocationOnboardingGate("checking");
      return;
    }
    if (!auth.userId) {
      setLocationOnboardingGate("hidden");
      return;
    }
    // Setup is the deliberate pre-vault journey. It may collect device
    // readiness but must not enter the encrypted Location workspace or ask
    // the person to create/unlock a vault before master Finish setup.
    if (!vaultOwnerToken && mode !== "setup") {
      setLocationOnboardingGate("checking");
      return;
    }

    if (mode === "setup") {
      setLocationOnboardingStep("welcome");
      setLocationOnboardingGate("show");
      return;
    }

    if (loadError) {
      setLocationOnboardingGate("hidden");
      return;
    }

    if (locationOnboardingGate === "hidden") {
      return;
    }

    const introSeen =
      typeof window !== "undefined" &&
      (window.localStorage.getItem(
        `one_location_onboarding_v2:${auth.userId}`,
      ) === "1" ||
        window.localStorage.getItem(
          `one_location_onboarding_v1:${auth.userId}`,
        ) === "1");

    // The whole takeover is first-run only. Returning users manage Location
    // and notification readiness from the normal Location surface.
    if (introSeen) {
      setLocationOnboardingGate("hidden");
      return;
    }

    if (locationOnboardingGate !== "show") {
      setLocationOnboardingStep("welcome");
    }
    setLocationOnboardingGate("show");
  }, [
    auth.loading,
    auth.userId,
    loadError,
    locationOnboardingGate,
    mode,
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
    if (!auth.userId) return;
    void loadRecentDestinations(auth.userId).then(setRecentDestinations);
  }, [auth.userId]);

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
      void refresh({ background: true });
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
      section &&
      [
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
  }, [auth.userId, setDecryptedPoints]);

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
        throw new Error(
          "They need to open Location once before private sharing can start.",
        );
      }
      const point =
        pointOverride ?? (await OneLocationService.captureCurrentPosition());
      const envelope = await encryptLocationForRecipient({
        point,
        recipientPublicKeyJwk: recipient.publicKeyJwk,
        recipientKeyId: recipient.keyId,
      });
      // Returned so Save My Soul can tell the sender which contacts the alert
      // actually reached. null for every other share kind, which does not
      // notify from this route.
      const stored = await OneLocationService.storeEnvelope({
        vaultOwnerToken,
        grantId: grant.id,
        envelope,
      });
      return stored.recipientAlerted;
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

  const drivePointForGrant = useCallback(
    async (
      grant: OneLocationGrant,
      point: PlainLocationPoint,
    ): Promise<PlainLocationPoint> => {
      const session = driveSessionRef.current;
      if (!session || !session.grantIds.has(grant.id)) return point;

      const now = Date.now();
      const movedMeters = session.lastEtaPoint
        ? locationDistanceMeters(session.lastEtaPoint, point)
        : Number.POSITIVE_INFINITY;
      const sinceMs = now - session.lastEtaAt;
      const shouldRecompute =
        !session.lastEtaPoint ||
        movedMeters >= DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS ||
        sinceMs >= DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS;

      if (shouldRecompute && vaultOwnerToken) {
        try {
          const eta = await OneLocationService.routeEta({
            vaultOwnerToken,
            originLat: point.latitude,
            originLng: point.longitude,
            destLat: session.destination.latitude,
            destLng: session.destination.longitude,
          });
          session.etaSeconds = eta.etaSeconds;
          session.distanceMeters = eta.distanceMeters;
          session.etaComputedAt = new Date().toISOString();
          session.lastEtaPoint = point;
          session.lastEtaAt = now;
        } catch {
          // Keep the last known ETA; the share still carries the moving point.
          session.lastEtaPoint = point;
          session.lastEtaAt = now;
        }
      }

      const drive: DriveSharePayload = {
        destination: session.destination,
        etaSeconds: session.etaSeconds,
        distanceMeters: session.distanceMeters,
        etaComputedAt: session.etaComputedAt,
      };
      return { ...point, drive };
    },
    [vaultOwnerToken],
  );

  // Keep an adjusted (fixed) pickup spot fixed: the watch loop must not overwrite
  // these grants with live GPS as the owner moves.
  const pickupPointForGrant = useCallback(
    (
      grant: OneLocationGrant,
      livePoint: PlainLocationPoint,
    ): PlainLocationPoint =>
      pickupSessionRef.current.get(grant.id) ?? livePoint,
    [],
  );

  // Rehydrate the drive/ETA session after a refresh/remount. `driveSessionRef`
  // is in-memory, so without this the watch loop would resume publishing points
  // WITHOUT the ETA payload after a reload (position keeps updating, ETA drops).
  // Restore it from durable storage for still-active owner grants; only when the
  // ref is empty (never clobber a live session).
  useEffect(() => {
    if (!auth.userId || driveSessionRef.current) return;
    const activeIds = new Set(activeOwnerGrants.map((grant) => grant.id));
    if (activeIds.size === 0) return;
    let cancelled = false;
    void loadPersistedDriveSession(auth.userId).then((persisted) => {
      if (cancelled || driveSessionRef.current) return;
      const restored = restoreDriveSession(persisted, activeIds);
      if (restored) driveSessionRef.current = restored;
    });
    return () => {
      cancelled = true;
    };
  }, [auth.userId, activeOwnerGrants]);

  const resetShareComposer = useCallback((initialRecipientId?: string) => {
    const recipientId = initialRecipientId?.trim() || "";
    shareReviewAttemptRef.current += 1;
    if (shareReviewPendingRef.current) {
      shareReviewPendingRef.current = false;
      setBusy((current) => (current === "share" ? null : current));
    }
    suppressAutoRecipientSelectionRef.current = true;
    setShareRecipientSearch("");
    setSelectedRecipientId(recipientId);
    setSelectedRecipientIds(recipientId ? [recipientId] : []);
    setShareReviewOpen(false);
    setShareDurationHours(ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS);
    setShareMessage("");
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
      shareMessage.length > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH ||
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
          durationHours: Number(shareDurationHours),
          reason: shareMessage.trim() || undefined,
          shareKind: "share",
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
        duration_bucket: oneLocationDurationBucket(shareDurationHours),
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
        duration_bucket: oneLocationDurationBucket(shareDurationHours),
        review_required: shareReviewOpen,
      });
      toast.error(
        error instanceof Error ? error.message : "Could not share location.",
      );
    } finally {
      setBusy(null);
    }
  }, [
    ensureForegroundLocationReady,
    permission,
    publishEnvelopeWithRetry,
    refresh,
    resetShareComposer,
    setupNeededSelectedRecipients.length,
    shareDurationHours,
    shareMessage,
    shareReviewOpen,
    shareReadySelectedRecipients,
    vaultOwnerToken,
  ]);

  const resolveSosLocation = useCallback(() => {
    const inFlight = sosLocationResolutionRef.current;
    if (inFlight) return inFlight;

    setSosEmergency(null);
    setSosEmergencyStatus("resolving");
    const emergencyLookupId = sosEmergencyLookupIdRef.current + 1;
    sosEmergencyLookupIdRef.current = emergencyLookupId;
    const resolution = (async (): Promise<PlainLocationPoint | null> => {
      try {
        const result = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: false,
        });
        if (!result.ready || !result.point) {
          setSosEmergencyStatus("unavailable");
          return null;
        }
        // The point remains in foreground-only workspace memory. Merely opening
        // Save My Soul never publishes or durably persists these coordinates.
        setMyLocationPoint(result.point);
        if (!vaultOwnerToken) {
          setSosEmergencyStatus("unavailable");
          return result.point;
        }
        // Country lookup continues independently so a slow Maps response never
        // delays the actual Save My Soul SMS after the user completes the hold.
        void OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat: result.point.latitude,
          lng: result.point.longitude,
        })
          .then((place) => {
            if (sosEmergencyLookupIdRef.current !== emergencyLookupId) return;
            const emergency = emergencyInfoForCountryCode(place.countryCode);
            if (!emergency) {
              setSosEmergencyStatus("unavailable");
              return;
            }
            setSosEmergency(emergency);
            setSosEmergencyStatus("resolved");
          })
          .catch(() => {
            if (sosEmergencyLookupIdRef.current === emergencyLookupId) {
              setSosEmergencyStatus("unavailable");
            }
          });
        return result.point;
      } catch {
        setSosEmergencyStatus("unavailable");
        return null;
      }
    })();

    sosLocationResolutionRef.current = resolution;
    void resolution.then(
      () => {
        if (sosLocationResolutionRef.current === resolution) {
          sosLocationResolutionRef.current = null;
        }
      },
      () => {
        if (sosLocationResolutionRef.current === resolution) {
          sosLocationResolutionRef.current = null;
        }
      },
    );
    return resolution;
  }, [ensureForegroundLocationReady, setMyLocationPoint, vaultOwnerToken]);

  const handleTriggerSos = useCallback(
    async (note?: string | null) => {
      if (sosIncident) return; // re-entry guard: never overwrite/orphan an active incident
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission))
        return;
      const readyRecipients = smsActionRecipients.filter(
        isSosShareReadyRecipient,
      );
      const totalSelected = smsActionRecipients.length;
      if (!readyRecipients.length) {
        toast.error(
          totalSelected
            ? "Your SMS contacts are not ready to receive location yet."
            : "Add at least one SMS contact before sending an alert.",
        );
        return;
      }
      setBusy("sos");
      try {
        const point = await resolveSosLocation();
        if (!point) {
          toast.error(
            "Couldn't get your location — SMS not sent. Check location permissions.",
          );
          return;
        }
        const incident = await runSosPanic({
          vaultOwnerToken,
          recipients: readyRecipients,
          point,
          note,
          publish: (grant, recipient, pt) =>
            publishEnvelopeWithRetry(grant, recipient, "manual", pt),
        });
        setSosIncident(incident);
        const skipped = totalSelected - readyRecipients.length;
        // Name who could not be reached rather than reporting a flat count. A
        // contact with notifications off, or who reinstalled and lost their push
        // token, previously looked identical to one whose phone lit up — the
        // worst way for an emergency alert to fail.
        const unreachable = incident.delivery
          .filter((outcome) => outcome.alerted === false)
          .map((outcome) => outcome.displayName);
        const reached = readyRecipients.length - unreachable.length;

        if (reached === 0) {
          toast.error(
            `Location shared, but no one was alerted — ${formatNameList(unreachable)} ${unreachable.length === 1 ? "has" : "have"} notifications off. Call emergency services if you need help now.`,
          );
        } else if (unreachable.length > 0) {
          toast.warning(
            `SMS sent to ${reached} of ${readyRecipients.length} contacts. Couldn't alert ${formatNameList(unreachable)} — notifications are off on their end.`,
          );
        } else {
          toast.success(
            skipped > 0
              ? `SMS sent to ${readyRecipients.length} of ${totalSelected} contacts (${skipped} not ready).`
              : `SMS sent to ${readyRecipients.length} contact(s).`,
          );
        }
        await refresh();
      } catch (error) {
        // Recover from memory — SosPanicError carries any partial incident
        // in-process, so the SOS banner stays up even if localStorage failed.
        if (error instanceof SosPanicError && error.partialIncident) {
          setSosIncident(error.partialIncident);
        }
        toast.error(
          error instanceof Error ? error.message : "Could not send SMS alert.",
        );
      } finally {
        setBusy(null);
      }
    },
    [
      permission,
      publishEnvelopeWithRetry,
      resolveSosLocation,
      smsActionRecipients,
      refresh,
      sosIncident,
      vaultOwnerToken,
    ],
  );

  const handleAddSmsContact = useCallback(
    async (recipientUserId: string) => {
      if (!auth.userId || !vaultOwnerToken || busy) return false;
      setBusy(`sms-contact:${recipientUserId}`);
      try {
        const smsContactUserIds = await OneLocationService.addSmsContact({
          vaultOwnerToken,
          recipientUserId,
        });
        if (
          !OneLocationStateResource.replaceSmsContactUserIds(
            auth.userId,
            smsContactUserIds,
          )
        ) {
          await refresh();
        }
        toast.success("SMS contact added.");
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not add SMS contact.",
        );
        return false;
      } finally {
        setBusy(null);
      }
    },
    [auth.userId, busy, refresh, vaultOwnerToken],
  );

  const handleRemoveSmsContact = useCallback(
    async (recipientUserId: string) => {
      if (!auth.userId || !vaultOwnerToken || busy) return false;
      setBusy(`sms-contact:${recipientUserId}`);
      try {
        const smsContactUserIds = await OneLocationService.removeSmsContact({
          vaultOwnerToken,
          recipientUserId,
        });
        if (
          !OneLocationStateResource.replaceSmsContactUserIds(
            auth.userId,
            smsContactUserIds,
          )
        ) {
          await refresh();
        }
        toast.success("SMS contact removed.");
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not remove SMS contact.",
        );
        return false;
      } finally {
        setBusy(null);
      }
    },
    [auth.userId, busy, refresh, vaultOwnerToken],
  );

  const handlePublish = useCallback(
    async (grant: OneLocationGrant) => {
      const recipient = recipientForGrant(grant);
      if (!recipient) {
        toast.error("This share needs the recipient to open Location once.");
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
        await publishEnvelopeWithRetry(
          grant,
          recipient,
          "manual",
          readiness.point,
        );
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
    [
      ensureForegroundLocationReady,
      publishEnvelopeWithRetry,
      recipientForGrant,
      refresh,
    ],
  );

  const viewGrantEnvelope = useCallback(
    async (
      grant: OneLocationGrant,
      options?: { silent?: boolean; trigger?: OneLocationForegroundTrigger },
    ) => {
      if (!auth.userId || !vaultOwnerToken) return;
      const activeUserId = auth.userId;
      const silent = Boolean(options?.silent);
      const trigger =
        options?.trigger ?? (silent ? "foreground_interval" : "manual");
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
            try {
              return await decryptLocationEnvelope({
                userId: activeUserId,
                envelope: response.envelope,
              });
            } catch (decryptError) {
              // Brand-new device (or not-yet-synced): pull the vault-synced key
              // shared across the user's devices and retry once before giving up.
              if (
                decryptError instanceof Error &&
                decryptError.message === RECIPIENT_KEY_UNAVAILABLE_MESSAGE &&
                vaultKey &&
                state?.myRecipientKey?.encryptedPrivateKeyJwk
              ) {
                await ensureVaultSyncedRecipientKey({
                  userId: activeUserId,
                  vaultKey,
                  remoteBackup: state.myRecipientKey,
                }).catch(() => {});
                return await decryptLocationEnvelope({
                  userId: activeUserId,
                  envelope: response.envelope,
                });
              }
              throw decryptError;
            }
          },
        });
        setDecryptedPoints((current) => ({ ...current, [grant.id]: point }));
        // Recovered — clear any prior "ask them to share again" state.
        setGrantViewErrors((current) => {
          if (!(grant.id in current)) return current;
          const next = { ...current };
          delete next[grant.id];
          return next;
        });
      } catch (error) {
        const keyUnavailable =
          error instanceof Error &&
          error.message === RECIPIENT_KEY_UNAVAILABLE_MESSAGE;
        // The grant is active ("Live") but the owner has not published any
        // encrypted point yet — e.g. they JUST started sharing, or haven't
        // moved / re-opened One since. The backend returns a 404
        // LOCATION_ENVELOPE_MISSING for this. It's a normal "not ready yet"
        // state on the happy path, NOT a failure, so we must never surface the
        // raw backend string ("The owner has not published an encrypted
        // location envelope yet.") as a scary red error toast the moment the
        // recipient lands on the page.
        const envelopeMissing =
          !keyUnavailable &&
          (apiErrorCode(error) === "LOCATION_ENVELOPE_MISSING" ||
            (error instanceof Error &&
              /has not published an encrypted location envelope/i.test(
                error.message,
              )));
        if (keyUnavailable) {
          // The recipient's device key rotated / was lost, so this envelope was
          // encrypted for a key we no longer hold. Self-heal: re-register our
          // current (now durable) key so future shares work, and surface an
          // actionable inline state prompting the owner to share again — instead
          // of a raw crypto error toast (manual) or a silent console.warn.
          void bootstrapCurrentUserLocationRecipientKey({
            userId: activeUserId,
            vaultOwnerToken,
            vaultKey: vaultKey ?? undefined,
          }).catch((bootstrapError) => {
            console.warn(
              "[OneLocationAgent] Recipient key re-registration failed:",
              bootstrapError,
            );
          });
          setGrantViewErrors((current) => ({
            ...current,
            [grant.id]: `Couldn't open ${receivedGrantOwnerLabel(
              grant,
            )}'s live location — the secure key changed. Ask them to share again.`,
          }));
        } else if (envelopeMissing) {
          // Calm, reassuring "waiting for their first update" state. The share
          // is genuinely active; the point simply hasn't arrived yet and will
          // appear automatically on the next poll once the owner publishes.
          const waitingMessage = `${receivedGrantOwnerLabel(
            grant,
          )} is sharing, but hasn't sent a live location update yet. It will appear here automatically as soon as they move or open One.`;
          setGrantViewErrors((current) =>
            current[grant.id] === waitingMessage
              ? current
              : { ...current, [grant.id]: waitingMessage },
          );
          // Only nudge with a gentle (non-error) toast on an explicit tap, and
          // never on the background poll, so the page stays quiet while waiting.
          if (!silent) {
            toast.message(waitingMessage);
          }
        } else if (!silent) {
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
    [
      auth.userId,
      vaultOwnerToken,
      vaultKey,
      state?.myRecipientKey,
      setDecryptedPoints,
    ],
  );

  // Recipient-side "ask them to share again": re-request access from the owner
  // of a share we can no longer decrypt. Reuses the standard request flow so the
  // owner gets a location_access_request notification; when they re-share, the
  // fresh grant snapshots our current key and live updates resume.
  const handleAskReshare = useCallback(
    async (grant: OneLocationGrant) => {
      if (!vaultOwnerToken || !auth.userId) return;
      const ownerUserId = String(grant.ownerUserId || "").trim();
      if (!ownerUserId) return;
      setBusy("request");
      try {
        await OneLocationService.requestAccess({
          vaultOwnerToken,
          ownerUserId,
          message: `Please share your live location again — my secure key was refreshed.`,
        });
        playOneLocationNotificationSound();
        toast.success(
          `Asked ${receivedGrantOwnerLabel(grant)} to share their location again.`,
        );
      } catch (error) {
        toast.error(oneLocationErrorMessage(error, "Could not send request."));
      } finally {
        setBusy(null);
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
      setGrantViewErrors((current) => {
        if (!(grant.id in current)) return current;
        const next = { ...current };
        delete next[grant.id];
        return next;
      });
      toast.success(
        `Stopped watching ${receivedGrantOwnerLabel(grant)}'s location.`,
      );
    },
    [auth.userId, setDecryptedPoints],
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
    setGrantViewErrors((current) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [grantId, message] of Object.entries(current)) {
        if (activeGrantIds.has(grantId)) {
          next[grantId] = message;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [state?.receivedGrants, setDecryptedPoints]);

  useEffect(() => {
    if (!vaultOwnerToken || !activeOwnerGrants.length) return;
    if (locationControl.paused) return;
    if (!locationControl.autoShareEnabled) return;
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
      if (!automaticPrivatePublishingAllowedRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      livePublishInFlightRef.current = true;
      try {
        const point = await OneLocationService.captureCurrentPosition();
        if (!automaticPrivatePublishingAllowedRef.current) return;
        for (const grant of activeOwnerGrants) {
          if (!automaticPrivatePublishingAllowedRef.current) return;
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
    locationControl.autoShareEnabled,
    locationControl.paused,
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
    if (locationControl.paused) return;
    if (!locationControl.autoShareEnabled) return;
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
      if (!automaticPrivatePublishingAllowedRef.current) return;
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

      // Reflect movement in the owner's own live preview, throttled to the same
      // cadence a viewer sees a shared dot (LIVE_VIEW_REFRESH_INTERVAL_MS) so the
      // self marker doesn't re-render/animate on every GPS fix (~1s). Publishing
      // below still uses the raw `point`, so shared accuracy is unaffected.
      if (now - lastSelfMarkerAtRef.current >= LIVE_VIEW_REFRESH_INTERVAL_MS) {
        lastSelfMarkerAtRef.current = now;
        setMyLocationPoint(point);
      }

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
          if (!automaticPrivatePublishingAllowedRef.current) return;
          const recipient = recipientForGrant(grant);
          if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
          const driven = await drivePointForGrant(grant, point);
          const pointForGrant = pickupPointForGrant(grant, driven);
          await publishEnvelopeWithRetry(
            grant,
            recipient,
            "foreground_interval",
            pointForGrant,
          );
        }
        lastPublishedPointRef.current = point;
        lastWatchPublishAtRef.current = Date.now();
      } catch (error) {
        console.warn("[OneLocationAgent] Live movement update skipped:", error);
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
    locationControl.autoShareEnabled,
    locationControl.paused,
    permission?.state,
    publishEnvelopeWithRetry,
    recipientForGrant,
    drivePointForGrant,
    pickupPointForGrant,
    setMyLocationPoint,
    vaultOwnerToken,
  ]);

  // Live self-preview (Device readiness): once the owner taps "Show my location"
  // we stream their own position continuously so the preview moves in real time,
  // even before any share exists. Foreground-only (visibility-guarded). When a
  // share IS active the publish watch above already keeps myLocationPoint fresh,
  // so this standalone watch stands down to avoid a duplicate GPS stream.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      !shouldStreamSelfPreview({
        streaming:
          locationControl.selfPreviewEnabled && !locationControl.paused,
        activeGrantCount: locationControl.autoShareEnabled
          ? activeOwnerGrants.length
          : 0,
        permissionState: permission?.state,
      })
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const watchId = await OneLocationService.watchCurrentPosition(
          (point) => {
            if (cancelled) return;
            if (
              typeof document !== "undefined" &&
              document.visibilityState === "hidden"
            ) {
              return;
            }
            // Throttle the self-preview marker to the viewer refresh cadence
            // (LIVE_VIEW_REFRESH_INTERVAL_MS) instead of updating on every GPS
            // fix (~1s), which needlessly re-renders/animates and burns compute.
            const now = Date.now();
            if (
              now - lastSelfMarkerAtRef.current <
              LIVE_VIEW_REFRESH_INTERVAL_MS
            ) {
              return;
            }
            lastSelfMarkerAtRef.current = now;
            setMyLocationPoint(point);
          },
          (error) => {
            console.warn(
              "[OneLocationAgent] Self-preview watch error:",
              error.message,
            );
          },
        );
        if (cancelled) {
          void OneLocationService.clearLocationWatch(watchId).catch(() => null);
          return;
        }
        selfWatchIdRef.current = watchId;
      } catch (error) {
        console.warn(
          "[OneLocationAgent] Could not start self-preview watch:",
          error,
        );
      }
    })();

    return () => {
      cancelled = true;
      const watchId = selfWatchIdRef.current;
      selfWatchIdRef.current = null;
      if (watchId) {
        void OneLocationService.clearLocationWatch(watchId).catch(() => null);
      }
    };
  }, [
    locationControl.autoShareEnabled,
    locationControl.paused,
    locationControl.selfPreviewEnabled,
    activeOwnerGrants.length,
    permission?.state,
    setMyLocationPoint,
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
      LIVE_VIEW_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);

  // Keep native background publishing in sync with the opt-in toggle + grants.
  // Web returns { started:false } and this is a no-op there.
  useEffect(() => {
    if (!vaultOwnerToken) return;
    const session = buildBackgroundShareSession({
      activeGrants: activeOwnerGrants,
      recipients,
      vaultOwnerToken,
      backendBaseUrl: getApiBaseUrl(),
      minMoveMeters: LIVE_LOCATION_MIN_MOVE_METERS,
      minIntervalMs: LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS,
    });
    void syncBackgroundShare({
      enabled:
        backgroundShareEnabled &&
        locationControl.autoShareEnabled &&
        !locationControl.paused,
      session,
    });
    return () => {
      void OneLocationService.stopBackgroundShare();
    };
  }, [
    backgroundShareEnabled,
    activeOwnerGrants,
    locationControl.autoShareEnabled,
    locationControl.paused,
    recipients,
    vaultOwnerToken,
  ]);

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

  const handleStopSos = useCallback(async () => {
    if (!vaultOwnerToken) return;
    const incident = sosIncident;
    if (!incident?.grantIds.length) return;
    setBusy("sos");
    try {
      for (const grantId of incident.grantIds) {
        await OneLocationService.revokeGrant({
          vaultOwnerToken,
          grantId,
        }).catch((error) => {
          // A grant may already be expired/revoked — keep tearing the rest down.
          console.warn(
            "[OneLocationAgent] SOS stop: grant revoke skipped:",
            error,
          );
        });
      }
    } finally {
      setBusy(null);
    }
    // Clear the incident and show success AFTER revokes, outside any try-catch so a
    // subsequent refresh() failure cannot trigger a misleading "Could not stop" toast.
    clearSosIncident();
    setSosIncident(null);
    toast.success("SMS ended. Live location sharing stopped.");
    try {
      await refresh();
    } catch {
      /* refresh failure is non-fatal; sharing has already been stopped */
    }
  }, [refresh, sosIncident, vaultOwnerToken]);

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
        result:
          status === "denied" || status === "unavailable"
            ? "expected_error"
            : "error",
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
      await AccountIdentityService.syncCurrentUser(activeUser).catch(
        (error) => {
          console.warn(
            "[OneLocation] Failed to sync account identity before request:",
            error,
          );
        },
      );
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
        oneLocationErrorMessage(
          error,
          "Could not create public location link.",
        ),
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
          oneLocationErrorMessage(
            error,
            "Could not revoke Invite to One link.",
          ),
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
        toast.error(
          "They need to open Location once before approval can finish.",
        );
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
    [
      durationHours,
      publishEnvelopeWithRetry,
      recipients,
      refresh,
      vaultOwnerToken,
    ],
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
          recommendation_category:
            recipient.recommendationCategory ?? "unknown",
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

  const startShareComposer = useCallback(
    (initialRecipientId?: string) => {
      const recipientId = initialRecipientId?.trim() || "";
      resetShareComposer(recipientId || undefined);
      if (!recipientId) return;
      const recipient = recipients.find((item) => item.userId === recipientId);
      if (recipient) {
        trackRecommendationSelection(recipient, "share", "section_list", 1);
      }
    },
    [recipients, resetShareComposer, trackRecommendationSelection],
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
      const nextSelectedIds = toggleSelectedId(
        selectedRecipientIds,
        recipientId,
      );
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

  // Private Check-In is an explicit second consent stage after optional nearby
  // presence. It shares live location only with the trusted contacts selected
  // on that screen, using the normal per-recipient grant + encrypted envelope
  // pipeline. A successful nearby check-in never authorizes this private share.
  const privateCheckInEnvelopeCacheRef = useRef(
    new Map<string, OneLocationEncryptedEnvelope>(),
  );
  useEffect(() => {
    privateCheckInEnvelopeCacheRef.current.clear();
  }, [auth.userId]);
  const discardPrivateCheckInOperation = useCallback(
    (operationId: string | null) => {
      const ownerPrefix = `${auth.userId ?? "anonymous"}:`;
      const operationPrefix = operationId
        ? `${ownerPrefix}${operationId}:`
        : ownerPrefix;
      for (const cacheKey of privateCheckInEnvelopeCacheRef.current.keys()) {
        if (cacheKey.startsWith(operationPrefix)) {
          privateCheckInEnvelopeCacheRef.current.delete(cacheKey);
        }
      }
    },
    [auth.userId],
  );
  const handleCheckIn = useCallback(
    async (request: PrivateCheckInRequest): Promise<PrivateCheckInResult> => {
      const {
        recipientIds,
        durationHours: durationHoursValue,
        message: messageValue,
        point,
        clientOperationId,
        confirmedAt,
      } = request;
      const selected = sosActionRecipients
        .filter((recipient) => recipientIds.includes(recipient.userId))
        .filter(isShareReadyRecipient);
      const failedSelection: PrivateCheckInResult = {
        succeededRecipientIds: [],
        failedRecipientIds:
          selected.length > 0
            ? selected.map((recipient) => recipient.userId)
            : recipientIds,
      };
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) {
        toast.error("Location permission is required to check in.");
        return failedSelection;
      }
      if (!selected.length) {
        toast.error(
          "Select at least one trusted contact who is ready to receive your location.",
        );
        return failedSelection;
      }
      // The user-authored note is encrypted with the reviewed point. Only the
      // fixed `check_in` reason code is persisted in grant/audit metadata.
      const checkInMessage =
        (messageValue || "").trim().slice(0, 160) || undefined;
      setBusy("share");
      const succeededRecipientIds: string[] = [];
      const failedRecipientIds: string[] = [];
      try {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: false,
          autoOpenSettings: true,
        });
        // The location shown on the consent screen is the only point this
        // operation may encrypt; permission is rechecked without recapturing.
        if (!readiness.ready) {
          toast.error("Location permission is required to check in.");
          return failedSelection;
        }
        const capturedAtMs = Date.parse(point.capturedAt);
        const confirmedAtMs = Date.parse(confirmedAt);
        const nowMs = Date.now();
        if (
          !Number.isFinite(capturedAtMs) ||
          !Number.isFinite(confirmedAtMs) ||
          confirmedAtMs > nowMs + 30_000 ||
          capturedAtMs > confirmedAtMs + 30_000 ||
          confirmedAtMs - capturedAtMs > 60_000 ||
          nowMs - confirmedAtMs > 10 * 60_000
        ) {
          toast.error("Refresh and review your location before sharing it.");
          return failedSelection;
        }
        const durationHoursNum = Number(durationHoursValue) || 1;
        const operationCachePrefix = `${
          auth.userId ?? "anonymous"
        }:${clientOperationId}:`;
        for (const cacheKey of privateCheckInEnvelopeCacheRef.current.keys()) {
          if (!cacheKey.startsWith(operationCachePrefix)) {
            privateCheckInEnvelopeCacheRef.current.delete(cacheKey);
          }
        }
        const preparedShares = await Promise.all(
          selected.map(async (recipient) => {
            const cacheKey = `${operationCachePrefix}${recipient.userId}:${
              recipient.keyId!
            }`;
            const cached = privateCheckInEnvelopeCacheRef.current.get(cacheKey);
            const envelope =
              cached ??
              (await encryptLocationForRecipient({
                point: {
                  ...point,
                  ...(checkInMessage
                    ? { checkIn: { message: checkInMessage } }
                    : {}),
                },
                recipientPublicKeyJwk: recipient.publicKeyJwk!,
                recipientKeyId: recipient.keyId!,
              }));
            if (!cached) {
              privateCheckInEnvelopeCacheRef.current.set(cacheKey, envelope);
            }
            return { recipient, envelope, cacheKey };
          }),
        );
        for (const { recipient, envelope, cacheKey } of preparedShares) {
          try {
            await OneLocationService.createGrantWithEnvelope({
              vaultOwnerToken,
              recipientUserId: recipient.userId,
              recipientKeyId: recipient.keyId!,
              durationHours: durationHoursNum,
              clientOperationId,
              confirmedAt,
              envelope,
              reason: "check_in",
              shareKind: "check_in",
            });
            succeededRecipientIds.push(recipient.userId);
            privateCheckInEnvelopeCacheRef.current.delete(cacheKey);
          } catch (error) {
            failedRecipientIds.push(recipient.userId);
            console.warn(
              "[OneLocationAgent] Private check-in failed for one recipient.",
              error,
            );
          }
        }
        const successCount = succeededRecipientIds.length;
        const failureCount = failedRecipientIds.length;
        trackEvent("one_location_share_confirmed", {
          route_id: "one_location",
          result: oneLocationEventResult(successCount, failureCount),
          selected_count: selected.length,
          success_count: successCount,
          failure_count: failureCount,
          duration_bucket: oneLocationDurationBucket(durationHoursValue),
          review_required: false,
        });
        if (failureCount === 0) {
          toast.success(
            `Checked in with ${peopleCountLabel(selected.length)}.`,
          );
          // Closes the Check-In flow and returns to its authored source.
          setShareCompletedTick((value) => value + 1);
        } else if (successCount > 0) {
          toast.warning(
            `Shared with ${peopleCountLabel(successCount)}. Retry ${peopleCountLabel(failureCount)}.`,
          );
        } else {
          toast.error(
            "Could not share with the selected people. Please retry.",
          );
        }
        await refresh().catch((refreshError) => {
          console.warn(
            "[OneLocationAgent] Private check-in state refresh failed.",
            refreshError,
          );
        });
        return { succeededRecipientIds, failedRecipientIds };
      } catch (error) {
        const remainingRecipientIds = selected
          .map((recipient) => recipient.userId)
          .filter(
            (recipientId) => !succeededRecipientIds.includes(recipientId),
          );
        trackEvent("one_location_share_confirmed", {
          route_id: "one_location",
          result: oneLocationEventResult(
            succeededRecipientIds.length,
            remainingRecipientIds.length || 1,
          ),
          selected_count: selected.length,
          success_count: succeededRecipientIds.length,
          failure_count: remainingRecipientIds.length || 1,
          duration_bucket: oneLocationDurationBucket(durationHoursValue),
          review_required: false,
        });
        toast.error(
          error instanceof Error ? error.message : "Could not check in.",
        );
        return {
          succeededRecipientIds,
          failedRecipientIds: remainingRecipientIds,
        };
      } finally {
        setBusy(null);
      }
    },
    [
      auth.userId,
      vaultOwnerToken,
      permission,
      sosActionRecipients,
      ensureForegroundLocationReady,
      refresh,
    ],
  );

  const handleDriveTo = useCallback(
    async (
      destination: DriveDestination,
      recipientIds: string[],
      durationHoursValue: string,
      shareKind?: string,
    ) => {
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) {
        toast.error("Location permission is required to share your drive.");
        return;
      }
      const selected = sosActionRecipients
        .filter((recipient) => recipientIds.includes(recipient.userId))
        .filter(isShareReadyRecipient);
      if (!selected.length) {
        toast.error(
          "Select at least one trusted contact who is ready to receive your location.",
        );
        return;
      }
      setBusy("driveTo");
      try {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
        });
        if (!readiness.ready || !readiness.point) {
          toast.error("Couldn't get your location — drive not shared.");
          return;
        }
        const point = readiness.point;
        const durationHoursNum = Number(durationHoursValue) || 1;

        // Initial ETA (best-effort; the share still works without it).
        let etaSeconds: number | null = null;
        let distanceMeters: number | null = null;
        try {
          const eta = await OneLocationService.routeEta({
            vaultOwnerToken,
            originLat: point.latitude,
            originLng: point.longitude,
            destLat: destination.latitude,
            destLng: destination.longitude,
          });
          etaSeconds = eta.etaSeconds;
          distanceMeters = eta.distanceMeters;
        } catch {
          // ETA unavailable — proceed with destination only.
        }

        const etaComputedAt = new Date().toISOString();
        const drive: DriveSharePayload = {
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
        };
        const drivePoint: PlainLocationPoint = { ...point, drive };
        const grantIds = new Set<string>();

        for (const recipient of selected) {
          const grant = await OneLocationService.createGrant({
            vaultOwnerToken,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId,
            durationHours: durationHoursNum,
            reason: "drive_to",
            ...(shareKind ? { shareKind } : {}),
          });
          await publishEnvelopeWithRetry(
            grant,
            recipient,
            "manual",
            drivePoint,
          );
          grantIds.add(grant.id);
        }

        driveSessionRef.current = {
          grantIds,
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
          lastEtaPoint: point,
          lastEtaAt: Date.now(),
        };
        // Persist the session so the live ETA survives a refresh/remount — the
        // watch loop rehydrates it on mount and keeps attaching the ETA payload.
        if (auth.userId) {
          void saveDriveSession(auth.userId, {
            grantIds: [...grantIds],
            destination,
            etaSeconds,
            distanceMeters,
            etaComputedAt,
          });
        }

        if (auth.userId) {
          await addRecentDestination(auth.userId, destination);
          setRecentDestinations(await loadRecentDestinations(auth.userId));
        }

        toast.success(
          `Sharing your drive with ${peopleCountLabel(selected.length)}.`,
        );
        setShareCompletedTick((value) => value + 1);
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not share your drive.",
        );
      } finally {
        setBusy(null);
      }
    },
    [
      vaultOwnerToken,
      permission,
      sosActionRecipients,
      ensureForegroundLocationReady,
      publishEnvelopeWithRetry,
      refresh,
      auth.userId,
    ],
  );

  // "I'm on my way" — helper-side reverse share: when a helper receives a
  // Pick Me Up grant they tap "I'm on my way" which drives this handler. It
  // creates a drive-style grant back to the requester (the grant owner) so the
  // requester can watch the helper approaching their pickup point in real time.
  const _handleImOnMyWay = useCallback(
    async (grant: OneLocationGrant) => {
      // grant.ownerUserId is the REQUESTER (who asked for the pickup); we (the
      // helper) share our live drive to their pickup point.
      const requesterUserId = String(grant.ownerUserId || "").trim();
      const point = decryptedPoints[grant.id];
      if (!requesterUserId || !point) {
        toast.error("Can't start yet — open their pickup first.");
        return;
      }
      const destination: DriveDestination = {
        label: `${receivedGrantOwnerLabel(grant)} · pickup`,
        latitude: point.latitude,
        longitude: point.longitude,
      };
      await handleDriveTo(
        destination,
        [requesterUserId],
        "4",
        "pickup_enroute",
      );
    },
    [decryptedPoints, handleDriveTo],
  );

  // Pick Me Up quick action (INBOUND help): share your LIVE location + a pickup
  // message so a trusted person can drive straight to you and watch you until
  // they arrive. Reuses the exact encrypted share pipeline (createGrant +
  // publish) as Check-In — no new crypto, no new consent surface. The live
  // foreground watch keeps the recipient's map moving as you (or they) move, and
  // sharing auto-expires when the timer ends. The pickup message rides along as
  // the grant reason so it surfaces in the recipient's notification
  // ("<You>: I need a ride now — please pick me up ASAP.").
  const _handlePickMeUp = useCallback(
    async (
      recipientIds: string[],
      durationHoursValue: string,
      messageValue?: string,
      pickupPoint?: { latitude: number; longitude: number; label?: string },
    ) => {
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) {
        toast.error("Location permission is required to request a pickup.");
        return;
      }
      const selected = sosActionRecipients
        .filter((recipient) => recipientIds.includes(recipient.userId))
        .filter(isShareReadyRecipient);
      if (!selected.length) {
        toast.error(
          "Select at least one trusted contact who is ready to receive your location.",
        );
        return;
      }
      const pickupMessage =
        (messageValue || "").trim().slice(0, 160) || undefined;
      setBusy("share");
      let successCount = 0;
      try {
        let point: PlainLocationPoint;
        if (pickupPoint) {
          // Adjusted fixed spot: share exactly this point (kept fixed by the watch loop).
          point = {
            latitude: pickupPoint.latitude,
            longitude: pickupPoint.longitude,
            capturedAt: new Date().toISOString(),
            sourcePlatform: "web",
          };
        } else {
          const readiness = await ensureForegroundLocationReady({
            capturePoint: true,
            autoOpenSettings: true,
          });
          if (!readiness.ready || !readiness.point) {
            toast.error(
              "Couldn't get your location — pickup request not sent.",
            );
            return;
          }
          point = readiness.point;
        }
        const durationHoursNum = Number(durationHoursValue) || 1;
        for (const recipient of selected) {
          const grant = await OneLocationService.createGrant({
            vaultOwnerToken,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId,
            durationHours: durationHoursNum,
            reason: pickupMessage,
            shareKind: "pick_me_up",
          });
          // Anchor the grant to the fixed-pickup session BEFORE publishing so a
          // mid-publish failure can't leave a created grant drifting to live GPS
          // when the user chose a fixed spot.
          if (pickupPoint) {
            pickupSessionRef.current.set(grant.id, point);
          }
          await publishEnvelopeWithRetry(grant, recipient, "manual", point);
          successCount += 1;
        }
        trackEvent("one_location_share_confirmed", {
          route_id: "one_location",
          result: oneLocationEventResult(successCount, 0),
          selected_count: selected.length,
          success_count: successCount,
          failure_count: 0,
          duration_bucket: oneLocationDurationBucket(durationHoursValue),
          review_required: false,
        });
        toast.success(
          `Pickup requested from ${peopleCountLabel(selected.length)}. They can see you live.`,
        );
        setShareCompletedTick((value) => value + 1);
        await refresh();
      } catch (error) {
        const failureCount = selected.length - successCount || 1;
        trackEvent("one_location_share_confirmed", {
          route_id: "one_location",
          result: oneLocationEventResult(successCount, failureCount),
          selected_count: selected.length,
          success_count: successCount,
          failure_count: failureCount,
          duration_bucket: oneLocationDurationBucket(durationHoursValue),
          review_required: false,
        });
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not request a pickup.",
        );
      } finally {
        setBusy(null);
      }
    },
    [
      vaultOwnerToken,
      permission,
      sosActionRecipients,
      ensureForegroundLocationReady,
      publishEnvelopeWithRetry,
      refresh,
    ],
  );

  // Safe Arrival quick action (OUTBOUND peace-of-mind): share your live journey
  // + live ETA to a destination until you arrive, so trusted people can watch
  // you get there safely. Mirrors handleDriveTo exactly (destination + ETA ride
  // INSIDE the encrypted envelope, and the drive session drives live ETA
  // recomputation via the foreground watch) — it is the same proven live-share
  // pipeline with an arrival-focused framing and its own busy key + note.
  const _handleSafeArrival = useCallback(
    async (
      destination: DriveDestination,
      recipientIds: string[],
      durationHoursValue: string,
      messageValue?: string,
    ) => {
      if (!vaultOwnerToken || locationPermissionBlocksSharing(permission)) {
        toast.error("Location permission is required to share your arrival.");
        return;
      }
      const selected = sosActionRecipients
        .filter((recipient) => recipientIds.includes(recipient.userId))
        .filter(isShareReadyRecipient);
      if (!selected.length) {
        toast.error(
          "Select at least one trusted contact who is ready to receive your location.",
        );
        return;
      }
      const arrivalMessage =
        (messageValue || "").trim().slice(0, 160) || undefined;
      setBusy("safeArrival");
      try {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
        });
        if (!readiness.ready || !readiness.point) {
          toast.error(
            "Couldn't get your location — arrival watch not started.",
          );
          return;
        }
        const point = readiness.point;
        const durationHoursNum = Number(durationHoursValue) || 1;

        // Initial ETA (best-effort; the share still works without it).
        let etaSeconds: number | null = null;
        let distanceMeters: number | null = null;
        try {
          const eta = await OneLocationService.routeEta({
            vaultOwnerToken,
            originLat: point.latitude,
            originLng: point.longitude,
            destLat: destination.latitude,
            destLng: destination.longitude,
          });
          etaSeconds = eta.etaSeconds;
          distanceMeters = eta.distanceMeters;
        } catch {
          // ETA unavailable — proceed with destination only.
        }

        const etaComputedAt = new Date().toISOString();
        const drive: DriveSharePayload = {
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
        };
        const drivePoint: PlainLocationPoint = { ...point, drive };
        const grantIds = new Set<string>();

        for (const recipient of selected) {
          const grant = await OneLocationService.createGrant({
            vaultOwnerToken,
            recipientUserId: recipient.userId,
            recipientKeyId: recipient.keyId,
            durationHours: durationHoursNum,
            reason: arrivalMessage ?? "safe_arrival",
          });
          await publishEnvelopeWithRetry(
            grant,
            recipient,
            "manual",
            drivePoint,
          );
          grantIds.add(grant.id);
        }

        driveSessionRef.current = {
          grantIds,
          destination,
          etaSeconds,
          distanceMeters,
          etaComputedAt,
          lastEtaPoint: point,
          lastEtaAt: Date.now(),
        };
        // Persist the session so the live ETA survives a refresh/remount — the
        // watch loop rehydrates it on mount and keeps attaching the ETA payload.
        if (auth.userId) {
          void saveDriveSession(auth.userId, {
            grantIds: [...grantIds],
            destination,
            etaSeconds,
            distanceMeters,
            etaComputedAt,
          });
        }

        if (auth.userId) {
          await addRecentDestination(auth.userId, destination);
          setRecentDestinations(await loadRecentDestinations(auth.userId));
        }

        toast.success(
          `Safe Arrival started. ${peopleCountLabel(selected.length)} can watch you reach ${destination.label}.`,
        );
        setShareCompletedTick((value) => value + 1);
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not start Safe Arrival.",
        );
      } finally {
        setBusy(null);
      }
    },
    [
      vaultOwnerToken,
      permission,
      sosActionRecipients,
      ensureForegroundLocationReady,
      publishEnvelopeWithRetry,
      refresh,
      auth.userId,
    ],
  );

  const canShare = Boolean(
    vaultOwnerToken &&
    selectedShareRecipients.length &&
    shareReadySelectedRecipients.length &&
    !setupNeededSelectedRecipients.length &&
    shareMessage.length <= ONE_LOCATION_SHARE_NOTE_MAX_LENGTH &&
    !locationPermissionBlocksSharing(permission),
  );
  const handleOpenShareReview = useCallback(async () => {
    if (!canShare) return;
    const attemptId = shareReviewAttemptRef.current + 1;
    shareReviewAttemptRef.current = attemptId;
    shareReviewPendingRef.current = true;
    setBusy("share");
    const readiness = await ensureForegroundLocationReady({
      capturePoint: false,
      autoOpenSettings: true,
    });
    if (shareReviewAttemptRef.current !== attemptId) return;
    shareReviewPendingRef.current = false;
    setBusy(null);
    if (!readiness.ready) return;
    setShareReviewOpen(true);
    trackEvent(
      "one_location_share_review_opened",
      {
        route_id: "one_location",
        result: "success",
        selected_count: shareReadySelectedRecipients.length,
        duration_bucket: oneLocationDurationBucket(shareDurationHours),
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
        dedupeKey: `one_location_share_review_opened:${shareReadySelectedRecipients.length}:${shareDurationHours}`,
      },
    );
  }, [
    canShare,
    ensureForegroundLocationReady,
    permission?.state,
    setupNeededSelectedRecipients.length,
    shareDurationHours,
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
        const message =
          "Live location preview needs device Location permission.";
        setMyLocationError(message);
        return;
      }
      setMapViewportResetKey((current) => current + 1);
      toast.success("Your live location preview is ready.");
    } catch (error) {
      const message = locationServicesErrorMessage(error);
      setMyLocationError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [ensureForegroundLocationReady]);

  // One coordinated pause owns every Location entry point. Private grants keep
  // their consent/expiry contract, but all new foreground/background updates
  // stop. Nearby presence is a separate authority and must explicitly check
  // out before the UI may claim that Location is paused.
  const handleHideMyLiveLocation = useCallback(async () => {
    if (!auth.userId) return;
    if (nearbyCheckInAvailable && !vaultOwnerToken) {
      toast.error("Unlock One before pausing nearby location.");
      return;
    }

    setBusy("selfLocation");
    automaticPrivatePublishingAllowedRef.current = false;
    try {
      if (nearbyCheckInAvailable && vaultOwnerToken) {
        const nearby = await OneLocationService.getNearbyPresence({
          vaultOwnerToken,
        });
        if (nearby.presence) {
          await OneLocationService.checkoutNearby({ vaultOwnerToken });
        }
      }
      updateOneLocationControlState(auth.userId, (current) => ({
        ...current,
        paused: true,
        selfPreviewEnabled: false,
        nearbyPresenceActive: false,
        nearbyCheckedInAt: null,
      }));
      clearMyLocationPreview();
      setBackgroundShareEnabled(false);
      setMyLocationError(null);
      toast.success("Location updates are paused on this device.");
    } catch {
      automaticPrivatePublishingAllowedRef.current =
        locationControl.autoShareEnabled;
      toast.error(
        "Pause did not complete. You may still be visible nearby; please try again.",
      );
    } finally {
      setBusy(null);
    }
  }, [
    auth.userId,
    clearMyLocationPreview,
    locationControl.autoShareEnabled,
    nearbyCheckInAvailable,
    vaultOwnerToken,
  ]);

  const handleResumeMyLocation = useCallback(() => {
    void handleShowMyLiveLocation();
  }, [handleShowMyLiveLocation]);

  const handleAutoShareChange = useCallback(
    (enabled: boolean) => {
      automaticPrivatePublishingAllowedRef.current =
        enabled && !locationControl.paused;
      updateOneLocationControlState(auth.userId, (current) => ({
        ...current,
        autoShareEnabled: enabled,
      }));
      if (!enabled) setBackgroundShareEnabled(false);
      toast.success(
        enabled
          ? "Approved shares will receive live updates."
          : "Approved shares will update only when you explicitly share.",
      );
    },
    [auth.userId, locationControl.paused],
  );

  const markLocationOnboardingSeen = useCallback(() => {
    // Persist only after completion so an interrupted first run can resume next
    // time. Explicit setup and workspace onboarding share the same authored
    // introduction, so finishing setup must also prevent the workspace from
    // immediately replaying it after the setup coordinator navigates there.
    if (typeof window !== "undefined" && auth.userId) {
      try {
        window.localStorage.setItem(
          `one_location_onboarding_v2:${auth.userId}`,
          "1",
        );
      } catch {
        // localStorage may be unavailable (private mode); intro will simply
        // show again next time, which is acceptable.
      }
    }
  }, [auth.userId]);

  const dismissLocationOnboarding = useCallback(async () => {
    markLocationOnboardingSeen();
    if (mode === "setup") {
      await onSetupComplete?.();
      return;
    }
    setLocationOnboardingGate("hidden");
    setLocationOnboardingBusy(false);
  }, [markLocationOnboardingSeen, mode, onSetupComplete]);

  const skipLocationOnboarding = useCallback(async () => {
    if (mode === "setup") {
      await onSetupSkip?.();
      return;
    }
    dismissLocationOnboarding();
  }, [dismissLocationOnboarding, mode, onSetupSkip]);

  const handleSendLocationOnboardingConnectionRequests = useCallback(
    async (userIds: string[]): Promise<ConnectionRequestResult> => {
      if (!auth.user || userIds.length === 0) {
        return { sentUserIds: [], failedUserIds: [] };
      }

      let idToken: string;
      try {
        idToken = await auth.user.getIdToken();
      } catch {
        toast.error("Your session could not be verified. Please try again.");
        return { sentUserIds: [], failedUserIds: [...new Set(userIds)] };
      }
      const sentUserIds: string[] = [];
      const failedUserIds: string[] = [];

      // Keep requests sequential so a first-run selection cannot burst the
      // connections endpoint. Each request is independently recoverable.
      for (const userId of [...new Set(userIds)]) {
        try {
          await ConnectionsService.sendRequest({
            idToken,
            addresseeUserId: userId,
            message: "I would like to add you to my private Location circle.",
          });
          sentUserIds.push(userId);
        } catch {
          failedUserIds.push(userId);
        }
      }

      if (sentUserIds.length > 0) {
        const sentSet = new Set(sentUserIds);
        setLocationOnboardingPeople((current) =>
          current.map((person) =>
            sentSet.has(person.userId)
              ? { ...person, relationship: "pending_outgoing" }
              : person,
          ),
        );
        CacheSyncService.onConnectionCapabilityMutated(auth.user.uid);
        toast.success(
          `${sentUserIds.length} connection request${sentUserIds.length === 1 ? "" : "s"} sent.`,
        );
      }
      if (failedUserIds.length > 0) {
        toast.error(
          `${failedUserIds.length} request${failedUserIds.length === 1 ? "" : "s"} could not be sent.`,
        );
      }

      return { sentUserIds, failedUserIds };
    },
    [auth.user],
  );

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

  const openLocationSettingsForOnboarding = useCallback(async () => {
    locationOnboardingRetryOnResumeRef.current = true;
    await OneLocationService.openLocationSettings().catch(() => null);
    // On web the app can't open device settings; guide the user to the browser's
    // own site-permission UI instead of a nonexistent "phone Location" switch.
    toast.info(
      isWeb()
        ? "Allow location in your browser's site settings (lock icon in the address bar), then try again."
        : "Turn on phone Location, then return to continue.",
    );
    window.setTimeout(() => void refreshLocationPermission(), 1200);
  }, [refreshLocationPermission]);

  const openAppSettingsForOnboarding = useCallback(async () => {
    locationOnboardingRetryOnResumeRef.current = true;
    await OneLocationService.openAppSettings().catch(() => null);
    toast.info(
      isWeb()
        ? "Allow location for this site in your browser settings, then try again."
        : "Allow Location for One in Settings, then return.",
    );
    window.setTimeout(() => void refreshLocationPermission(), 1200);
  }, [refreshLocationPermission]);

  // The "Save this place" step must appear on EVERY Location onboarding run once
  // access is ready — even if the owner discarded a previous onboarding or has
  // already saved a place. We only guard against double-firing within a single
  // mounted journey (savedLocationPromptedRef) and against concurrent captures
  // (savedLocationPromptInFlightRef). The legacy "skipped"/existing-location
  // suppression is deliberately retired: those localStorage markers are now only
  // cleared, never read to hide the prompt, so a prior skip can never permanently
  // suppress it.
  const promptSaveLocationDuringOnboarding =
    useCallback((): Promise<boolean> => {
      if (savedLocationSessionUserId !== auth.userId) {
        return Promise.resolve(false);
      }
      if (savedLocationPromptedRef.current) return Promise.resolve(true);
      if (savedLocationPromptInFlightRef.current) {
        return savedLocationPromptInFlightRef.current;
      }
      // Root setup intentionally has no vault yet. Capture the owner-confirmed
      // point now, then stage it in process memory until Finish setup.
      if (!auth.userId) return Promise.resolve(false);

      const userId = auth.userId;
      const sessionEpoch = savedLocationSessionEpochRef.current;
      const sessionIsCurrent = () =>
        savedLocationSessionEpochRef.current === sessionEpoch &&
        savedLocationSessionUserId === userId;
      const legacyKey = savedLocationPromptKey(
        SAVED_LOCATION_PROMPT_LEGACY_KEY_PREFIX,
        userId,
      );
      const outcomeKey = savedLocationPromptKey(
        SAVED_LOCATION_PROMPT_OUTCOME_KEY_PREFIX,
        userId,
      );
      let attempt: Promise<boolean>;
      attempt = (async (): Promise<boolean> => {
        // Retire any legacy suppression markers so the prompt keeps appearing on
        // every onboarding, regardless of a previous skip or existing places.
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(legacyKey);
            window.localStorage.removeItem(outcomeKey);
          } catch {
            // Encrypted PKM remains the saved-state authority.
          }
        }

        let point: PlainLocationPoint;

        try {
          point = await OneLocationService.captureCurrentPosition();
        } catch {
          if (!sessionIsCurrent()) return false;
          toast.error(
            "We could not read your current location. Check permission and try again.",
          );
          return false;
        }

        if (!sessionIsCurrent()) return false;

        savedLocationPromptedRef.current = true;
        savedLocationPointUserIdRef.current = userId;
        const addressResolutionId =
          savedLocationAddressResolutionIdRef.current + 1;
        savedLocationAddressResolutionIdRef.current = addressResolutionId;
        setSaveLocationPoint(point);
        setSaveLocationAddress(null);
        setSaveLocationAddressLoading(true);
        setSaveLocationModalOpen(true);

        // Resolve friendly copy while the modal remains usable. Exact
        // coordinates are never rendered or written to browser storage.
        if (!vaultOwnerToken) {
          // The map picker has a browser-side reverse-geocode fallback. Do not
          // invent vault authority during root setup just to resolve display
          // copy; the selected point stays process-memory-only until Finish.
          setSaveLocationAddressLoading(false);
          return true;
        }
        void OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat: point.latitude,
          lng: point.longitude,
        })
          .then((place) => {
            if (
              !sessionIsCurrent() ||
              savedLocationAddressResolutionIdRef.current !==
                addressResolutionId
            ) {
              return;
            }
            setSaveLocationAddress(
              place.formattedAddress || place.name || null,
            );
          })
          .catch(() => {
            if (
              !sessionIsCurrent() ||
              savedLocationAddressResolutionIdRef.current !==
                addressResolutionId
            ) {
              return;
            }
            setSaveLocationAddress(null);
          })
          .finally(() => {
            if (
              sessionIsCurrent() &&
              savedLocationAddressResolutionIdRef.current ===
                addressResolutionId
            ) {
              setSaveLocationAddressLoading(false);
            }
          });
        return true;
      })().finally(() => {
        if (savedLocationPromptInFlightRef.current === attempt) {
          savedLocationPromptInFlightRef.current = null;
        }
      });

      savedLocationPromptInFlightRef.current = attempt;
      return attempt;
    }, [auth.userId, savedLocationSessionUserId, vaultOwnerToken]);

  const handleSaveOnboardingLocation = useCallback(
    async (
      category: SavedLocationCategory,
      label: string,
      details?: SavedLocationAddressDetails,
    ) => {
      if (
        !auth.userId ||
        savedLocationSessionUserId !== auth.userId ||
        savedLocationPointUserIdRef.current !== auth.userId ||
        !saveLocationPoint
      ) {
        toast.error("Choose a location before continuing.");
        return;
      }
      const savingUserId = auth.userId;
      const sessionEpoch = savedLocationSessionEpochRef.current;
      setSaveLocationSaving(true);
      try {
        const input = {
          category,
          label,
          latitude: saveLocationPoint.latitude,
          longitude: saveLocationPoint.longitude,
          address: details
            ? buildSavedLocationAddress(saveLocationAddress, details)
            : saveLocationAddress,
        };
        const canPersistNow = Boolean(vaultKey && vaultOwnerToken);
        if (vaultKey && vaultOwnerToken) {
          await addSavedLocation({
            context: {
              userId: auth.userId,
              vaultKey,
              vaultOwnerToken,
            },
            input,
          });
        } else {
          // Root onboarding deliberately precedes vault creation. Keep the
          // owner-confirmed point and entrance details only in process memory;
          // existing Finish setup transaction commits it after vault unlock.
          PreVaultSensitiveDraftService.stageSavedLocation(auth.userId, input);
        }
        if (
          savedLocationSessionEpochRef.current !== sessionEpoch ||
          savedLocationSessionUserId !== savingUserId
        ) {
          return;
        }
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(
              savedLocationPromptKey(
                SAVED_LOCATION_PROMPT_LEGACY_KEY_PREFIX,
                auth.userId,
              ),
            );
            window.localStorage.removeItem(
              savedLocationPromptKey(
                SAVED_LOCATION_PROMPT_OUTCOME_KEY_PREFIX,
                auth.userId,
              ),
            );
          } catch {
            // Encrypted PKM remains the saved-state authority.
          }
        }
        savedLocationAddressResolutionIdRef.current += 1;
        setSaveLocationModalOpen(false);
        setSaveLocationPoint(null);
        setSaveLocationAddress(null);
        savedLocationPointUserIdRef.current = null;
        toast.success(
          canPersistNow
            ? "Location saved securely."
            : "Location ready. One will save it after your private vault is set up.",
        );
      } catch (error) {
        if (
          savedLocationSessionEpochRef.current !== sessionEpoch ||
          savedLocationSessionUserId !== savingUserId
        ) {
          return;
        }
        toast.error(
          error instanceof DuplicateSavedLocationError
            ? error.message
            : "Could not save this location. Please try again.",
        );
      } finally {
        if (
          savedLocationSessionEpochRef.current === sessionEpoch &&
          savedLocationSessionUserId === savingUserId
        ) {
          setSaveLocationSaving(false);
        }
      }
    },
    [
      auth.userId,
      savedLocationSessionUserId,
      saveLocationAddress,
      saveLocationPoint,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  const handleSkipSaveOnboardingLocation = useCallback(() => {
    if (auth.userId) {
      PreVaultSensitiveDraftService.clearSavedLocation(auth.userId);
    }
    if (typeof window !== "undefined" && auth.userId) {
      try {
        window.localStorage.removeItem(
          savedLocationPromptKey(
            SAVED_LOCATION_PROMPT_LEGACY_KEY_PREFIX,
            auth.userId,
          ),
        );
        window.localStorage.setItem(
          savedLocationPromptKey(
            SAVED_LOCATION_PROMPT_OUTCOME_KEY_PREFIX,
            auth.userId,
          ),
          "skipped",
        );
      } catch {
        // best-effort
      }
    }
    savedLocationAddressResolutionIdRef.current += 1;
    setSaveLocationModalOpen(false);
    setSaveLocationPoint(null);
    setSaveLocationAddress(null);
    setSaveLocationAddressLoading(false);
    savedLocationPointUserIdRef.current = null;
  }, [auth.userId]);

  const searchOnboardingSavedPlaces = useCallback(
    async (input: string) => {
      if (!vaultOwnerToken) {
        throw new Error("Vault owner token required.");
      }
      return OneLocationService.placesAutocomplete({
        vaultOwnerToken,
        input,
      });
    },
    [vaultOwnerToken],
  );

  const selectOnboardingSavedPlace = useCallback(
    async (placeId: string) => {
      if (
        !auth.userId ||
        savedLocationSessionUserId !== auth.userId ||
        savedLocationPointUserIdRef.current !== auth.userId ||
        !vaultOwnerToken ||
        !saveLocationPoint
      ) {
        throw new Error("Capture a location before changing the place.");
      }
      const sessionEpoch = savedLocationSessionEpochRef.current;
      const place = await OneLocationService.placeDetails({
        vaultOwnerToken,
        placeId,
      });
      if (
        savedLocationSessionEpochRef.current !== sessionEpoch ||
        savedLocationPointUserIdRef.current !== auth.userId
      ) {
        throw new Error("The location session changed. Try again.");
      }
      if (
        !Number.isFinite(place.latitude) ||
        !Number.isFinite(place.longitude) ||
        place.latitude < -90 ||
        place.latitude > 90 ||
        place.longitude < -180 ||
        place.longitude > 180
      ) {
        throw new Error("The selected place did not return valid coordinates.");
      }
      const label = place.label.trim();
      if (!label) {
        throw new Error("The selected place did not return an address.");
      }
      savedLocationAddressResolutionIdRef.current += 1;
      setSaveLocationPoint({
        ...saveLocationPoint,
        latitude: place.latitude,
        longitude: place.longitude,
        accuracyM: null,
        capturedAt: new Date().toISOString(),
      });
      setSaveLocationAddress(label);
      setSaveLocationAddressLoading(false);
    },
    [
      auth.userId,
      saveLocationPoint,
      savedLocationSessionUserId,
      vaultOwnerToken,
    ],
  );

  // Drag-to-pin confirm replaces the coarse device fix with the map centre the
  // owner explicitly confirmed for this auth session.
  const handlePickExactSavedLocation = useCallback(
    (picked: PickedLocation) => {
      if (
        !auth.userId ||
        savedLocationSessionUserId !== auth.userId ||
        savedLocationPointUserIdRef.current !== auth.userId
      ) {
        return;
      }
      setSaveLocationPoint((current) => ({
        latitude: picked.latitude,
        longitude: picked.longitude,
        accuracyM: null,
        capturedAt: new Date().toISOString(),
        sourcePlatform: current?.sourcePlatform ?? "web",
      }));
      savedLocationAddressResolutionIdRef.current += 1;
      setSaveLocationAddress(picked.address);
      setSaveLocationAddressLoading(false);
    },
    [auth.userId, savedLocationSessionUserId],
  );

  const acceptSavedLocationMapRenderer = useCallback(async () => {
    // Root setup has no vault yet, so its acceptance intentionally lasts only
    // for this open modal. Once vault authority exists, reuse the canonical
    // durable renderer-consent preference used by Your Map.
    if (!vaultOwnerToken) return;
    const next = await OneLocationService.updateMapPreferences({
      vaultOwnerToken,
      rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
    });
    setSavedLocationRendererAccepted(
      next.rendererConsentVersion === GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
    );
  }, [vaultOwnerToken]);

  // "Locate me" inside the map picker — re-center on a fresh GPS fix.
  const locateMeForSavedLocation = useCallback(async () => {
    if (
      !auth.userId ||
      savedLocationSessionUserId !== auth.userId ||
      savedLocationPointUserIdRef.current !== auth.userId
    ) {
      return null;
    }
    const sessionEpoch = savedLocationSessionEpochRef.current;
    try {
      const point = await OneLocationService.captureCurrentPosition();
      if (
        savedLocationSessionEpochRef.current !== sessionEpoch ||
        savedLocationPointUserIdRef.current !== auth.userId
      ) {
        return null;
      }
      return { latitude: point.latitude, longitude: point.longitude };
    } catch {
      return null;
    }
  }, [auth.userId, savedLocationSessionUserId]);

  // Reverse-geocode wrapper the map picker calls on every settle.
  const reverseGeocodeForSavedLocation = useCallback(
    async (lat: number, lng: number): Promise<string | null> => {
      if (!vaultOwnerToken) return null;
      try {
        const place = await OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat,
          lng,
        });
        return place.formattedAddress || place.name || null;
      } catch {
        return null;
      }
    },
    [vaultOwnerToken],
  );

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
        if (isLocationServicesDisabled(refreshedPermission)) {
          await openLocationSettingsForOnboarding();
          return;
        }
        if (
          refreshedPermission?.state === "denied" ||
          refreshedPermission?.state === "restricted"
        ) {
          await openAppSettingsForOnboarding();
          return;
        }
        toast.success("Location access is on.");
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
      toast.success("Location access enabled.");
    } catch (error) {
      toast.error(locationServicesErrorMessage(error));
    } finally {
      setLocationOnboardingBusy(false);
    }
  }, [
    locationOnboardingBusy,
    openAppSettingsForOnboarding,
    openLocationSettingsForOnboarding,
    permission,
    refreshLocationPermission,
  ]);

  useEffect(() => {
    const refreshIfPending = () => {
      if (!locationOnboardingRetryOnResumeRef.current) return;
      locationOnboardingRetryOnResumeRef.current = false;
      void refreshLocationPermission();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") return;
      refreshIfPending();
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const removeLifecycleListener =
      appInteractionCoordinator.subscribeLifecycle(() => {
        if (
          appInteractionCoordinator.getLifecycleSnapshot().state === "active"
        ) {
          refreshIfPending();
        }
      });

    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      removeLifecycleListener();
    };
  }, [refreshLocationPermission]);

  useEffect(() => {
    if (!notificationOnboardingAttemptRef.current) return;
    if (isRetryingPushRegistration) {
      notificationOnboardingObservedBusyRef.current = true;
      return;
    }
    if (!notificationOnboardingObservedBusyRef.current) return;

    notificationOnboardingAttemptRef.current = false;
    notificationOnboardingObservedBusyRef.current = false;
    if (notificationDeliveryMode === "push_active") {
      toast.success("Notifications enabled.");
      return;
    }
    if (notificationDeliveryMode === "push_blocked") {
      toast.error(
        "Notifications are still blocked. Allow them in Settings and try again.",
      );
      return;
    }
    toast.info(
      "Push notifications could not be enabled. Updates will still appear in One.",
    );
  }, [isRetryingPushRegistration, notificationDeliveryMode]);

  useEffect(() => {
    const retryAfterSettings = () => {
      if (
        !notificationOnboardingRetryOnFocusRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      notificationOnboardingRetryOnFocusRef.current = false;
      notificationOnboardingAttemptRef.current = true;
      notificationOnboardingObservedBusyRef.current = false;
      retryPushRegistration();
    };

    window.addEventListener("focus", retryAfterSettings);
    document.addEventListener("visibilitychange", retryAfterSettings);
    return () => {
      window.removeEventListener("focus", retryAfterSettings);
      document.removeEventListener("visibilitychange", retryAfterSettings);
    };
  }, [retryPushRegistration]);

  const handleLocationOnboardingNotifications = useCallback(async () => {
    if (notificationDeliveryMode === "push_active") {
      toast.success("Notifications are on.");
      return;
    }
    if (notificationDeliveryMode === "push_blocked") {
      notificationOnboardingRetryOnFocusRef.current = true;
      const result = await OneLocationService.openAppSettings().catch(() => ({
        opened: false,
        sourcePlatform: "web" as const,
      }));
      if (!result.opened) {
        notificationOnboardingRetryOnFocusRef.current = false;
      }
      toast.info(
        result.opened
          ? "Allow notifications in Settings, then return to One."
          : "Allow notifications in your browser or device settings, then try again.",
      );
      return;
    }

    notificationOnboardingAttemptRef.current = true;
    notificationOnboardingObservedBusyRef.current = false;
    retryPushRegistration();
  }, [notificationDeliveryMode, retryPushRegistration]);

  const nativeTestConfig: OneLocationNativeTestConfig = {
    routeId:
      surface === "map"
        ? "/one/location/map"
        : mode === "setup"
          ? "/one/setup/location"
          : "/one/location",
    marker:
      surface === "map"
        ? "native-route-one-location-map"
        : mode === "setup"
          ? "native-route-one-setup-location"
          : "native-route-one-location",
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
    (mode === "setup" || !loadError) &&
    Boolean(auth.userId && (mode === "setup" || vaultOwnerToken));

  if (showLocationOnboarding) {
    // Render the full-screen onboarding takeover through a portal to
    // document.body. The page content is mounted INSIDE the app shell's scroll
    // root (a `position: relative; z-10` stacking context in providers.tsx),
    // which traps any descendant's z-index — so the overlay's `z-[540]` only
    // competed *within* that context, while the global agent bar (z-[118]) and
    // bottom nav (z-[120]/[505]) live in the shell's root context and painted
    // OVER the onboarding footer, hiding the "Continue" button behind the
    // "Ask your agent anything" bar. Portaling to <body> lifts the overlay into
    // the document root so its z-index wins over all app chrome and the
    // Continue / Allow Location button is always tappable.
    return (
      <BodyPortal>
        <OneLocationOnboardingExperience
          key={auth.userId}
          startAt={locationOnboardingStep}
          currentUserName={
            String(
              auth.user?.displayName || auth.user?.email || "You",
            ).trim() || "You"
          }
          currentUserPhotoUrl={auth.user?.photoURL}
          people={locationOnboardingPeople}
          connections={locationOnboardingConnections}
          peopleLoading={locationOnboardingPeopleLoading}
          peopleError={locationOnboardingPeopleError}
          locationPermission={permission}
          notificationDeliveryMode={notificationDeliveryMode}
          notificationBusy={isRetryingPushRegistration}
          locationBusy={locationOnboardingBusy}
          nativeTest={nativeTestConfig}
          onRetryPeople={() =>
            setLocationOnboardingPeopleRefresh((current) => current + 1)
          }
          onSendConnectionRequests={
            handleSendLocationOnboardingConnectionRequests
          }
          onRequestLocation={handleLocationOnboardingPermission}
          // Every onboarding run opens the pin-and-address flow once Location
          // is ready. Root setup stages the confirmed draft in memory; an
          // unlocked workspace persists it immediately.
          onLocationReady={promptSaveLocationDuringOnboarding}
          onRequestNotifications={handleLocationOnboardingNotifications}
          onBack={() => router.back()}
          onComplete={dismissLocationOnboarding}
          onSkip={skipLocationOnboarding}
          requireLocationToComplete={mode === "setup"}
        />
        <SaveLocationModal
          key={`saved-location-${auth.userId}`}
          open={
            saveLocationModalOpen && savedLocationSessionUserId === auth.userId
          }
          address={saveLocationAddress}
          loadingAddress={saveLocationAddressLoading}
          saving={saveLocationSaving}
          onSearchPlaces={
            vaultOwnerToken ? searchOnboardingSavedPlaces : undefined
          }
          onSelectPlace={
            vaultOwnerToken ? selectOnboardingSavedPlace : undefined
          }
          mapInitial={
            saveLocationPoint
              ? {
                  latitude: saveLocationPoint.latitude,
                  longitude: saveLocationPoint.longitude,
                }
              : null
          }
          reverseGeocode={
            vaultOwnerToken ? reverseGeocodeForSavedLocation : undefined
          }
          onLocateMe={locateMeForSavedLocation}
          onPickExactLocation={handlePickExactSavedLocation}
          startWithMapPicker
          collectAddressDetails
          deferredUntilVault={!vaultKey || !vaultOwnerToken}
          initialAccuracyM={saveLocationPoint?.accuracyM}
          rendererDisclosureAccepted={savedLocationRendererAccepted}
          onAcceptRendererDisclosure={acceptSavedLocationMapRenderer}
          onSave={(category, label, details) =>
            void handleSaveOnboardingLocation(category, label, details)
          }
          onSkip={handleSkipSaveOnboardingLocation}
        />
      </BodyPortal>
    );
  }

  // ---------------------------------------------------------------------------
  // Mobile-first redesign (Figma: one_location_final_fixed_clean_navigation).
  // PRESENTATION ONLY: the view-model below wires the redesigned hub to the
  // EXACT existing state + handlers, so consent gating, crypto, analytics, and
  // routing are unchanged. The full original UI remains intact below and is
  // used for the loading/error states (and as a guaranteed fallback). The
  // global app footer is never touched. (USE_LOCATION_REDESIGN is defined at
  // module scope so notification/deep-link handlers above can branch on it.)
  // ---------------------------------------------------------------------------

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
    locationEnabled,
    autoShareEnabled: locationControl.autoShareEnabled,
    locationPaused: locationControl.paused,
    locationAccuracyLimited,
    myLocationPoint,
    myLocationError,
    recipients: rankedRecipients,
    visibleRecipients,
    visibleShareRecipients,
    activeOwnerGrants,
    // Received grants stay reachable in their focused detail view. Dismissing
    // a preview never mutates the durable grant or its revocation state.
    receivedGrants: activeReceivedGrants,
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
    shareRecipientSearch,
    selectedRecipientIds,
    selectedRequestOwnerIds,
    shareDurationHours,
    shareMessage,
    durationHours,
    requestMessage,
    shareReviewOpen,
    publicInviteUrl,
    circleInviteUrl,
    setRecipientSearch,
    setShareRecipientSearch,
    setShareDurationHours,
    setShareMessage,
    setDurationHours,
    setRequestMessage,
    setShareReviewOpen,
    resetShareComposer,
    startShareComposer,
    toggleShareRecipient: (id) => toggleShareRecipient(id, "section_list"),
    toggleRequestOwner: (id) => toggleRequestOwner(id, "section_list"),
    onShowMyLocation: () => void handleShowMyLiveLocation(),
    onHideMyLocation: () => void handleHideMyLiveLocation(),
    onResumeMyLocation: handleResumeMyLocation,
    onAutoShareChange: handleAutoShareChange,
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
    renderMapPreview: (point, showNavigation, viewportResetKey) => (
      <LocalMapPreview
        point={point}
        showNavigation={showNavigation}
        viewportResetKey={`${mapViewportResetKey}:${viewportResetKey ?? "default"}`}
      />
    ),
    mapLocationHref: googleMapsLocationUrl,
    decryptedPoints,
    sosRecipients: sosActionRecipients,
    smsRecipients: smsActionRecipients,
    smsContactCandidates: sosActionRecipients,
    smsContactUserIds,
    sosActive: Boolean(sosIncident?.grantIds.length),
    sosBusy: busy === "sos",
    sosStartedAtLabel: sosIncident
      ? formatDateTime(sosIncident.startedAt)
      : null,
    sosEmergency,
    sosEmergencyStatus,
    onResolveSosLocation: resolveSosLocation,
    onTriggerSos: handleTriggerSos,
    onStopSos: handleStopSos,
    onAddSmsContact: (recipientUserId) =>
      void handleAddSmsContact(recipientUserId),
    onRemoveSmsContact: handleRemoveSmsContact,
    onCheckIn: handleCheckIn,
    onDiscardPrivateCheckInOperation: discardPrivateCheckInOperation,
  };

  // The mobile-first redesign hub is the ONLY customer-facing UI. It renders in
  // every state — success, loading, AND error — so a load failure (e.g. the
  // vault-owner token is missing, or a backend/schema hiccup) surfaces as a
  // small inline banner on the current design, and NEVER drops the user back to
  // the retired legacy page. The `!loadError` fallthrough was the root cause of
  // the "old location UI reappears on error" bug. The legacy block below is kept
  // only as a compile-time fallback (guarded by the `boolean`-typed flag) and is
  // unreachable at runtime.
  if (USE_LOCATION_REDESIGN) {
    if (surface === "map") {
      return (
        <>
          <NativeTestBeacon {...nativeTestConfig} />
          <LocationImmersiveMap key={auth.userId ?? "anonymous"} />
        </>
      );
    }
    return (
      <AppPageShell
        width="reading"
        className="relative isolate"
        nativeTest={nativeTestConfig}
      >
        <AppPageContentRegion className="min-w-0 space-y-6 overflow-x-hidden">
          {/* Only surface the load-failure banner on a genuine cold load (no
              data yet). Once `state` is populated the hub is fully usable, so a
              transient failure from the 5s background poll must NOT flash a
              scary red alert over working content — the next poll refreshes it
              silently. */}
          {loadError && !state ? (
            <div
              role="alert"
              className="rounded-[20px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-4 text-sm font-medium text-[#ff3b30] dark:text-[#ff9f9a]"
            >
              {loadError}
            </div>
          ) : null}

          {showInitialSkeleton ? (
            <HushhLoader variant="page" label="Loading location..." />
          ) : (
            <LocationRedesignHub vm={locationHubVm} />
          )}
        </AppPageContentRegion>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell width="standard" nativeTest={nativeTestConfig}>
      <CapabilityExploreCard capabilityId="location" />
      <AppPageHeaderRegion className="mx-auto w-full max-w-[720px] min-w-0 overflow-hidden">
        <PageHeader
          eyebrow="Private location sharing"
          title="Your circle, safely connected."
          description="Let the people you trust see where you are only when you choose, only for as long as you choose."
          icon={MapPin}
          accent="success"
          actionsInlineMobile
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy === "load"}
              className="h-9 rounded-full px-3"
            >
              {busy === "load" ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Refresh
            </Button>
          }
        />
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
                <UserRoundCheck
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
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
                          "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]",
                      )}
                    >
                      {locationReadiness.tone === "ready" ? (
                        <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                      ) : locationReadiness.tone === "checking" ? (
                        <Loader2
                          className="h-5 w-5 animate-spin"
                          aria-hidden="true"
                        />
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
                        <ExternalLink
                          className="mr-2 h-4 w-4"
                          aria-hidden="true"
                        />
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
                      className="h-11 w-full shrink-0 rounded-full bg-[color:var(--app-accent)] px-4 text-[14px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
                    >
                      {busy === "selfLocation" ? (
                        <Loader2
                          className="mr-2 h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <LocateFixed
                          className="mr-2 h-4 w-4"
                          aria-hidden="true"
                        />
                      )}
                      {myLocationPoint
                        ? "Refresh location"
                        : "Show my location"}
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
                        viewportResetKey={mapViewportResetKey}
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
                      className="h-10 w-full rounded-[14px] border border-black/[0.04] bg-white pl-10 pr-4 text-[15px] text-[#1c1c1e] shadow-sm outline-none transition-shadow placeholder:text-[#8e8e93] focus:ring-2 focus:ring-[color:var(--app-accent-ring)] dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white"
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
                          <ContactRound
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                          />
                        ) : null}
                        Sync Contacts
                      </ActionButton>
                      <ActionButton
                        busy={busy}
                        busyKey="contactInvite"
                        onClick={() => void handleShareContactInvite()}
                        disabled={!vaultOwnerToken || busy === "contactSync"}
                        variant="outline"
                        className="h-10 w-full min-w-0 rounded-[12px] border-black/[0.06] bg-white text-[13px] font-semibold text-[color:var(--app-accent)] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/10 dark:text-[color:var(--app-accent-deep)] dark:hover:bg-white/15 dark:hover:text-white"
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
                                  <span className="rounded-md bg-[color:var(--app-accent-surface)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[color:var(--app-accent)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-deep)]">
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
                                <CheckCircle2 className="mt-1 h-[22px] w-[22px] shrink-0 text-[color:var(--app-accent)] dark:text-[color:var(--app-accent-deep)]" />
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
                                  className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[#f2f2f7] px-3 text-[12px] font-semibold text-[color:var(--app-accent)] transition-colors hover:bg-[#e5e5ea] hover:text-[#1c1c1e] dark:bg-white/10 dark:text-[color:var(--app-accent-deep)] dark:hover:bg-white/15 dark:hover:text-white"
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
                      className="h-9 w-full rounded-full border-black/[0.06] bg-white text-[13px] font-semibold text-[color:var(--app-accent)] shadow-sm hover:bg-[#f2f2f7] hover:text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/10 dark:text-[color:var(--app-accent-deep)] dark:hover:bg-white/15 dark:hover:text-white"
                    >
                      {showExpandedOneNetworkList ? (
                        <ChevronUp
                          className="mr-2 h-4 w-4"
                          aria-hidden="true"
                        />
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
                                className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[color:var(--app-accent-surface)] px-3 text-[12px] font-semibold text-[color:var(--app-accent-deep)] transition-colors hover:bg-[color:var(--app-accent-surface-strong)] hover:text-[#1c1c1e] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)] dark:hover:bg-[color:var(--app-accent-surface-strong)] dark:hover:text-white"
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
                            need to open Location once before private sharing
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
                            className="min-w-0 max-w-full space-y-3 overflow-hidden rounded-[14px] border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-surface)] p-3 text-[13px] leading-5 text-[color:var(--app-accent-deep)] dark:border-[color:var(--app-accent-border)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]"
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
                            <p className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--app-accent-deep)]/80 dark:text-[color:var(--app-accent-bright)]/80">
                              <ShieldCheck
                                className="h-3.5 w-3.5 shrink-0"
                                aria-hidden="true"
                              />
                              Encrypted end-to-end, auto-stops when the timer
                              ends, and you can stop early anytime.
                            </p>
                            <ActionButton
                              busy={busy}
                              busyKey="share"
                              onClick={() => void handleShare()}
                              disabled={!canShare}
                              className="h-10 w-full min-w-0 rounded-full bg-[color:var(--app-accent)] px-4 text-[13px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)] sm:w-auto"
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
                          className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[color:var(--app-accent-bright)] to-[color:var(--app-accent)] text-[16px] font-semibold text-[color:var(--app-accent-fg)] shadow-[0_4px_14px_var(--app-accent-ring)] hover:opacity-95"
                        >
                          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                          Review Share
                          <span className="sr-only">
                            Share Encrypted Update
                          </span>
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
                                className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-[color:var(--app-accent-surface)] px-3 text-[12px] font-semibold text-[color:var(--app-accent-deep)] transition-colors hover:bg-[color:var(--app-accent-surface-strong)] hover:text-[#1c1c1e] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)] dark:hover:bg-[color:var(--app-accent-surface-strong)] dark:hover:text-white"
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
                          className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[color:var(--app-accent-bright)] to-[color:var(--app-accent)] text-[16px] font-semibold text-[color:var(--app-accent-fg)] shadow-[0_4px_14px_var(--app-accent-ring)] hover:opacity-95"
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
                  className={cn(
                    "min-w-0 max-w-full space-y-2 px-1 outline-none",
                    sectionFocusClassName("people"),
                  )}
                >
                  {sectionLabel("People who can see me")}
                  {activeOwnerGrants.length > 0 ? (
                    <div className="px-1 pb-1">
                      <BackgroundShareToggle
                        enabled={backgroundShareEnabled}
                        onEnabledChange={setBackgroundShareEnabled}
                        requestAlwaysAuthorization={
                          OneLocationService.requestAlwaysAuthorization
                        }
                      />
                    </div>
                  ) : null}
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
                className={cn(
                  "min-w-0 max-w-full space-y-2 px-1 outline-none",
                  sectionFocusClassName("approvals"),
                )}
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
                      <div
                        key={request.id}
                        className="flex min-w-0 max-w-full items-start gap-3 overflow-hidden p-3.5"
                      >
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
                              className="h-9 flex-1 rounded-[12px] bg-[color:var(--app-accent)] font-semibold text-[color:var(--app-accent-fg)] shadow-[0_2px_8px_var(--app-accent-ring)] hover:bg-[color:var(--app-accent-hover)]"
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
                    <div
                      className={cn(
                        oneInsetClassName,
                        "min-w-0 px-3 py-2 text-sm",
                      )}
                    >
                      {circleInviteUrl ? (
                        <span
                          title={circleInviteUrl}
                          aria-label={`Invite to One link ${circleInviteUrl}`}
                          className="block truncate text-[13px] font-medium text-[#1c1c1e] dark:text-white"
                        >
                          {publicInviteUrlPreview(circleInviteUrl)}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            oneSecondaryTextClassName,
                            "block text-[13px] leading-5",
                          )}
                        >
                          Share an Invite to One link. After they sign in,
                          verify phone, and accept it, both of you become One
                          Network connections. Live location sharing still
                          starts only from an explicit Share Location action.
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
                      className="w-full min-w-0 rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)] sm:w-auto"
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
                            Expires{" "}
                            {formatDateTime(latestActiveCircleInvite.expiresAt)}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleRevokeCircleInvite(
                              latestActiveCircleInvite,
                            )
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
                    <div
                      className={cn(
                        oneInsetClassName,
                        "min-w-0 px-3 py-2 text-sm",
                      )}
                    >
                      {publicInviteUrl ? (
                        <span
                          title={publicInviteUrl}
                          aria-label={`Public location link ${publicInviteUrl}`}
                          className="block truncate text-[13px] font-medium text-[#1c1c1e] dark:text-white"
                        >
                          {publicInviteUrlPreview(publicInviteUrl)}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            oneSecondaryTextClassName,
                            "block text-[13px] leading-5",
                          )}
                        >
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
                      className="w-full min-w-0 rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)] sm:w-auto"
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
                            Expires{" "}
                            {formatDateTime(latestActivePublicInvite.expiresAt)}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleRevokePublicInvite(
                              latestActivePublicInvite,
                            )
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
                className={cn(
                  "min-w-0 max-w-full space-y-2 px-1 outline-none",
                  sectionFocusClassName("shared"),
                )}
              >
                {sectionLabel("Shared with me")}
                <div className={oneScrollablePanelClassName}>
                  {visibleReceivedGrants.length ? (
                    visibleReceivedGrants.map((grant, index) => {
                      const point = decryptedPoints[grant.id];
                      const viewError = grantViewErrors[grant.id];
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
                          ) : viewError && grant.status === "active" ? (
                            <div className="px-3.5 pb-3.5">
                              <div className="flex flex-col gap-2.5 rounded-2xl border border-[#ff9f0a]/25 bg-[#ff9f0a]/[0.08] p-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex items-start gap-2">
                                  <AlertTriangle
                                    className="mt-0.5 h-4 w-4 shrink-0 text-[#c77700] dark:text-[#ffb340]"
                                    aria-hidden="true"
                                  />
                                  <p className="min-w-0 break-words text-[12.5px] font-medium leading-snug text-[#8a5a00] [overflow-wrap:anywhere] dark:text-[#ffcf8a]">
                                    {viewError}
                                  </p>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleAskReshare(grant)}
                                  disabled={busy === "request"}
                                  className="w-full shrink-0 rounded-full border-[#ff9f0a]/30 bg-white/70 text-[#8a5a00] hover:bg-white sm:w-auto dark:border-[#ffb340]/25 dark:bg-white/10 dark:text-[#ffcf8a] dark:hover:bg-white/15"
                                >
                                  {busy === "request" ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Send
                                      className="mr-2 h-4 w-4"
                                      aria-hidden="true"
                                    />
                                  )}
                                  Ask to share again
                                </Button>
                              </div>
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
                  className={cn(
                    "min-w-0 max-w-full space-y-2 px-1 outline-none",
                    sectionFocusClassName("public_responses"),
                  )}
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
                  className={cn(
                    "min-w-0 max-w-full space-y-2 px-1 outline-none",
                    sectionFocusClassName("my_requests"),
                  )}
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

export default function OneLocationAgentPage({
  mode = "workspace",
  surface = "hub",
  onSetupReadinessChange,
  onSetupComplete,
  onSetupSkip,
}: OneLocationAgentPageProps = {}) {
  return (
    <OneLocationAgentPageContent
      mode={mode}
      surface={surface}
      onSetupReadinessChange={onSetupReadinessChange}
      onSetupComplete={onSetupComplete}
      onSetupSkip={onSetupSkip}
    />
  );
}

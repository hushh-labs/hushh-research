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
  type OnboardingCircleInvite,
  type OnboardingContactSyncResult,
} from "@/components/one-location/onboarding/one-location-onboarding-flow";

import { SaveLocationModal } from "@/components/one-location/onboarding/save-location-modal";
import type { PickedLocation } from "@/components/one-location/onboarding/location-picker-map";
import {
  addSavedLocation,
  defaultLabelForCategory,
  DuplicateSavedLocationError,
  loadSavedLocations,
  removeSavedLocation,
  type SavedLocation,
  type SavedLocationCategory,
} from "@/lib/one-location/saved-locations";
import {
  buildSavedLocationAddress,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";

import { useConsentNotificationState } from "@/components/consent/notification-provider";
import {
  useLocalOnboardingActionHandler,
  type LocalOnboardingActionResult,
} from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { VOICE_CONFIRM_DATA_KEY } from "@/lib/voice/voice-action-card";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

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

import { HushhContacts } from "@/lib/capacitor";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import { isWeb } from "@/lib/capacitor/platform";
import { apiErrorCode } from "@/lib/services/api-client";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { LocationBus } from "@/lib/one-location/location-bus";
import {
  isPublishableAge,
  publishPointFrom,
  shouldWarnOnPublishFailure,
} from "@/lib/one-location/live-publish-decision";
import {
  isShareReadyRecipient,
  recipientSelectionFromIds,
  resolveEffectiveShareRecipients,
} from "@/lib/one-location/share-recipient-selection";
import {
  ambiguousMatchNames,
  resolveBySpokenName,
} from "@/lib/one-location/resolve-by-spoken-name";


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
  isSmsTriggeredGrant,
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
import {
  formatLocationDurationLabel,
  locationApproveActionLabel,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import { driveEtaText } from "@/app/one/location/drive-eta";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import {
  LOCATION_BLOCK_MESSAGE,
  LOCATION_COPY,
  type LocationFailure,
  isLocationPermissionDeniedError,
  isUsableFixAge,
  locationBlockReason,
  locationReadiness as resolveLocationReadiness,
  shouldSurfaceLocationError,
} from "@/lib/one-location/location-readiness";
import {
  GRANT_EDIT_DURATION_FALLBACK,
  defaultEditDurationHours,
  grantDurationEditIntent,
  grantRemainingHours,
} from "@/lib/one-location/grant-duration-edit";
import { snapToWheelDurationHours } from "@/components/one-location/redesign/duration-wheel-picker";
import { OneLocationService } from "@/lib/one-location/service";
import {
  describeContactSyncOutcome,
  openContactPermissionSettings,
  syncOneLocationContactSignals,
  OneLocationContactSyncError,
  type OneLocationContactSignalResult,
} from "@/lib/one-location/contact-signals";
import { OneLocationActivityDashboard } from "@/components/one-location/activity-dashboard";
import {
  LocationRedesignHub,
  ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS,
  type GrantViewStatus,
  type LocationHubViewModel,
  type PrivateCheckInRequest,
  type PrivateCheckInResult,
} from "@/components/one-location/redesign/location-redesign-hub";
import {
  SHARE_DURATION_LADDER,
  SHARE_DURATION_UNTIL_STOP_VALUE,
} from "@/components/one-location/redesign/duration-presets";
import { LocationImmersiveMap } from "@/components/one-location/location-immersive-map";
import { buildOneLocationActivityFallback } from "@/lib/one-location/activity";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { buildOneLocationRequestMessage } from "@/lib/one-location/request-message";
import {
  clearLocationWorkspaceMemory,
  readLocationWorkspaceMemory,
  samePlainLocationPoint,
  writeLocationWorkspaceMemory,
  type LocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import { updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import {
  isOneLocationNearbyCheckInAvailable,
  ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS,
} from "@/lib/one-location/nearby-check-in-availability";
import { resolveOnboardingMapPoint } from "@/lib/one-location/onboarding-map-point";

import {
  clearLiveShareEntries,
  liveShareEntriesEqual,
  loadLiveShareEntries,
  pruneLiveShareEntries,
  reconcileLiveShareEntries,
  saveLiveShareEntries,
  summarizeLiveShareEntries,
  type LiveShareSessionEntry,
} from "@/lib/one-location/live-share-session";
import {
  LiveShareStatusCard,
  type LiveShareStatus,
} from "@/components/one-location/redesign/live-share-status-card";
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
  isCachedEmergencyInfoUsableAt,
  isWithinEmergencyTrustRadius,
  readCachedEmergencyInfo,
  writeCachedEmergencyInfo,
  EMERGENCY_LOOKUP_TIMEOUT_MS,
  type EmergencyInfo,
  type EmergencyNumberLookupStatus,
} from "@/lib/one-location/emergency-numbers";
import {
  buildCircleJoinUrl,
  resolveCircleJoinOrigin,
} from "@/lib/one-location/circle-join-url";
import type {
  DriveDestination,
  DriveSharePayload,
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationCircleInvite,
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecommendationReason,
  OneLocationRecipient,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { filterPeopleByQuery } from "@/lib/one-location/people-search";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  isCircleSelectionFullySelected,
  mergeRecipientsByUserId,
  resolveCircleRecipientSelection,
  type CircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import {
  addRecentDestination,
  loadRecentDestinations,
} from "@/lib/one-location/drive-recents";
import { CacheService } from "@/lib/services/cache-service";
import {
  loadPersistedDriveSession,
  restoreDriveSession,
  saveDriveSession,
} from "@/lib/one-location/drive-session-store";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ConnectionsService } from "@/lib/services/connections-service";
import {
  clearPendingCircleJoin,
  readPendingCircleJoin,
  rememberPendingCircleJoin,
} from "@/lib/one-location/pending-circle-join";
import {
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { toDurationBucket, trackEvent } from "@/lib/observability/client";
import {
  trackLocationShareConfirmed,
  trackLocationShareReceived,
} from "@/lib/observability/location-events";
import {
  rememberLocationInviteSource,
  trackLocationFunnelStepCompleted,
} from "@/lib/observability/growth";
import { useVault } from "@/lib/vault/vault-context";
import { cn } from "@/lib/utils";
import { LiveMap } from "@/components/one-location/live-map";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";
import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";
import { locationPreviewFreshness } from "@/lib/one-location/freshness";
import { selectAutoApprovableRequests } from "@/lib/one-location/auto-approve-requests";
import { shouldStreamSelfPreview } from "@/lib/one-location/self-preview";
import {
  DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS,
  DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS,
} from "@/lib/one-location/eta-recompute";
import { getApiBaseUrl } from "@/lib/services/api-service";
import { copyToClipboard } from "@/lib/utils/clipboard";
import {
  buildCircleInviteShareText,
  circleShareLabel,
  isShareCancellationError,
  shareNamedCircleCode,
} from "@/lib/one-location/share-circle-code";

const DURATION_OPTIONS = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

/**
 * Mirrors SHARE_DURATION_LADDER in components/one-location/redesign/
 * duration-presets.tsx. "Today" is gone: `Number("today")` is NaN, so the
 * picker resolved that token to 15 minutes and wrote "0.25" back over it.
 */
/**
 * What One will accept when someone says "share my location for ...".
 *
 * The ladder plus the two lengths the ladder does not show but the picker can
 * still reach through Custom, so a spoken "half an hour" or "a full day" is
 * not refused for being off the grid.
 */
const SHARE_VOICE_DURATION_VALUES = new Set<string>([
  ...SHARE_DURATION_LADDER.map((rung) => rung.value),
  SHARE_DURATION_UNTIL_STOP_VALUE,
  "0.5",
  "24",
]);

const PRIVATE_SHARE_DURATION_LABELS: Record<string, string> = {
  "0.25": "15 min",
  "1": "1 hour",
  "2": "2 hours",
  "4": "4 hours",
  "8": "8 hours",
  until_stopped: "Until I stop",
};

// A spoken-safe version of PRIVATE_SHARE_DURATION_LABELS -- covers every
// value SHARE_VOICE_DURATION_VALUES actually accepts ("0.5" and "24" are not
// in that map, since it backs a different, UI-only label) and reads as a
// sentence fragment ("30 minutes") rather than a compact chip ("30 min").
function shareVoiceDurationSpokenLabel(value: string): string {
  if (value === SHARE_DURATION_UNTIL_STOP_VALUE) return "until you stop it";
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return value;
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * How many recipients a single share fans out to concurrently.
 *
 * Sharing is per-recipient independent, so this is pure wall-clock win — but
 * each grant costs TWO pooled database connections server-side (the writer
 * guard holds one while the row insert opens another). Four keeps a large
 * Circle share close to one round trip without threatening a small pool.
 */
const ONE_LOCATION_SHARE_CONCURRENCY = 4;

const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;

/**
 * How old a fix this heartbeat may reuse without re-reading the device.
 *
 * One tick. The requirement has always been that a recipient watching someone
 * move sees where they are now — `maxAgeMs: 0` was a mechanism chosen for
 * that, and it became the wrong one once a continuous watch existed. This
 * ceiling means a published point is never older than a single period, which
 * is the guarantee the recipient side is already written against: it calls a
 * share stale at three of them.
 */
const LIVE_HEARTBEAT_MAX_AGE_MS = LIVE_LOCATION_UPDATE_INTERVAL_MS;

/**
 * The point this heartbeat may publish, or null to skip the tick.
 *
 * Reads the shared store first, and only asks the device when the store has
 * nothing recent — which, while the movement watch is running, is almost
 * never. Anything not measured this session is refused: `publishPointFrom`
 * rejects a restored fix outright, because the recipient's screen says "live".
 */
async function liveHeartbeatPoint(): Promise<PlainLocationPoint | null> {
  const held = LocationBus.getState();
  if (
    held.snapshotOrigin === "fresh" &&
    isPublishableAge(held.snapshot?.capturedAt, LIVE_HEARTBEAT_MAX_AGE_MS)
  ) {
    return publishPointFrom(held);
  }
  await LocationBus.ensure({ maxAgeMs: LIVE_HEARTBEAT_MAX_AGE_MS });
  return publishPointFrom(LocationBus.getState());
}

// Recipients poll faster than the owner's publish heartbeat so the shared dot
// stays fresh; the LiveMap marker interpolates between these reads.
const LIVE_VIEW_REFRESH_INTERVAL_MS = 5_000;
/**
 * Cadence for a share that is live but has never published a point. There is
 * nothing to stream yet — the owner's first GPS fix hasn't landed — so asking
 * every 5s burns a request per grant per tick for an answer that cannot change
 * until the owner acts. The grant row already carries the authoritative tag
 * (`latestEnvelopeId`), so this path only exists to catch the first publish
 * promptly when no push notification arrives to refresh state.
 */
const AWAITING_FIRST_PUBLISH_POLL_MS = 30_000;
/**
 * Per-grant backoff ceiling after consecutive failed reads. One share that is
 * genuinely broken (pruned envelope, rotated key, backend degraded) must never
 * keep hitting the backend at the live cadence — and must never slow down the
 * healthy shares next to it, which is why backoff is tracked per grant.
 */
const LIVE_VIEW_BACKOFF_MAX_MS = 60_000;
/**
 * A sweep that never settles (hung fetch, throttled tab resumed mid-flight)
 * would leave the in-flight guard latched and silently kill live tracking for
 * the rest of the session. Past this age the guard is treated as stale and the
 * next tick proceeds, so the poll can always recover itself.
 */
const LIVE_VIEW_INFLIGHT_WATCHDOG_MS = 30_000;
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

/**
 * How the hub's own URL params read back to a person.
 *
 * The redesign addresses every tab as `?view=` and every focused flow as
 * `?action=`, which is also how the voice action contract reaches them. These
 * tables are the words for those values, so the surface One is told about and
 * the surface on screen stay the same surface.
 */
const LOCATION_HUB_TAB_LABELS: Readonly<Record<string, string>> = {
  now: "Overview",
  people: "People",
  links: "Links",
};

const LOCATION_TAB_MODULES: Readonly<Record<string, string[]>> = {
  now: ["Sharing status", "Active shares", "Shared with me", "Quick actions"],
  people: ["Circles", "Connections"],
  links: ["Temporary links"],
};

/**
 * Exported for the contract-parity test, not for reuse.
 *
 * This map is load-bearing for voice in a way nothing about it advertises. A
 * `?action=` flow's label becomes `visibleModules`, which feeds the relay's
 * `content_key`, which is what makes a route-context note fire when the ROUTE
 * has not changed -- opening a flow on a screen the person is already
 * standing on. `?action=` itself never reaches the relay: `sanitizeRouteQuery`
 * allowlists tab/view/focus/source/category and drops the rest.
 *
 * So a flow with no entry here is invisible to One. That is how voice learns
 * the SOS control was opened, and there is nothing else carrying it.
 */
export const LOCATION_FLOW_LABELS: Readonly<Record<string, string>> = {
  share: "Share location",
  ask: "Ask for someone's location",
  invite: "Invite someone",
  "create-circle": "Create a circle",
  "join-circle": "Join a circle",
  "circle-detail": "Circle detail",
  "temp-link": "Temporary link",
  "check-in": "Check in",
  sos: "Emergency SOS",
  "sms-contacts": "Emergency contacts",
  settings: "Location settings",
  "active-shares": "Active shares",
  "shared-with-me": "Shared with me",
  "needs-review": "Requests to review",
};

/**
 * The Location surface's own inventory, one entry per authored contract action.
 * Every id here exists in `page.voice-action-contract.json`; nothing describes
 * a capability the gateway does not carry.
 */
const LOCATION_VOICE_ACTIONS = [
  // Local handlers FIRST, and the order is load-bearing.
  //
  // Every action on this surface names `one_location`, so they all tie for
  // top rank in `prioritizeAvailableActionIds` and the 10-item cap falls back
  // to the order they appear here. Route actions survive being cut regardless
  // -- the relay admits navigation from any screen whether or not it was
  // submitted -- but a dropped local handler is simply gone, and comes back
  // from the relay as `action_unavailable`, which reads as a broken feature.
  //
  // With 24 actions and 10 slots, listing these last meant the only actions
  // that DO something were the only ones guaranteed to be lost.
  { id: "location.share_selected", actionId: "location.share_selected", label: "Share with the people I picked", purpose: "Start the share with whoever is already selected, for a duration you say." },
  { id: "location.select_share_recipient", actionId: "location.select_share_recipient", label: "Pick someone for the share", purpose: "Select a named connection in the share composer without sending anything." },
  { id: "location.pause_updates", actionId: "location.pause_updates", label: "Pause my location", purpose: "Stop sending location updates from this device." },
  { id: "location.resume_updates", actionId: "location.resume_updates", label: "Resume my location", purpose: "Turn location updates back on for this device." },
  { id: "location.refresh", actionId: "location.refresh", label: "Refresh location", purpose: "Reload location sharing state." },

  { id: "location.open_now", actionId: "location.open_now", label: "Open Location now", purpose: "Show current sharing status and quick actions." },
  { id: "location.open_people", actionId: "location.open_people", label: "Open Location people", purpose: "Show the people and circles you share with." },
  { id: "location.open_links", actionId: "location.open_links", label: "Open Location links", purpose: "Show temporary sharing links." },
  { id: "location.open_share", actionId: "location.open_share", label: "Share my location", purpose: "Open the share composer." },
  { id: "location.open_ask", actionId: "location.open_ask", label: "Ask for someone's location", purpose: "Open the request composer." },
  { id: "location.open_invite", actionId: "location.open_invite", label: "Invite someone to Location", purpose: "Invite someone not on Hushh yet." },
  { id: "location.open_create_circle", actionId: "location.open_create_circle", label: "Create a circle", purpose: "Name a new circle to share with as a group." },
  { id: "location.open_join_circle", actionId: "location.open_join_circle", label: "Join a circle", purpose: "Enter an invite code to join a circle." },
  { id: "location.open_temporary_link", actionId: "location.open_temporary_link", label: "Create a temporary link", purpose: "Make a link that expires." },
  { id: "location.open_check_in", actionId: "location.open_check_in", label: "Check in", purpose: "Send a one-off note of where you are." },
  { id: "location.open_sos", actionId: "location.open_sos", label: "Open emergency SOS", purpose: "Open the emergency alert screen." },
  { id: "location.open_sms_contacts", actionId: "location.open_sms_contacts", label: "Open emergency contacts", purpose: "Choose who receives an SOS text." },
  { id: "location.open_settings", actionId: "location.open_settings", label: "Open Location privacy settings", purpose: "Open privacy and precision controls." },
  { id: "location.open_active_shares", actionId: "location.open_active_shares", label: "Open active location shares", purpose: "See and stop what is live now." },
  { id: "location.open_shared_with_me", actionId: "location.open_shared_with_me", label: "Open locations shared with me", purpose: "See who is sharing with you." },
  { id: "location.open_needs_review", actionId: "location.open_needs_review", label: "Open location requests to review", purpose: "Approve or decline requests." },
  { id: "location.add_connections", actionId: "location.add_connections", label: "Add people to share location with", purpose: "Open Connect to find people." },
  { id: "location.open_map", actionId: "location.open_map", label: "Open the location map", purpose: "Open the full-screen map." },
];

const LOCATION_VOICE_CONTROLS = [
  { id: "one-location-action-share", label: "Share location", purpose: "Open the share composer.", actionId: "location.open_share", role: "button" },
  { id: "one-location-open-map", label: "Your Map", purpose: "Open the full-screen map.", actionId: "location.open_map", role: "button" },
  { id: "one-location-action-active-shares", label: "Active shares", purpose: "See what is live now.", actionId: "location.open_active_shares", role: "button" },
  { id: "one-location-action-shared-with-me", label: "Shared with me", purpose: "See who is sharing with you.", actionId: "location.open_shared_with_me", role: "button" },
  { id: "one-location-action-needs-review", label: "Needs my review", purpose: "Approve or decline requests.", actionId: "location.open_needs_review", role: "button" },
  { id: "one-location-action-settings", label: "Settings", purpose: "Open privacy controls.", actionId: "location.open_settings", role: "button" },
  { id: "one-location-action-check-in", label: "Check-In", purpose: "Send a one-off check in.", actionId: "location.open_check_in", role: "button" },
  { id: "one-location-action-sos", label: "SMS", purpose: "Open emergency SOS.", actionId: "location.open_sos", role: "button" },
  { id: "one-location-action-ask", label: "Request location", purpose: "Ask for location access.", actionId: "location.open_ask", role: "button" },
  { id: "one-location-action-invite", label: "Invite", purpose: "Invite someone to One.", actionId: "location.open_invite", role: "button" },
  { id: "one-location-action-create-circle", label: "Create", purpose: "Create a circle.", actionId: "location.open_create_circle", role: "button" },
  { id: "one-location-action-join-circle", label: "Join with code", purpose: "Join a circle by code.", actionId: "location.open_join_circle", role: "button" },
  { id: "one-location-action-temp-link", label: "Create link", purpose: "Create a temporary link.", actionId: "location.open_temporary_link", role: "button" },
  { id: "one-location-add-connections", label: "Add people", purpose: "Open Connect.", actionId: "location.add_connections", role: "button" },
  { id: "one-location-refresh", label: "Refresh", purpose: "Reload location state.", actionId: "location.refresh", role: "button" },
  // One control, two contract actions: the direction is whichever one the
  // switch is not already in. It is rendered in the header and again in
  // Settings, so both places answer to the same id.
  { id: "one-location-updates-toggle", label: "Location updates", purpose: "Pause or resume location updates from this device.", actionId: "location.pause_updates", role: "switch" },
  { id: "one-location-confirm-share", label: "Start sharing", purpose: "Send the share to the selected people.", actionId: "location.share_selected", role: "button" },
  { id: "one-location-share-recipient-search", label: "Search trusted people", purpose: "Find and select who to share with.", actionId: "location.select_share_recipient", role: "textbox" },
];

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
  | "namedCircle"
  | "circleMemberInvite"
  | `shareCircle:${string}`
  | `sms-contact:${string}`
  | `sms-circle:${string}`
  | null;

type OneLocationSelectionSurface =
  "quick_circle" | "section_list" | "select_menu";

type OneLocationDurationBucket =
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "24h"
  | "until_stopped"
  | "custom";
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
  | "restricted"
  | "denied"
  | "error";

type OneLocationContactSignalState = {
  status: OneLocationContactSignalStatus;
  matchedUserIds: string[];
  matchedCount: number;
  totalContacts: number;
  inviteCandidateCount: number;
  sourcePlatform?: OneLocationContactSignalResult["sourcePlatform"];
  /** Only part of the contact book was readable, so "no matches" is not final. */
  limited?: boolean;
  /** The contact book was larger than the read or lookup caps. */
  truncated?: boolean;
  error?: string | null;
  syncedAt?: string | null;
};

const INITIAL_CONTACT_SIGNAL_STATE: OneLocationContactSignalState = {
  status: "idle",
  matchedUserIds: [],
  matchedCount: 0,
  totalContacts: 0,
  inviteCandidateCount: 0,
  limited: false,
  truncated: false,
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
  if (grant.durationMode === "until_stopped") return "Until stopped";
  return `Expires ${formatDateTime(grant.expiresAt)}`;
}

// Human, at-a-glance countdown to when a share auto-stops (e.g. "Stops in
// 14 min"). This is a key confidence cue: the user can always see that sharing
// is time-boxed and will end on its own. Falls back to the absolute time when
// the window is long, and degrades gracefully if the timestamp is missing.
function expiresCountdownLabel(
  value?: string | null,
  // Injected so every countdown on the screen ticks off one clock. Defaulted
  // for the handful of callers that render once and do not need to move.
  nowMs: number = Date.now(),
): string | null {
  if (!value) return null;
  const expiresAt = new Date(value).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  const diffMs = expiresAt - nowMs;
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

function useShareRecipientSelectionState(): readonly [
  string[],
  (next: SetStateAction<string[]>) => string[],
  MutableRefObject<string[]>,
] {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // React can batch multiple share actions before rerendering. This cursor lets
  // each action compose from the latest queued selection while state remains
  // the rendered source of truth. Exposed (read-only by convention) so a
  // handler that fires immediately after a select -- faster than the render
  // that would otherwise make the pick visible -- can still read who was just
  // chosen instead of the not-yet-committed empty state. See its use in
  // handleShare's effectiveSelectedShareRecipients.
  const latestSelectedIdsRef = useRef<string[]>([]);
  const updateSelectedIds = useCallback(
    (next: SetStateAction<string[]>): string[] => {
      const resolvedIds =
        typeof next === "function" ? next(latestSelectedIdsRef.current) : next;
      latestSelectedIdsRef.current = resolvedIds;
      setSelectedIds(resolvedIds);
      return resolvedIds;
    },
    [],
  );
  return [selectedIds, updateSelectedIds, latestSelectedIdsRef] as const;
}

function peopleCountLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/** Normalize a spoken or stored name: no case, no accents, no punctuation. */
export function normalizeSpokenName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    // Punctuation out so "Mum & Dad" and "Mum and Dad" are not two different
    // circles to a speaker. Unicode classes, not [a-z0-9]: a circle named in
    // Hindi or Arabic must stay matchable rather than normalizing to nothing.
    // \p{M} is load-bearing -- Devanagari vowel signs are marks, not letters,
    // so without it "परिवार" shreds into "पर व र" and never matches itself.
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Resolve a spoken circle name against the circles the person actually has.
 *
 * Tiered on purpose. A plain substring scan would let "family" resolve
 * "Extended family trip" even when a circle literally called "Family" exists,
 * and the person would then be editing the wrong group's membership without
 * ever being told. Exact wins, then a whole-word prefix, and only then a
 * contained match. Ambiguity within a tier is returned as ambiguity rather than
 * being broken arbitrarily by array order.
 */
export function matchCircleByName<T extends { name: string }>(
  circles: readonly T[],
  spoken: string,
): { match: T | null; ambiguous: T[] } {
  const target = normalizeSpokenName(spoken);
  if (!target) return { match: null, ambiguous: [] };
  const indexed = circles.map((circle) => ({
    circle,
    normalized: normalizeSpokenName(circle.name),
  }));

  const tiers = [
    indexed.filter((entry) => entry.normalized === target),
    indexed.filter(
      (entry) =>
        entry.normalized.startsWith(`${target} `) ||
        entry.normalized.endsWith(` ${target}`) ||
        entry.normalized.split(" ").includes(target),
    ),
    indexed.filter((entry) => entry.normalized.includes(target)),
  ];

  for (const tier of tiers) {
    const [only] = tier;
    if (only && tier.length === 1) return { match: only.circle, ambiguous: [] };
    if (tier.length > 1) {
      return { match: null, ambiguous: tier.map((entry) => entry.circle) };
    }
  }
  return { match: null, ambiguous: [] };
}

function oneLocationDurationBucket(value: string): OneLocationDurationBucket {
  switch (value) {
    case "0.25":
      return "15m";
    case "0.5":
      return "30m";
    case "1":
      return "1h";
    case "2":
      return "2h";
    case "4":
      return "4h";
    case "8":
      return "8h";
    case "24":
      return "24h";
    case "until_stopped":
      return "until_stopped";
    default:
      return "custom";
  }
}

/**
 * The invite lanes read one shared `durationHours` string with `Number()`,
 * and that string is written by several screens. Two ways it can be a value
 * they cannot post:
 *
 *   - a non-numeric sentinel ("until_stopped"), which is `NaN` against a
 *     `gt=0` field — a 422 the person sees as an invite that just failed
 *   - a length another lane chose, above this lane's own ceiling
 *
 * Neither is reachable from the invite screens themselves, which is why it
 * went unnoticed: both arrive from whatever the share or request composer
 * left in state.
 */
function inviteDurationHours(value: string, maxHours: number): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return Math.min(1, maxHours);
  return Math.min(maxHours, hours);
}

/** `le=24` on CreateCircleInviteRequest, and the screen offers 1 or 24. */
const CIRCLE_INVITE_MAX_DURATION_HOURS = 24;

/**
 * A public link is readable by anyone who has it, so its ceiling is one hour
 * and the screen says so.
 *
 * The ceiling was defeatable: one `durationHours` string is shared by the
 * public-link lane, the circle-invite lane (which offers 24 hours) and the
 * request composer, so picking 24 on one screen made the next public link
 * post 24 — and the backend accepts it (`le=24`). The UI cap was the only
 * thing enforcing this, and it was not enforcing it.
 */
const PUBLIC_INVITE_MAX_DURATION_HOURS = 1;

function publicInviteDurationHours(value: string): number {
  return inviteDurationHours(value, PUBLIC_INVITE_MAX_DURATION_HOURS);
}

function privateShareDurationPayload(value: string): {
  durationHours?: number;
  durationMode: "timed" | "until_stopped";
} {
  if (value === "until_stopped") {
    return { durationMode: "until_stopped" };
  }
  // No "today" branch: the token cannot reach here any more (the picker has
  // no such rung, and `Number("today")` is NaN so the wheel rewrote it to
  // "0.25" on sight). Anything else is clamped into the window the backend
  // accepts — `gt=0, le=24` — rather than posted and rejected.
  const hours = Number(value);
  return {
    durationHours: Number.isFinite(hours)
      ? Math.min(24, Math.max(0.25, hours))
      : 0.25,
    durationMode: "timed",
  };
}

function privateShareDurationLabel(value: string): string {
  return PRIVATE_SHARE_DURATION_LABELS[value] ?? `${value} hours`;
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

/**
 * Copy for a share that is genuinely live but has no point yet. Shared by the
 * success path (backend answered `awaiting_first_publish`), the legacy 404 path,
 * and the pre-flight skip driven by `grant.latestEnvelopeId`, so all three
 * render byte-identical text — the state setters below compare by value to
 * avoid re-rendering the map on every poll.
 */
function awaitingFirstPublishMessage(grant: OneLocationGrant): string {
  return `${receivedGrantOwnerLabel(
    grant,
  )} is sharing, but hasn't sent a live location update yet. It will appear here automatically as soon as they move or open One.`;
}

/** Outcome of one recipient-side envelope read, used to pace the next poll. */
type OneLocationViewOutcome = "published" | "awaiting" | "error" | "skipped";

type OneLocationGrantPollEntry = {
  /** Epoch ms before which this grant must not be read again. */
  nextAttemptAt: number;
  /** Consecutive failed reads; drives the exponential backoff. */
  failures: number;
};

/**
 * Pace the next recipient-side read of one share, per grant.
 *
 * - `published` — the dot is live and moving, so stay on the tick cadence. Zero
 *   delay keeps the streaming path byte-for-byte as fast as it was.
 * - `awaiting` / `skipped` — healthy share with nothing to send. Asking twelve
 *   times a minute cannot change an answer that only the owner can change, so
 *   drop to the slow heartbeat.
 * - `error` — exponential backoff, capped. Tracked per grant so one broken share
 *   can neither hammer the backend nor slow down the healthy shares beside it.
 */
function recordGrantPollOutcome(
  schedule: Map<string, OneLocationGrantPollEntry>,
  grantId: string,
  outcome: OneLocationViewOutcome,
  now: number,
): OneLocationGrantPollEntry {
  const previousFailures = schedule.get(grantId)?.failures ?? 0;
  const failures = outcome === "error" ? previousFailures + 1 : 0;
  let delayMs = 0;
  if (outcome === "error") {
    delayMs = Math.min(
      LIVE_VIEW_REFRESH_INTERVAL_MS * 2 ** failures,
      LIVE_VIEW_BACKOFF_MAX_MS,
    );
  } else if (outcome !== "published") {
    delayMs = AWAITING_FIRST_PUBLISH_POLL_MS;
  }
  const entry: OneLocationGrantPollEntry = {
    nextAttemptAt: now + delayMs,
    failures,
  };
  schedule.set(grantId, entry);
  return entry;
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

/**
 * Exported for the unit test that guards the ordering below. The ordering is
 * the whole point of this function and is easy to undo by accident.
 */
export function oneLocationFailureClass(error: unknown): string {
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
  // Encryption before permission. "location" is a substring of almost every
  // message this surface produces — "could not decrypt location envelope"
  // included — so matching it first labelled key and envelope failures as
  // permission problems. In production, `permission` is 965 of 1,248 retry
  // events on iOS, and an unknown share of those are really something else;
  // the point of a failure class is to send you to the right cause.
  if (
    message.includes("key") ||
    message.includes("encrypt") ||
    message.includes("decrypt")
  ) {
    return "encryption";
  }
  // Matched on the vocabulary the platforms actually use for a denial, not on
  // the word "location" — which appears in nearly every message this surface
  // produces and was therefore labelling unrelated failures as permission
  // problems.
  if (
    message.includes("permission") ||
    message.includes("denied") ||
    message.includes("authoriz")
  ) {
    return "permission";
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
  staleAction,
}: {
  point: PlainLocationPoint;
  // Self-location previews do not need Directions/Start - you are already there.
  showNavigation?: boolean;
  viewportResetKey?: string | number;
  staleAction?: ReactNode;
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
          className="mx-3 mb-3 flex min-w-0 flex-col gap-2 rounded-[12px] border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[12px] font-medium text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:text-amber-100"
        >
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              Location may be stale.
            </span>
          </span>
          {staleAction ? <span className="shrink-0">{staleAction}</span> : null}
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

function avatarColor(_index: number): string {
  return "bg-[color:var(--app-accent-surface)]";
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
          : `${avatarColor(index)} text-[color:var(--app-accent-deep)]`,
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
  description?: string;
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
        {description ? (
          <div className="break-words text-[13px] leading-5 text-[#8e8e93] [overflow-wrap:anywhere] dark:text-white/55">
            {description}
          </div>
        ) : null}
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
    detail: "Only picked people.",
  },
  {
    icon: Clock3,
    label: "Auto-expires",
    detail: "Stops on its own.",
  },
  {
    icon: Hand,
    label: "Stop anytime",
    detail: "End it in one tap.",
  },
];

const ONE_LOCATION_FIRST_RUN_STEPS: {
  icon: LucideIcon;
  title: string;
  detail: string;
}[] = [
  {
    icon: UsersRound,
    title: "Pick people",
    detail: "Choose or invite.",
  },
  {
    icon: Clock3,
    title: "Choose how long",
    detail: "Auto-stops.",
  },
  {
    icon: Send,
    title: "Share or request",
    detail: "Share yours or ask.",
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
          3 quick steps
        </h3>
        <p className="text-[13px] leading-snug text-[#8e8e93] dark:text-white/55">
          You choose when sharing starts.
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

/**
 * Refuse a share only when no attempt could succeed.
 *
 * `denied` used to appear here, which meant a permission value we merely read
 * could veto a share the device would have allowed — and on Safari, where the
 * value is unreadable and arrived as `unavailable`, it vetoed every share on a
 * perfectly working phone. The share paths now attempt and let a real denial
 * stop them, so this only guards what genuinely cannot be attempted.
 */
function locationPermissionBlocksSharing(
  permission: HushhLocationPermissionState | null,
): boolean {
  return locationBlockReason(permission) !== null;
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

function readinessCopy(
  permission: HushhLocationPermissionState | null,
  observedDenial = false,
): {
  title: string;
  description: string;
  tone: "ready" | "warning" | "blocked" | "checking";
  actionLabel?: string;
} {
  if (!permission) {
    return {
      title: "Checking location readiness",
      description: "Checking this device.",
      tone: "checking",
    };
  }
  if (isLocationServicesDisabled(permission)) {
    return {
      title: "Turn on phone Location",
      description: "Turn on Location before sharing.",
      tone: "blocked",
      actionLabel: "Open Location Settings",
    };
  }
  if (permission.state === "prompt") {
    return {
      title: "Allow location permission",
      description: "Allow access before sharing.",
      tone: "warning",
      actionLabel: "Allow Location",
    };
  }
  // Only a refusal we actually observed proves the device is blocked. A
  // read-back `denied` may be stale, and on Safari it cannot be read at all —
  // so this offers to ask rather than declaring a dead end the user cannot act
  // on. `restricted` is genuinely unaskable and stays blocked.
  if (permission.state === "restricted" || (permission.state === "denied" && observedDenial)) {
    return {
      title: "Location permission blocked",
      description: "Allow access in Settings.",
      tone: "blocked",
      actionLabel: "Open Location Settings",
    };
  }
  if (permission.state === "denied") {
    return {
      title: "Allow location permission",
      description: "Allow access when prompted.",
      tone: "warning",
      actionLabel: "Allow Location",
    };
  }
  if (permission.state === "unavailable") {
    return {
      title: "Location unavailable",
      description: "Check Location settings and try again.",
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
        ? "Accuracy may be approximate."
        : "Ready for sharing.",
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

/**
 * How long a confirmed nearby checkout suppresses the next one.
 *
 * Deliberately short. Nearby presence is account-wide rather than per-device,
 * so this device's belief that it already checked out can be made wrong by a
 * check-in somewhere else. Any window long enough to cover that is far too
 * long: it would let a pause silently skip the checkout and leave someone
 * visible while being told they are not. Ten seconds absorbs a person flicking
 * the switch — the only thing that can actually reach the 6/minute nearby-write
 * limit — and no real cross-device sequence fits inside it.
 */
const NEARBY_CHECKOUT_DEDUPE_MS = 10_000;

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
  const focusedCircleMemberInviteId = useMemo(
    () => String(searchParams.get("circleInviteId") || "").trim() || null,
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
  // Set only by a capture attempt that came back with a real PERMISSION_DENIED.
  // A denial we observed is trustworthy in a way a queried one is not, so this
  // — not the permission API — is what lets the UI say "blocked" and route the
  // user to settings. Cleared the moment any capture succeeds.
  const observedLocationDenialRef = useRef(false);
  const [locationDenialObserved, setLocationDenialObserved] = useState(false);
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
  /** Which sent request is being taken back. Keyed by request, not by grant. */
  const [withdrawingRequestId, setWithdrawingRequestId] = useState<
    string | null
  >(null);
  /** Which grant is showing the inline duration editor, wherever it's listed. */
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  /** Which grant's duration is being saved. Separate from revoke on purpose. */
  const [savingGrantId, setSavingGrantId] = useState<string | null>(null);
  const [editGrantDurationHours, setEditGrantDurationHours] = useState(
    GRANT_EDIT_DURATION_FALLBACK,
  );
  // One clock for every "time left" on this screen. The countdowns read
  // Date.now() at render and nothing re-rendered them, so "Stops in 59 min"
  // was true when the screen opened and stayed on the glass as the hour ran
  // out -- the single number people use to decide when to ask for more time
  // was the one that had quietly stopped moving. 30s, not 1s: these labels
  // are minute-grained, and re-rendering to move nothing is cost with no
  // reader.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    // A screen returning from background can be minutes stale; refresh the
    // clock on the way in rather than waiting out the next tick.
    const syncNow = () => setNowMs(Date.now());
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", syncNow);
    }
    return () => {
      window.clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", syncNow);
      }
    };
  }, []);
  const approvalsNowMs = nowMs;
  /*
   * The live share card's own time editor. Separate from the three flags above
   * on purpose: those edit a share somebody else is giving you, where more time
   * has to be asked for. This one edits the share you are giving, where more
   * time is yours to grant and applies immediately.
   */
  const [liveShareDurationEditing, setLiveShareDurationEditing] =
    useState(false);
  const [liveShareDurationHours, setLiveShareDurationHours] = useState(
    GRANT_EDIT_DURATION_FALLBACK,
  );
  const [liveShareDurationSaving, setLiveShareDurationSaving] = useState(false);
  // Opt-in: keep publishing location while the app is backgrounded (native only).
  const [backgroundShareEnabled, setBackgroundShareEnabled] = useState(false);
  // Monotonic counter bumped each time a share completes successfully, so the
  // redesign hub can close the 2-step share flow and return to the main screen.
  const [shareCompletedTick, setShareCompletedTick] = useState(0);
  // Where to land once a share completes, when the caller wants somewhere
  // other than the clean hub.
  //
  // A hands-free share is invisible: One says it started sharing and the
  // screen returns to a hub that looks exactly as it did before. This lets
  // the voice path ask to be dropped on Active shares instead, which is both
  // the proof it happened and the way to stop it.
  //
  // A ref rather than state, because the value has to be readable by the
  // completion effect on the very render the tick bumps -- and because taps
  // must keep landing on the clean hub, which they do by never setting it.
  const shareCompletedDestinationRef = useRef<string | null>(null);

  const [sosIncident, setSosIncident] = useState<SosIncident | null>(null);
  const [sosEmergency, setSosEmergency] = useState<EmergencyInfo | null>(null);
  const [sosEmergencyStatus, setSosEmergencyStatus] =
    useState<EmergencyNumberLookupStatus>("idle");
  const sosLocationResolutionRef =
    useRef<Promise<PlainLocationPoint | null> | null>(null);
  const sosEmergencyLookupIdRef = useRef(0);
  /**
   * The fix the currently displayed emergency number was confirmed at, so a
   * later fix nearby can reuse it instead of re-resolving, and a distant one
   * forces a fresh lookup rather than silently keeping the old country.
   */
  const sosEmergencyOriginRef = useRef<PlainLocationPoint | null>(null);
  /**
   * The lookup currently in flight and the point that started it. Save My Soul
   * and the background warmer can both react to the same fix within a tick, and
   * an emergency screen is the last place to spend a second geocode — or to let
   * two racing lookups decide the number by arrival order.
   */
  const sosEmergencyInFlightRef = useRef<{
    point: PlainLocationPoint;
    promise: Promise<void>;
  } | null>(null);

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
  /**
   * The point onboarding confirmed, kept ALIVE past the save-place modal.
   *
   * `saveLocationPoint` above is that modal's draft, and both of its exits null
   * it -- the save at `saveOnboardingLocation` and the skip at
   * `handleSkipSaveOnboardingLocation`. That is right for a draft and was fatal
   * for the finale: "You're on the map." renders two screens later, so it
   * received null every single time and always drew its stylised fallback. The
   * feature shipped and nobody could see it, in any environment.
   *
   * So the finale gets its own state. Written wherever a real fix is
   * established, never cleared by the modal closing, cleared only when the
   * account changes (below, with the rest of that reset).
   */
  const [onboardingConfirmedPoint, setOnboardingConfirmedPoint] =
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
  const [selectedRecipientIds, setSelectedRecipientIds, selectedRecipientIdsRef] =
    useShareRecipientSelectionState();
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
  const [
    incomingCircleMemberInvites,
    setIncomingCircleMemberInvites,
  ] = useState<OneLocationCircleMemberInvite[]>([]);
  const [
    incomingCircleMemberInvitesLoading,
    setIncomingCircleMemberInvitesLoading,
  ] = useState(false);
  const [
    incomingCircleMemberInvitesError,
    setIncomingCircleMemberInvitesError,
  ] = useState<string | null>(null);
  const [
    resolvedCircleMemberInviteFocusId,
    setResolvedCircleMemberInviteFocusId,
  ] = useState<string | null>(null);
  const circleMemberInviteRequestRef = useRef(0);
  const [namedCircleShareContext, setNamedCircleShareContext] = useState<{
    circleId: string;
    circleName: string;
    recipientUserIds: string[];
  } | null>(null);
  const [
    selectedShareCircleSelection,
    setSelectedShareCircleSelection,
  ] = useState<CircleRecipientSelection | null>(null);
  const [locationWorkspace, setLocationWorkspace] =
    useState<LocationWorkspaceMemory>(() =>
      readLocationWorkspaceMemory(auth.userId),
    );
  const locationControl = useOneLocationControlState(auth.userId);
  // Synchronous mirror of "this device may publish right now", read inside the
  // async publish loops between awaits so a pause takes effect immediately
  // rather than at the next render.
  //
  // Pause is the only preference here. Live updates used to also require the
  // "Auto-share" toggle, which meant switching that off silently froze every
  // share the recipients were already relying on. Auto-share is now what its
  // name says -- auto-approving incoming requests -- and an approved, unexpired
  // grant keeps updating until it is paused, revoked, or expires.
  const automaticPrivatePublishingAllowedRef = useRef(!locationControl.paused);
  useEffect(() => {
    automaticPrivatePublishingAllowedRef.current = !locationControl.paused;
  }, [locationControl.paused]);
  // Monotonic claim on the Location on/off control. Every tap takes the next
  // number; work started by an earlier tap must not write its result once a
  // newer one exists. Without it, "on" (device fix still in flight) followed by
  // "off" lands back ON when that fix arrives — the control silently undoing
  // what the person just did, which on this particular switch is a privacy
  // failure rather than a glitch.
  const locationIntentSeqRef = useRef(0);
  // When the last nearby checkout was confirmed, guarding the next one for
  // NEARBY_CHECKOUT_DEDUPE_MS. Nearby writes are capped at 6/minute, and a 429
  // here would be reported as "you may still be visible to people around you" —
  // a false alarm about the one thing this surface must never be wrong about.
  const nearbyCheckoutConfirmedAtRef = useRef(0);
  useEffect(() => {
    // Checked back in: whatever we last confirmed no longer describes presence.
    if (locationControl.nearbyPresenceActive) {
      nearbyCheckoutConfirmedAtRef.current = 0;
    }
  }, [locationControl.nearbyPresenceActive]);
  useEffect(() => {
    // A different account carries different presence; never inherit the window.
    nearbyCheckoutConfirmedAtRef.current = 0;
  }, [auth.userId]);
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
    // The one place the finale's point IS cleared. A coordinate belongs to the
    // account that produced it, and must never be inherited across a switch.
    setOnboardingConfirmedPoint(null);
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
        // An updater that decided nothing changed hands back the same object.
        // Honouring that is what lets React bail out instead of re-rendering
        // this surface on every live poll.
        if (next === current) return current;
        writeLocationWorkspaceMemory(auth.userId, next);
        return next;
      });
    },
    [auth.userId],
  );
  const myLocationPoint = locationWorkspace.myLocationPoint;
  /**
   * Where the last onboarding screen puts its camera.
   *
   * Three sources, freshest first, resolved by a named function with its own
   * tests rather than inline here -- see `resolveOnboardingMapPoint`. The
   * workspace point at the end is what covers the person who reached the finale
   * without the save-place step running at all: a returning account, or a
   * workspace run where Location was already granted.
   */
  const onboardingFinaleMapPoint = useMemo(
    () =>
      resolveOnboardingMapPoint({
        draft: saveLocationPoint,
        confirmed: onboardingConfirmedPoint,
        workspace: myLocationPoint,
      }),
    [myLocationPoint, onboardingConfirmedPoint, saveLocationPoint],
  );
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
      automaticPrivatePublishingAllowedRef.current = true;
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
    [auth.userId, updateLocationWorkspace],
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
      updateLocationWorkspace((current) => {
        const resolved =
          typeof next === "function"
            ? (
                next as (
                  value: Record<string, PlainLocationPoint>,
                ) => Record<string, PlainLocationPoint>
              )(current.decryptedPoints)
            : next;
        // Propagate the updater's "nothing changed" verdict instead of
        // allocating a fresh workspace around an unchanged map.
        if (resolved === current.decryptedPoints) return current;
        return { ...current, decryptedPoints: resolved };
      });
    },
    [updateLocationWorkspace],
  );
  // Per-grant, recipient-facing status shown when a received share has no point
  // on screen. Keyed by grant id, mirrors `decryptedPoints`.
  //
  // The tone is not decoration, it is the whole point. Two very different
  // things land here and were previously indistinguishable behind a bare
  // string named "error":
  //
  //   waiting — the share is healthy and the owner simply has not published a
  //     point yet. This is the single most common state on the receiving side
  //     and it is a SUCCESS. Rendering it as a warning would put a scary
  //     banner on the happy path, which is exactly the category error that
  //     made `oneLocationFailureClass` label these as permission failures.
  //   blocked — the recipient genuinely cannot open this share and it will not
  //     fix itself on the next poll. Only this tone earns an alert and the
  //     "Ask to refresh" action.
  const [grantViewErrors, setGrantViewErrors] = useState<
    Record<string, GrantViewStatus>
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
  /** When the in-flight sweep began, so a wedged sweep can be timed out. */
  const liveViewStartedAtRef = useRef(0);
  /** Identifies the sweep that currently owns the in-flight guard. */
  const liveViewSweepIdRef = useRef(0);
  /** Per-grant read pacing: see `recordGrantPollOutcome`. */
  const grantPollScheduleRef = useRef<Map<string, OneLocationGrantPollEntry>>(
    new Map(),
  );
  /** Latest-value refs so the recipient poll runs on one stable interval. */
  const visibleReceivedGrantsRef = useRef<OneLocationGrant[]>([]);
  const viewGrantEnvelopeRef = useRef<
    (
      grant: OneLocationGrant,
      options?: { silent?: boolean; trigger?: OneLocationForegroundTrigger },
    ) => Promise<OneLocationViewOutcome>
  >(async () => "skipped");
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
  const namedCircles = useMemo(
    () => state?.circles ?? [],
    [state?.circles],
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
  const shareRecipientPool = useMemo(
    () =>
      mergeRecipientsByUserId(
        rankedRecipients,
        (selectedShareCircleSelection?.ready ?? []).map(
          (target) => target.recipient,
        ),
      ),
    [rankedRecipients, selectedShareCircleSelection],
  );
  // A typed search matches the NAME, and nothing else on the row.
  //
  // These two boxes used to search `recommendationSearchText`, which appends
  // every recipient's headline, relationship, category and reason labels to
  // their name. Those labels are boilerplate — each person carries one of
  // "Needs action", "Trusted Circle", "One Network", "Contact match",
  // "Ready for private location sharing" — so most letters begin a word on
  // EVERY row: "n" hit "Needs", "t" hit "Trusted", "o" hit "One", "r" hit
  // "Ready", "c" hit "Contact" and "Circle". Typing the first letter of a
  // person's name returned the entire list, which is exactly the complaint
  // that word-prefix matching was added to answer. The matcher was already
  // right; it was being handed a haystack with the same words in every straw.
  //
  // Connect settled this rule first: matching on anything other than the name
  // is how a search returns a person nobody asked for. `recommendationSearchText`
  // stays for the voice path below, where the input is a whole spoken phrase
  // rather than one letter and the extra context helps rather than swamps.
  const visibleRecipients = useMemo(
    () => filterPeopleByQuery(rankedRecipients, recipientSearch, recipientLabel),
    [rankedRecipients, recipientSearch],
  );
  const visibleShareRecipients = useMemo(
    () =>
      filterPeopleByQuery(rankedRecipients, shareRecipientSearch, recipientLabel),
    [rankedRecipients, shareRecipientSearch],
  );
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
      recipientSelectionFromIds(shareRecipientPool, selectedRecipientIds),
    [selectedRecipientIds, shareRecipientPool],
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
  // Whether this person appears as a pin on the maps of people they already
  // share with.
  //
  // The preference itself is not new -- it is `presence_mode`, and it defaults
  // to 'ghost'. What was new is being able to find it: it lived only behind a
  // Ghost toggle on the immersive map screen, so somebody who shared their
  // location and then wondered why they never appeared on the other person's
  // map had no way to discover the switch that decided it. Null while loading,
  // so the control can be shown disabled rather than lying about its state.
  const [mapPresenceEnabled, setMapPresenceEnabled] = useState<boolean | null>(
    null,
  );
  useEffect(() => {
    if (!vaultOwnerToken) return;
    let cancelled = false;
    void OneLocationService.getMapPreferences(vaultOwnerToken)
      .then((preferences) => {
        if (cancelled) return;
        setMapPresenceEnabled(preferences.presenceMode === "foreground_private");
      })
      .catch(() => {
        // Unknown is not the same as off, but the control has to say something
        // -- and offering it as "off" is the honest failure: it cannot make a
        // person more visible than they already are.
        if (!cancelled) setMapPresenceEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultOwnerToken]);
  const handleMapPresenceChange = useCallback(
    (next: boolean) => {
      if (!vaultOwnerToken) return;
      // Optimistic, then corrected by the server's answer. A privacy switch
      // that lags behind the finger reads as broken, and people toggle it
      // again -- which is how somebody ends up visible when they meant not to.
      setMapPresenceEnabled(next);
      void OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        presenceMode: next ? "foreground_private" : "ghost",
      })
        .then((preferences) => {
          setMapPresenceEnabled(preferences.presenceMode === "foreground_private");
        })
        .catch(() => {
          setMapPresenceEnabled(!next);
          toast.error("Could not change map visibility.");
        });
    },
    [vaultOwnerToken],
  );

  const pendingOwnerRequests = useMemo(
    () =>
      (state?.requests ?? []).filter(
        (request) =>
          request.ownerUserId === auth.userId && request.status === "pending",
      ),
    [auth.userId, state?.requests],
  );
  // Warm the shared position while the user is still reading the request.
  //
  // Approving publishes an encrypted point, so it needs a fix — and nothing on
  // the review path seeds one. That meant the FIRST approve on an idle queue
  // always paid a full device acquisition inside its own spinner, which is the
  // "approve takes seconds" report. Taking the read now moves it off the
  // critical path; by the time the button is pressed the 20s reuse window in
  // captureCurrentPosition answers instantly.
  //
  // Gated on an ALREADY-granted permission on purpose. A capture that could
  // raise the system prompt outside a user gesture would spend the single
  // prompt iOS grants at a moment the user cannot connect to anything they did.
  useEffect(() => {
    if (permission?.state !== "granted") return;
    if (!pendingOwnerRequests.length) return;
    void OneLocationService.captureCurrentPosition().catch(() => null);
  }, [pendingOwnerRequests.length, permission?.state]);
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
      (state?.receivedGrants ?? [])
        .filter((grant) => grant.status === "active")
        // Stable sort: only ever moves an SMS-triggered (Save My Soul) share
        // earlier. Array.prototype.sort is stable, so the backend's existing
        // most-recent-first order is untouched within each group.
        .sort(
          (a, b) =>
            Number(isSmsTriggeredGrant(b)) - Number(isSmsTriggeredGrant(a)),
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

  /* ------------------------------------------------------------------ *
   * Live share continuity
   *
   * `state` is a memory-only snapshot that expires after a minute, so leaving
   * this route and returning re-entered the screen believing nothing was live
   * until the network answered — a share deliberately set to "1 hour" appeared
   * to have been forgotten. The device record below restores the running window
   * on the first frame; the server stays the authority and reconciles into it.
   * ------------------------------------------------------------------ */
  const [liveShareEntries, setLiveShareEntries] = useState<
    LiveShareSessionEntry[]
  >(() => loadLiveShareEntries(auth.userId ?? ""));
  const liveShareEntriesRef = useRef(liveShareEntries);
  useEffect(() => {
    liveShareEntriesRef.current = liveShareEntries;
  }, [liveShareEntries]);

  useEffect(() => {
    const userId = auth.userId;
    // Another account's shares must never render as yours, not even for one
    // frame, so the record is keyed per owner and cleared on the way out.
    setLiveShareEntries(userId ? loadLiveShareEntries(userId) : []);
  }, [auth.userId]);

  const commitLiveShareEntries = useCallback(
    (next: LiveShareSessionEntry[]) => {
      const userId = auth.userId;
      if (liveShareEntriesEqual(next, liveShareEntriesRef.current)) return;
      liveShareEntriesRef.current = next;
      setLiveShareEntries(next);
      if (!userId) return;
      if (next.length) saveLiveShareEntries(userId, next);
      else clearLiveShareEntries(userId);
    },
    [auth.userId],
  );

  useEffect(() => {
    // Guarded on `state`: reconciling against an empty grant list before the
    // first load lands would erase a genuinely running share.
    if (!auth.userId || !state) return;
    commitLiveShareEntries(
      reconcileLiveShareEntries(liveShareEntriesRef.current, activeOwnerGrants),
    );
  }, [activeOwnerGrants, auth.userId, commitLiveShareEntries, state]);

  const liveShareStatus = useMemo<LiveShareStatus | null>(() => {
    const shareWindow = summarizeLiveShareEntries(liveShareEntries);
    if (!shareWindow) return null;
    const liveGrantIds = new Set(
      liveShareEntries.map((entry) => entry.grantId),
    );
    return {
      count: shareWindow.count,
      // Names come from the server state only. The device record stays
      // coordinate- and identity-free, so a cold start shows "2 people" rather
      // than inventing who they are.
      names: activeOwnerGrants
        .filter((grant) => liveGrantIds.has(grant.id))
        .map((grant) => grantCounterpartyLabel(grant))
        .filter(Boolean),
      startedAt: shareWindow.startedAt,
      endsAt: shareWindow.endsAt,
      stoppableGrantId:
        liveShareEntries.length === 1
          ? (liveShareEntries[0]?.grantId ?? null)
          : null,
    };
  }, [activeOwnerGrants, liveShareEntries]);

  const locationEnabled =
    !locationControl.paused &&
    (locationControl.selfPreviewEnabled ||
      locationControl.nearbyPresenceActive ||
      activeOwnerGrants.length > 0);
  // "Location limited" is a signal-quality badge, not an admission gate, so it
  // tracks the coarse threshold rather than the hard check-in ceiling. Those two
  // are now far apart: a 1 km browser fix is genuinely limited but still
  // perfectly usable for picking the venue you are standing in.
  const locationAccuracyLimited =
    locationEnabled &&
    (permission?.precise === false ||
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

  /**
   * Reload the whole Location workspace from the backend.
   *
   * A mutating CTA must NOT hold its spinner open across this. By the time a
   * handler reaches it the work is done and already confirmed by a toast — the
   * public link is in the clipboard, the request is approved, the share is
   * revoked. Awaiting a full state reload after that just keeps the button
   * disabled for one more round trip the user is not waiting on, which is most
   * of what "every click takes seconds" was. It was also actively misleading:
   * a reload that failed after a successful revoke surfaced as "Could not
   * revoke access", blaming the operation that had in fact succeeded.
   *
   * Call it as `void refresh().catch(() => null)` from a CTA. It coalesces
   * in-flight callers itself (refreshInFlightRef below), so firing it without
   * awaiting cannot stampede.
   */
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
      setSelectedRecipientIds,
      stateEntry?.userId,
      vaultOwnerToken,
    ],
  );

  // The countdown hitting zero is the first moment anyone knows the share is
  // over — the backend expires it silently. Drop the local record and pull the
  // authoritative state so the screen agrees with the server within one round
  // trip instead of sitting at 00:00.
  const handleLiveShareEnded = useCallback(() => {
    const userId = auth.userId;
    commitLiveShareEntries(
      pruneLiveShareEntries(liveShareEntriesRef.current, Date.now()),
    );
    if (!userId) return;
    OneLocationStateResource.invalidate(userId);
    void refresh({ background: true });
  }, [auth.userId, commitLiveShareEntries, refresh]);

  const refreshLocationPermission = useCallback(async () => {
    // A failed read means we do not know, which is a reason to ask the device
    // rather than to declare it unusable. Reporting `unavailable` here used to
    // block every share path and pin the toggle off whenever the platform could
    // not introspect its own permission — which is every iPhone, since WebKit
    // has no `geolocation` entry in the Permissions API.
    const nextPermission = await OneLocationService.getPermissionState().catch(
      () => ({
        state: "prompt" as const,
        precise: null,
        background: "foreground-only" as const,
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
      /**
       * Lets a caller whose request has been superseded discard the fix instead
       * of applying it. A capture can outlive the intent that started it, and
       * `activateMyLocation` un-pauses — so a stale fix from an abandoned "turn
       * on" would otherwise reverse the pause that replaced it. Only the
       * on/off control passes this; every other caller keeps today's behaviour.
       */
      isStale?: () => boolean;
      /**
       * Whether this gate may speak.
       *
       * False for a caller that prints its own message — nine of them do, and
       * a shared toast on top meant one failure produced two. Also false for
       * anything the owner did not ask for: a screen warming a position in the
       * background does not get to interrupt them about it.
       */
      announce?: boolean;
      /**
       * Refuse a held position; only a fix measured now will do.
       *
       * For the small set of callers where degrading would be a lie rather
       * than a courtesy. Un-pausing is one: pause is a privacy control, and
       * resuming a share on a remembered coordinate would start telling people
       * the owner is somewhere they have left. The live publisher and the
       * check-in confirmation draw the same line for the same reason.
       */
      requireMeasurement?: boolean;
    }): Promise<{
      ready: boolean;
      point?: PlainLocationPoint;
      origin?: "fresh" | "restored";
      failure?: LocationFailure;
    }> => {
      const shouldCapturePoint = Boolean(options?.capturePoint);
      const shouldOpenSettings = options?.autoOpenSettings !== false;
      const announce = options?.announce !== false;

      const heldFix = (): PlainLocationPoint | null => {
        const bus = LocationBus.getState();
        if (!bus.snapshot) return null;
        if (!isUsableFixAge(bus.snapshot.capturedAt)) return null;
        return {
          latitude: bus.snapshot.latitude,
          longitude: bus.snapshot.longitude,
          accuracyM: bus.snapshot.accuracyM ?? null,
          capturedAt: bus.snapshot.capturedAt,
          sourcePlatform: bus.snapshot.sourcePlatform ?? "web",
        };
      };

      // Nothing to do but hand back what we already have.
      //
      // A caller that does not need a new measurement, on a session that is
      // holding a usable position, used to pay for a permission read and a
      // device round trip anyway — and could be toasted at for the privilege.
      // On Safari, where the permission value is unreadable, it took that path
      // every single time.
      if (!shouldCapturePoint && !observedLocationDenialRef.current) {
        const held = heldFix();
        if (held) {
          return {
            ready: true,
            point: held,
            origin:
              LocationBus.getState().snapshotOrigin === "fresh"
                ? "fresh"
                : "restored",
          };
        }
      }

      const currentPermission = await refreshLocationPermission();

      // Only two things stop us before we have tried, and neither can be fixed
      // by asking: the OS location service is off, or the platform forbids the
      // prompt outright (iOS `restricted`, or no geolocation at all).
      //
      // A read-back "denied" is deliberately NOT one of them. Refusing on it is
      // what made this unrecoverable: on the web the browser's prompt appears
      // only from `getCurrentPosition()`, so returning early guarantees the user
      // is never asked, and a stale or unreadable value traps them for good. We
      // attempt, and let a real PERMISSION_DENIED be the thing that blocks.
      const blockReason = locationBlockReason(currentPermission);
      if (blockReason) {
        if (announce) toast.error(LOCATION_BLOCK_MESSAGE[blockReason]);
        if (shouldOpenSettings && announce) {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false, failure: "blocked" };
      }

      if (
        currentPermission.state === "granted" &&
        !shouldCapturePoint &&
        !observedLocationDenialRef.current
      ) {
        return { ready: true };
      }

      try {
        const point = await OneLocationService.captureCurrentPosition();
        // A coordinate in hand outranks anything the permission API says. This
        // is what keeps Safari honest, where the value is simply unreadable.
        observedLocationDenialRef.current = false;
        setLocationDenialObserved(false);
        // Re-reading permission here is bookkeeping — it refreshes `precise`
        // for the accuracy badge — not a precondition for holding the fix we
        // just got. Awaiting it put a second platform round trip in front of
        // every caller, including the on/off control, for a value nothing on
        // this path goes on to read. Fire it and let it land on its own.
        void OneLocationService.getPermissionState()
          .catch(() => null)
          .then((nextPermission) =>
            setPermission(
              nextPermission ?? {
                state: "granted",
                precise: null,
                background: "foreground-only",
                locationServicesEnabled: true,
              },
            ),
          );
        if (shouldCapturePoint && !options?.isStale?.()) {
          activateMyLocation(point);
        }
        // The fix is returned even when this caller did not ask to capture one,
        // so a later step in the same flow can use it instead of paying for a
        // second acquisition. `shouldCapturePoint` still governs the SIDE
        // EFFECT (activateMyLocation) above — only the return widens.
        return {
          ready: true,
          point,
          origin:
            LocationBus.getState().snapshotOrigin === "restored"
              ? "restored"
              : "fresh",
        };
      } catch (error) {
        const nextPermission =
          await OneLocationService.getPermissionState().catch(() => null);
        if (nextPermission) {
          setPermission(nextPermission);
        }
        // Only an attempt can prove a denial. Record it so the UI can say
        // "blocked" and offer settings, instead of guessing from a query.
        const denied = isLocationPermissionDeniedError(error);
        observedLocationDenialRef.current = denied;
        setLocationDenialObserved(denied);

        // Not a refusal, and we are holding a position. Use it and say
        // nothing: this is the case that produced most of the noise, because
        // a device that declines one reading is routine and the owner has
        // nothing to do about it.
        const held =
          denied || options?.requireMeasurement ? null : heldFix();
        if (held) {
          if (shouldCapturePoint && !options?.isStale?.()) {
            activateMyLocation(held);
          }
          return { ready: true, point: held, origin: "restored" };
        }

        const failure: LocationFailure = denied
          ? "denied"
          : isLocationServicesDisabled(nextPermission)
            ? "blocked"
            : "no-fix";
        if (
          shouldSurfaceLocationError({
            hasUsableFix: false,
            observedDenial: denied,
            blockReason: locationBlockReason(nextPermission),
            blocksUserIntent: announce,
          })
        ) {
          toast.error(
            failure === "no-fix" ? LOCATION_COPY.noFix : LOCATION_COPY.denied,
          );
        }
        // Settings only for something Settings can fix. The old trigger also
        // fired on any message containing "turn on location" — which the web
        // plugin puts on a TIMEOUT, so a laptop with no GPS radio was thrown
        // at a settings pane it does not have.
        if (shouldOpenSettings && announce && failure !== "no-fix") {
          await OneLocationService.openLocationSettings().catch(() => null);
        }
        return { ready: false, failure };
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
      // Eligible for the recipient's map.
      //
      // Until now `foreground_map_visible` was written in exactly one place --
      // the locate button on the map screen -- so a pin only ever appeared
      // while the SHARER happened to be standing on that screen. Sharing your
      // location through the normal flow put you in their "Shared with me"
      // card and nowhere else, which is why the map read "0 live locations"
      // next to a card saying someone was live 23 seconds ago.
      //
      // The widening is bounded by what the envelope already is: it is
      // encrypted to one recipient's key and exists only because the sharer
      // created a grant for that person, for a duration they chose. Appearing
      // as a pin on that person's map is the thing they agreed to. It does not
      // make anyone visible to anyone else, and Ghost Mode still overrides it.
      envelope.publicationContext = "foreground_map_visible";
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
    setNamedCircleShareContext(null);
    setSelectedShareCircleSelection(null);
    setShareDurationHours(ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS);
    setShareMessage("");
  }, [setSelectedRecipientIds]);
  /**
   * Clears the ask composer after a send.
   *
   * `sentUserIds` is subtracted rather than the whole selection being dropped:
   * sending takes several round trips (identity sync, key registration, then one
   * request per person), and anybody tapped during that window used to be wiped
   * by a blanket clear when it finally landed. Their pick simply vanished, with
   * no error and no request. Only the people actually asked are removed.
   */
  const resetRequestComposer = useCallback((sentUserIds?: readonly string[]) => {
    suppressAutoRecipientSelectionRef.current = true;
    setSelectedRequestOwnerId("");
    if (!sentUserIds) {
      setSelectedRequestOwnerIds([]);
    } else {
      const sent = new Set(sentUserIds);
      setSelectedRequestOwnerIds((current) =>
        current.filter((id) => !sent.has(id)),
      );
    }
    setRequestMessage("");
  }, []);

  // `durationOverride` exists for the voice path. Setting `shareDurationHours`
  // and then calling this would read the pre-render value, so the duration
  // travels as an argument rather than through state it cannot see yet. Taps
  // pass nothing and keep using whatever the composer shows.
  const handleShare = useCallback(
    async (
      durationOverride?: string,
      landOnAfter?: string,
    ): Promise<LocalOnboardingActionResult> => {
      const effectiveDurationHours = durationOverride ?? shareDurationHours;
      const durationPayload = privateShareDurationPayload(effectiveDurationHours);
      // Set on every attempt, so a landing asked for by one share can never
      // survive into the next one. Taps pass nothing and get the clean hub.
      shareCompletedDestinationRef.current = landOnAfter ?? null;
    if (!vaultOwnerToken) {
      return { status: "blocked", summary: "Unlock One before sharing your location." };
    }
    // See resolveEffectiveShareRecipients' doc comment for why an empty
    // selectedShareRecipients falls back to the ref instead of being trusted
    // as "nobody picked".
    const effectiveSelectedShareRecipients = resolveEffectiveShareRecipients(
      selectedShareRecipients,
      shareRecipientPool,
      selectedRecipientIdsRef.current,
    );
    const effectiveSetupNeededSelectedRecipients =
      effectiveSelectedShareRecipients.filter(
        (recipient) => !isShareReadyRecipient(recipient),
      );
    const effectiveShareReadySelectedRecipients =
      effectiveSelectedShareRecipients.filter(isShareReadyRecipient);
    // Test the SELECTION, not the share-ready subset of it. Those differ
    // whenever someone is picked who has not finished their own Location
    // setup, and reading the subset made this answer "nobody is selected"
    // about a person who was visibly selected on screen -- sending the voice
    // chain back to pick someone it had already picked. Observed live: the
    // pick settled "Matched Abdul Rashid", and the share that followed it
    // said nobody was selected.
    if (!effectiveSelectedShareRecipients.length) {
      return {
        status: "blocked",
        summary:
          "Nobody is selected yet. Pick who you want to share with, then say share again.",
      };
    }
    if (effectiveSetupNeededSelectedRecipients.length) {
      // Name them. The person picked this contact by name a moment ago, so
      // the name is already theirs and already spoken; "someone you picked"
      // leaves them guessing which of several it means.
      const blockedNames = effectiveSetupNeededSelectedRecipients
        .map((recipient) => recipientLabel(recipient).trim())
        .filter(Boolean);
      return {
        status: "blocked",
        summary: blockedNames.length
          ? `${blockedNames.join(", ")} still needs to finish their own Location setup before you can share with them.`
          : "Someone you picked still needs to finish their Location setup.",
      };
    }
    if (shareMessage.length > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH) {
      return { status: "blocked", summary: "The note on this share is too long." };
    }
    if (locationPermissionBlocksSharing(permission)) {
      return {
        status: "blocked",
        summary: "Sharing needs device Location permission.",
      };
    }
    setBusy("share");
    let successCount = 0;
    let recipientFailureCount = 0;
    let lastRecipientError: unknown = null;
    try {
      const readiness = await ensureForegroundLocationReady({
        capturePoint: true,
        autoOpenSettings: true,
      });
      if (!readiness.ready || !readiness.point) {
        return {
          status: "blocked",
          summary: "Sharing needs device Location permission.",
        };
      }
      const point = readiness.point;
      // Share with everyone at once rather than one after another. Sharing with
      // N people used to cost 2N round trips end to end, so picking five people
      // was five times slower than picking one for no reason the user could see
      // — each recipient's grant is an independent row and nothing downstream
      // depends on the previous one finishing.
      //
      // Bounded rather than a bare Promise.all: server-side each grant holds a
      // writer-guard connection WHILE its row insert opens a second one, so an
      // unbounded fan-out over a large Circle can exhaust a small connection
      // pool. Four at a time keeps the wall clock near a single round trip and
      // stays well inside the pool.
      const pending = [...effectiveShareReadySelectedRecipients];
      const shareOne = async () => {
        for (;;) {
          const recipient = pending.shift();
          if (!recipient) return;
          try {
            const grant = await OneLocationService.createGrant({
              vaultOwnerToken,
              recipientUserId: recipient.userId,
              recipientKeyId: recipient.keyId,
              ...durationPayload,
              reason: shareMessage.trim() || undefined,
              shareKind: "share",
              sourceCircleId:
                namedCircleShareContext &&
                namedCircleShareContext.recipientUserIds.includes(
                  recipient.userId,
                )
                  ? namedCircleShareContext.circleId
                  : undefined,
            });
            await publishEnvelopeWithRetry(grant, recipient, "manual", point);
            successCount += 1;
          } catch (error) {
            recipientFailureCount += 1;
            lastRecipientError = error;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(ONE_LOCATION_SHARE_CONCURRENCY, pending.length) },
          shareOne,
        ),
      );
      if (!successCount && lastRecipientError) {
        throw lastRecipientError;
      }
      trackLocationShareConfirmed({
        route_id: "one_location",
        result: oneLocationEventResult(successCount, recipientFailureCount),
        selected_count: effectiveShareReadySelectedRecipients.length,
        success_count: successCount,
        failure_count: recipientFailureCount,
        duration_bucket: oneLocationDurationBucket(effectiveDurationHours),
        review_required: shareReviewOpen,
      });
      const durationLabel = privateShareDurationLabel(effectiveDurationHours);
      let summary: string;
      if (recipientFailureCount) {
        summary = `Location shared with ${peopleCountLabel(successCount)} for ${durationLabel}. ${recipientFailureCount} ${
          recipientFailureCount === 1 ? "person was" : "people were"
        } no longer ready.`;
        toast.warning(summary);
      } else {
        summary = `Location shared with ${peopleCountLabel(successCount)} for ${durationLabel}.`;
        toast.success(summary);
      }
      resetShareComposer();
      // Signal the redesign hub to close the 2-step share flow and return to
      // the main One Location screen now that sharing finished.
      setShareCompletedTick((value) => value + 1);
      void refresh().catch(() => null);
      return { status: "succeeded", summary };
    } catch (error) {
      const failureCount =
        recipientFailureCount ||
        effectiveShareReadySelectedRecipients.length - successCount ||
        1;
      trackLocationShareConfirmed({
        route_id: "one_location",
        result: oneLocationEventResult(successCount, failureCount),
        selected_count: effectiveShareReadySelectedRecipients.length,
        success_count: successCount,
        failure_count: failureCount,
        duration_bucket: oneLocationDurationBucket(effectiveDurationHours),
        review_required: shareReviewOpen,
      });
      const message =
        error instanceof Error ? error.message : "Could not share location.";
      toast.error(message);
      return { status: "failed", summary: message };
    } finally {
      setBusy(null);
    }
    },
    [
      ensureForegroundLocationReady,
      namedCircleShareContext,
      permission,
      publishEnvelopeWithRetry,
      refresh,
      resetShareComposer,
      selectedRecipientIdsRef,
      selectedShareRecipients,
      shareDurationHours,
      shareMessage,
      shareRecipientPool,
      shareReviewOpen,
      vaultOwnerToken,
    ],
  );

  /**
   * Resolve the local emergency number for a point we ALREADY have.
   *
   * Split out of the SOS screen so it can also run the moment any part of the
   * app learns where the person is (see the warming effect below). Doing the
   * country lookup then, rather than when Save My Soul opens, is what removes
   * the "Finding local number" wait from the one screen that cannot afford it.
   *
   * `seedFromCache` is only honoured when the cached country was confirmed near
   * this very point — the check lives in `isCachedEmergencyInfoUsableAt`, and a
   * distant or origin-less entry deliberately shows the spinner instead.
   */
  const runEmergencyLookup = useCallback(
    async (
      point: PlainLocationPoint,
      options?: { seedFromCache?: boolean },
    ): Promise<void> => {
      if (!vaultOwnerToken) return;
      const emergencyLookupId = sosEmergencyLookupIdRef.current + 1;
      sosEmergencyLookupIdRef.current = emergencyLookupId;

      const cached = readCachedEmergencyInfo();
      if (options?.seedFromCache && isCachedEmergencyInfoUsableAt(cached, point)) {
        // Show the known-good local number straight away. The authoritative
        // lookup below still runs and overwrites this if the country differs.
        setSosEmergency({
          countryCode: cached!.countryCode,
          countryName: cached!.countryName,
          number: cached!.number,
        });
        setSosEmergencyStatus("resolved");
      } else {
        setSosEmergency(null);
        setSosEmergencyStatus("resolving");
      }

      // Cap the authoritative lookup: past EMERGENCY_LOOKUP_TIMEOUT_MS we stop
      // waiting and fall back to the last cached local number, so the Call
      // button is never stranded on a spinner during a safety-critical flow.
      let lookupTimer: ReturnType<typeof setTimeout> | null = null;
      const lookup = OneLocationService.reverseGeocode({
        vaultOwnerToken,
        lat: point.latitude,
        lng: point.longitude,
      });
      const lookupDeadline = new Promise<never>((_, reject) => {
        lookupTimer = setTimeout(
          () => reject(new Error("emergency-lookup-timeout")),
          EMERGENCY_LOOKUP_TIMEOUT_MS,
        );
      });
      try {
        const place = await Promise.race([lookup, lookupDeadline]);
        if (sosEmergencyLookupIdRef.current !== emergencyLookupId) return;
        const emergency = emergencyInfoForCountryCode(place.countryCode);
        if (!emergency) {
          setSosEmergency(null);
          sosEmergencyOriginRef.current = null;
          setSosEmergencyStatus("unavailable");
          return;
        }
        // Warm the cache WITH the fix that proved it, so the next screen can
        // trust it instantly instead of showing a spinner or, worse, a number
        // from a country the person has since left.
        writeCachedEmergencyInfo(emergency, point);
        sosEmergencyOriginRef.current = point;
        setSosEmergency(emergency);
        setSosEmergencyStatus("resolved");
      } catch {
        if (sosEmergencyLookupIdRef.current !== emergencyLookupId) return;
        // Slow or failed authoritative lookup. A cache entry confirmed near
        // this point is still a correct answer; anything else is not, and the
        // retry state is the honest outcome.
        if (isCachedEmergencyInfoUsableAt(cached, point)) {
          setSosEmergency({
            countryCode: cached!.countryCode,
            countryName: cached!.countryName,
            number: cached!.number,
          });
          sosEmergencyOriginRef.current = point;
          setSosEmergencyStatus("resolved");
        } else {
          setSosEmergency(null);
          sosEmergencyOriginRef.current = null;
          setSosEmergencyStatus("unavailable");
        }
      } finally {
        if (lookupTimer) clearTimeout(lookupTimer);
      }
    },
    [vaultOwnerToken],
  );

  /**
   * Single entry point for "what is the emergency number here", de-duplicated.
   *
   * Save My Soul and the background warmer both react to the same fix within a
   * tick. Without this they would spend two geocodes on one question and let
   * arrival order decide the answer — on the one screen where a wrong number is
   * the worst possible outcome. A request for an area already being looked up
   * joins the existing answer instead.
   */
  const resolveEmergencyInfoForPoint = useCallback(
    (
      point: PlainLocationPoint,
      options?: { seedFromCache?: boolean },
    ): Promise<void> => {
      if (!vaultOwnerToken) {
        setSosEmergencyStatus((current) =>
          current === "resolved" ? current : "unavailable",
        );
        return Promise.resolve();
      }
      const inFlight = sosEmergencyInFlightRef.current;
      if (inFlight && isWithinEmergencyTrustRadius(inFlight.point, point)) {
        return inFlight.promise;
      }
      const promise = runEmergencyLookup(point, options);
      const entry = { point, promise };
      sosEmergencyInFlightRef.current = entry;
      void promise.finally(() => {
        if (sosEmergencyInFlightRef.current === entry) {
          sosEmergencyInFlightRef.current = null;
        }
      });
      return promise;
    },
    [runEmergencyLookup, vaultOwnerToken],
  );

  const resolveSosLocation = useCallback(() => {
    const inFlight = sosLocationResolutionRef.current;
    if (inFlight) return inFlight;

    const resolution = (async (): Promise<PlainLocationPoint | null> => {
      try {
        const result = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: false,
          // This runs when Save my Soul is merely OPENED. Nobody has asked for
          // anything yet, so a failure here has nothing to tell them — and on
          // a promptable browser a toast plus a settings pane for opening a
          // panel is how "it keeps asking me again" happens.
          announce: false,
        });
        if (!result.ready || !result.point) {
          setSosEmergencyStatus((current) =>
            // A number already confirmed nearby stays on screen: losing the
            // fix does not make the local emergency number wrong.
            current === "resolved" ? current : "unavailable",
          );
          return null;
        }
        // The point remains in foreground-only workspace memory. Merely opening
        // Save My Soul never publishes or durably persists these coordinates.
        setMyLocationPoint(result.point);
        if (!vaultOwnerToken) {
          setSosEmergencyStatus((current) =>
            current === "resolved" ? current : "unavailable",
          );
          return result.point;
        }
        // Country lookup continues independently so a slow Maps response never
        // delays the actual Save My Soul SMS after the user completes the hold.
        void resolveEmergencyInfoForPoint(result.point, { seedFromCache: true });
        return result.point;
      } catch {
        setSosEmergencyStatus((current) =>
          current === "resolved" ? current : "unavailable",
        );
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
  }, [
    ensureForegroundLocationReady,
    resolveEmergencyInfoForPoint,
    setMyLocationPoint,
    vaultOwnerToken,
  ]);

  // The local emergency number is looked up only when someone actually taps
  // "Find local number" (resolveSosLocation, wired to onResolveEmergencyNumber
  // below) or triggers Save My Soul. It used to also warm silently off any fix
  // the app already had, which made the control read as permanently loading
  // before anyone pressed it — the lookup must stay a deliberate, on-click act.

  /**
   * Records that the emergency alert fired, on every path it can leave by.
   *
   * Counts only: never the note, the coordinates, or who was contacted. The
   * number that matters is `reached_count` — an alert that reached nobody is
   * the most serious failure this product has, and it is exactly the case that
   * previously produced no telemetry because the emit sat on the success path.
   *
   * The three counts reconcile: `selected` is everyone the person chose, and
   * `unreachable` covers both those filtered out as not-ready and those whose
   * device was not alerted, so `reached + unreachable === selected`.
   */
  const trackSosTriggered = useCallback(
    ({
      selectedCount,
      reachedCount,
      unreachableCount,
      emailedCount = 0,
      note,
    }: {
      selectedCount: number;
      reachedCount: number;
      unreachableCount: number;
      emailedCount?: number;
      note?: string | null;
    }) => {
      trackEvent("one_location_sos_triggered", {
        route_id: "one_location",
        // "error", not "expected_error": reaching nobody is a genuine failure
        // of the alert, never a normal outcome.
        // Success if the alert landed on either channel.
        result: reachedCount > 0 || emailedCount > 0 ? "success" : "error",
        selected_count: selectedCount,
        reached_count: reachedCount,
        unreachable_count: unreachableCount,
        emailed_count: emailedCount,
        has_note: Boolean(note && note.trim()),
      });
    },
    [],
  );

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
        // Emitted before returning. This is an alert that reached nobody, which
        // is precisely the case the event exists to surface; leaving it on the
        // success path only meant the failures we most need to see were the
        // ones that produced no telemetry at all.
        trackSosTriggered({
          selectedCount: totalSelected,
          reachedCount: 0,
          unreachableCount: 0,
          note,
        });
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
          trackSosTriggered({
            selectedCount: totalSelected,
            reachedCount: 0,
            unreachableCount: readyRecipients.length,
            note,
          });
          toast.error(
            "Couldn't get your location — alert not sent. Check location permissions.",
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

        // Second channel. A push reaches nobody when notifications are off, so
        // the same alert goes out by email — the one place a closed app cannot
        // swallow it. Awaited (not fired and forgotten) so the message below
        // can tell the sender what actually happened, which is the whole point
        // of having a fallback. It never throws.
        const mail = await OneLocationService.sendSosEmails({
          vaultOwnerToken,
          grantIds: incident.grantIds,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM ?? null,
          // Save my Soul sends the last known position rather than nothing
          // when the device will not produce a new one — the right call in an
          // emergency, but only if the person reading it is told how old it
          // is. The email stamps anything older than a couple of minutes.
          capturedAt: point.capturedAt,
          note,
          emergencyNumber: sosEmergency?.number ?? null,
        });

        // Only worth saying when it changes what the sender should do next:
        // "nobody's phone lit up" reads very differently if two inboxes got it.
        // And a contact with no address is named rather than skipped in
        // silence — "Emailed 0" with no reason is what made a broken email
        // channel look like a working one.
        const mailNote =
          (mail.emailed > 0 ? ` Emailed ${mail.emailed}.` : "") +
          (mail.withoutEmail.length > 0
            ? ` No email on file for ${formatNameList(mail.withoutEmail)}.`
            : "");

        // Emitted after the email fallback so it reports the alert's real
        // outcome rather than the push channel's. An SOS where every push
        // failed but two inboxes received it is not an alert that reached
        // nobody, and recording it as one would point the investigation at
        // exactly the wrong thing.
        trackSosTriggered({
          selectedCount: totalSelected,
          reachedCount: reached,
          unreachableCount: unreachable.length + skipped,
          emailedCount: mail.emailed,
          note,
        });

        if (reached === 0) {
          const stillNoOne = mail.emailed === 0;
          toast.error(
            stillNoOne
              ? `Location shared, but no one was alerted — ${formatNameList(unreachable)} ${unreachable.length === 1 ? "has" : "have"} notifications off. Call emergency services if you need help now.`
              : `No phones lit up — ${formatNameList(unreachable)} ${unreachable.length === 1 ? "has" : "have"} notifications off.${mailNote} Call emergency services if you need help now.`,
          );
        } else if (unreachable.length > 0) {
          toast.warning(
            `Alerted ${reached} of ${readyRecipients.length} contacts. Couldn't reach ${formatNameList(unreachable)} — notifications are off on their end.${mailNote}`,
          );
        } else {
          toast.success(
            skipped > 0
              ? `Alerted ${readyRecipients.length} of ${totalSelected} contacts (${skipped} not ready).${mailNote}`
              : `Alerted ${readyRecipients.length} contact(s).${mailNote}`,
          );
        }
        void refresh().catch(() => null);
      } catch (error) {
        // Recover from memory — SosPanicError carries any partial incident
        // in-process, so the SOS banner stays up even if localStorage failed.
        if (error instanceof SosPanicError && error.partialIncident) {
          setSosIncident(error.partialIncident);
        }
        // Reported as reaching nobody, because on this path we genuinely cannot
        // tell. `SosPanicError.partialIncident` carries only grant ids, not
        // per-recipient delivery, so some contacts may in fact have been
        // alerted before the throw. Biasing an unobservable emergency outcome
        // toward failure is the right way round: it surfaces for investigation
        // rather than being averaged away, which a guessed number would do.
        trackSosTriggered({
          selectedCount: totalSelected,
          reachedCount: 0,
          unreachableCount: totalSelected,
          note,
        });
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
      trackSosTriggered,
      // The local emergency number is read at send time so the email can tell
      // the recipient which number to dial where the sender is.
      sosEmergency?.number,
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
          void refresh().catch(() => null);
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

  const handleAddSmsCircle = useCallback(
    async (circleId: string) => {
      if (!auth.userId || !vaultOwnerToken || busy) return;
      setBusy(`sms-circle:${circleId}`);
      try {
        const circle = await OneLocationService.getCircle({
          vaultOwnerToken,
          circleId,
        });
        const selection = resolveCircleRecipientSelection({
          circle,
          currentUserId: auth.userId,
          requirePhoneVerified: true,
        });
        const alreadySelected = new Set(smsContactUserIds);
        const targets = selection.ready.filter(
          (target) => !alreadySelected.has(target.recipient.userId),
        );
        if (!targets.length) {
          toast.message(
            selection.ready.length
              ? `${selection.circle.name} is already in your SMS contacts.`
              : `${selection.circle.name} has no members ready for SMS yet.`,
          );
          return;
        }

        const results = await Promise.allSettled(
          targets.map((target) =>
            OneLocationService.addSmsContact({
              vaultOwnerToken,
              recipientUserId: target.recipient.userId,
            }),
          ),
        );
        const addedUserIds = targets
          .filter((_, index) => results[index]?.status === "fulfilled")
          .map((target) => target.recipient.userId);
        const failedCount = targets.length - addedUserIds.length;

        if (addedUserIds.length) {
          OneLocationStateResource.replaceSmsContactUserIds(auth.userId, [
            ...new Set([...smsContactUserIds, ...addedUserIds]),
          ]);
        }
        await refresh({ background: true });

        const unavailableCount = selection.excluded.filter(
          (item) => item.reason !== "self",
        ).length;
        if (failedCount) {
          toast.error(
            `Added ${addedUserIds.length} of ${targets.length} Circle members. ${failedCount} could not be added.`,
          );
        } else {
          toast.success(
            `Added ${peopleCountLabel(addedUserIds.length)} from ${selection.circle.name}${
              unavailableCount
                ? `; ${unavailableCount} not ready and left out`
                : ""
            }.`,
          );
        }
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(
            error,
            "Could not add this Circle to SMS contacts.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [
      auth.userId,
      busy,
      refresh,
      smsContactUserIds,
      vaultOwnerToken,
    ],
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
          void refresh().catch(() => null);
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
          // Prints its own message below.
          announce: false,
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
        void refresh().catch(() => null);
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
    ): Promise<OneLocationViewOutcome> => {
      if (!auth.userId || !vaultOwnerToken) return "skipped";
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
            // Live share, no point published yet. The backend reports this as a
            // success (see `allow_empty` in OneLocationService.viewEnvelope), so
            // there is nothing to decrypt and nothing has gone wrong.
            if (!response.envelope) return null;
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
        if (!point) {
          // Live share, first point not published yet. This is a success, not a
          // failure: hold the calm waiting copy and let the caller drop this
          // grant to the slow cadence until the owner actually publishes.
          setGrantViewErrors((current) => {
            const waiting = awaitingFirstPublishMessage(grant);
            return current[grant.id]?.message === waiting
              ? current
              : {
                  ...current,
                  [grant.id]: { message: waiting, tone: "waiting" },
                };
          });
          if (!silent) toast.message(awaitingFirstPublishMessage(grant));
          return "awaiting";
        }
        // A stationary owner republishes the same point every heartbeat, so most
        // ticks decrypt to something identical to what is already on screen.
        // Writing it anyway would allocate a new workspace object and re-render
        // this whole surface every few seconds for no visible change.
        setDecryptedPoints((current) =>
          samePlainLocationPoint(current[grant.id], point)
            ? current
            : { ...current, [grant.id]: point },
        );
        // Recovered — clear any prior "ask them to share again" state.
        setGrantViewErrors((current) => {
          if (!(grant.id in current)) return current;
          const next = { ...current };
          delete next[grant.id];
          return next;
        });
        // The receiving half of activation. A person who is only ever shared
        // with -- the invited friend, which is the whole viral loop -- is still
        // an active user of a sharing product, and counted as un-activated
        // until this fires.
        trackLocationShareReceived();
        return "published";
      } catch (error) {
        const keyUnavailable =
          error instanceof Error &&
          error.message === RECIPIENT_KEY_UNAVAILABLE_MESSAGE;
        // Legacy shape of the same "not ready yet" state: a backend that predates
        // `allow_empty` answers 404 LOCATION_ENVELOPE_MISSING instead of a 200
        // with a null envelope. This branch must stay for as long as a client
        // can reach an older backend — including the window during a rollout
        // where the webapp ships ahead of the Python service.
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
            [grant.id]: {
              message: `Couldn't open ${receivedGrantOwnerLabel(
                grant,
              )}'s live location — the secure key changed. Ask them to share again.`,
              tone: "blocked",
            },
          }));
          return "error";
        }
        if (envelopeMissing) {
          // Calm, reassuring "waiting for their first update" state. The share
          // is genuinely active; the point simply hasn't arrived yet and will
          // appear automatically on the next poll once the owner publishes.
          const waitingMessage = awaitingFirstPublishMessage(grant);
          setGrantViewErrors((current) =>
            current[grant.id]?.message === waitingMessage
              ? current
              : {
                  ...current,
                  [grant.id]: { message: waitingMessage, tone: "waiting" },
                },
          );
          // Only nudge with a gentle (non-error) toast on an explicit tap, and
          // never on the background poll, so the page stays quiet while waiting.
          if (!silent) {
            toast.message(waitingMessage);
          }
          return "awaiting";
        }
        const genericMessage =
          error instanceof Error && error.message
            ? error.message
            : "Could not view this private location update.";
        if (!silent) {
          toast.error(genericMessage);
          // The person tapped View and it failed. A toast disappears, so also
          // leave the reason on the card itself -- otherwise tapping again is
          // the only way to find out anything, which is how a recipient ends
          // up retrying the same broken share over and over.
          setGrantViewErrors((current) => ({
            ...current,
            [grant.id]: { message: genericMessage, tone: "blocked" },
          }));
        } else {
          // Stay quiet on the background poll. A transient network blip must
          // not paint an alert every five seconds over content that is about
          // to refresh itself; the same reasoning governs the page-level load
          // banner. An explicit tap is what promotes this to something the
          // person sees.
          console.warn(
            "[OneLocationAgent] Silent location refresh skipped:",
            error,
          );
        }
        return "error";
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
      const next: Record<string, GrantViewStatus> = {};
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
        // Read the shared position rather than forcing a second acquisition.
        //
        // The movement watch below already feeds the bus every fix the device
        // produces, so the bus snapshot IS the newest position that exists. A
        // competing one-shot here made the point less current, not more: on
        // iOS it raced that watch for the plugin's single pending-call slot,
        // and on web getCurrentPosition can spend ~23s — longer than this
        // interval. Every lost race threw, and this loop reported "could not
        // get your location" once a tick while the watch was delivering.
        const point = await liveHeartbeatPoint();
        // Nothing measured this session. The watch will deliver; a recipient
        // watching a live dot must never be shown a remembered coordinate,
        // and there is nothing here to tell the owner.
        if (!point) return;
        if (!automaticPrivatePublishingAllowedRef.current) return;
        // Every grant is published independently. Sharing this loop's failure
        // between recipients is what made "share with several people" look
        // broken: the catch used to sit outside, so one recipient who threw
        // aborted the whole tick — and because the grant order is stable, the
        // SAME recipient threw on every tick and everyone after them in the
        // list was starved permanently. The first person kept moving; nobody
        // else ever updated again.
        await Promise.all(
          activeOwnerGrants.map(async (grant) => {
            if (!automaticPrivatePublishingAllowedRef.current) return;
            const recipient = recipientForGrant(grant);
            if (!recipient?.keyId || !recipient.publicKeyJwk) {
              // The grant is frozen against one recipient key and the backend
              // rejects an envelope sealed with any other, so we cannot
              // substitute a current key here. Say so instead of skipping in
              // silence — this is a share that will never update again.
              console.warn(
                "[OneLocationAgent] No usable recipient key for grant; live updates cannot resume until they share again:",
                grant.id,
              );
              return;
            }
            try {
              await publishEnvelopeWithRetry(
                grant,
                recipient,
                "foreground_interval",
                point,
              );
            } catch (error) {
              console.warn(
                "[OneLocationAgent] Live update failed for one recipient:",
                error,
              );
            }
          }),
        );
      } catch (error) {
        // Only worth the owner's attention when the platform refused or we
        // hold no position at all. A failed refresh while a share is running
        // on a good fix is not news they can act on — and re-reading
        // permission on every one of those cost a platform round trip every
        // twenty seconds for a value nothing on this path reads.
        if (
          shouldWarnOnPublishFailure({
            error,
            snapshot: LocationBus.getState().snapshot,
            observedDenial: observedLocationDenialRef.current,
          })
        ) {
          console.warn(
            "[OneLocationAgent] Foreground live update skipped:",
            error,
          );
        }
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
    locationControl.paused,
    permission?.state,
    publishEnvelopeWithRetry,
    recipientForGrant,
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
        // Per-recipient isolation, as in the interval publisher above: one
        // recipient throwing must not stop the others from seeing this move,
        // and must not hold back `lastPublishedPointRef` — leaving that stale
        // made the movement gate re-fire the same failing publish forever.
        await Promise.all(
          activeOwnerGrants.map(async (grant) => {
            if (!automaticPrivatePublishingAllowedRef.current) return;
            const recipient = recipientForGrant(grant);
            if (!recipient?.keyId || !recipient.publicKeyJwk) return;
            try {
              const driven = await drivePointForGrant(grant, point);
              const pointForGrant = pickupPointForGrant(grant, driven);
              await publishEnvelopeWithRetry(
                grant,
                recipient,
                "foreground_interval",
                pointForGrant,
              );
            } catch (error) {
              console.warn(
                "[OneLocationAgent] Live movement update failed for one recipient:",
                error,
              );
            }
          }),
        );
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
        activeGrantCount: activeOwnerGrants.length,
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
    locationControl.paused,
    locationControl.selfPreviewEnabled,
    activeOwnerGrants.length,
    permission?.state,
    setMyLocationPoint,
  ]);

  // Latest-value refs for the recipient poll below. The poll must survive on a
  // single long-lived interval: keying its effect on the grant objects and the
  // `viewGrantEnvelope` identity tore the timer down and rebuilt it on every
  // render, and each rebuild fires an immediate sweep — so a render burst became
  // a request burst at the backend (visible as clusters of back-to-back reads
  // between the honest 5s ticks). These refs let the effect depend only on the
  // grant id list, which changes when the set of shares genuinely changes.
  useEffect(() => {
    visibleReceivedGrantsRef.current = activeVisibleReceivedGrants;
    viewGrantEnvelopeRef.current = viewGrantEnvelope;
  });

  const visibleReceivedGrantKey = useMemo(
    () => activeVisibleReceivedGrants.map((grant) => grant.id).join(","),
    [activeVisibleReceivedGrants],
  );
  const liveViewPollBlocked = Boolean(busy && busy !== "load");

  useEffect(() => {
    if (!visibleReceivedGrantKey) return;
    if (liveViewPollBlocked) return;

    const refreshVisibleGrants = async () => {
      const now = Date.now();
      // Checked before the watchdog: a backgrounded tab is throttled by the
      // browser, so an in-flight sweep sitting there is expected, not wedged.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      if (liveViewInFlightRef.current) {
        // Normal overlap: the previous sweep is still running, skip this tick.
        if (now - liveViewStartedAtRef.current < LIVE_VIEW_INFLIGHT_WATCHDOG_MS)
          return;
        // The previous sweep never settled. Without this escape the guard stays
        // latched for the life of the page and live tracking dies silently, with
        // the interval still firing into a permanent no-op.
        console.warn(
          "[OneLocationAgent] Live view sweep exceeded the watchdog; " +
            "releasing the in-flight guard so polling can recover.",
        );
      }

      const grants = visibleReceivedGrantsRef.current;
      const schedule = grantPollScheduleRef.current;
      // Only read shares whose next attempt is actually due. A share that has
      // never published, or one that keeps failing, sits on a slower cadence
      // than a share that is streaming a moving dot.
      const due = grants.filter((grant) => {
        const entry = schedule.get(grant.id);
        return !entry || now >= entry.nextAttemptAt;
      });
      if (!due.length) return;

      // Claim this sweep. If the watchdog above abandoned an earlier one, that
      // earlier sweep may still resolve later — and it must not then clear a
      // guard it no longer owns, which would let two sweeps run concurrently.
      const sweepId = liveViewSweepIdRef.current + 1;
      liveViewSweepIdRef.current = sweepId;
      liveViewInFlightRef.current = true;
      liveViewStartedAtRef.current = now;
      try {
        const view = viewGrantEnvelopeRef.current;
        await Promise.allSettled(
          due.map(async (grant) => {
            // Deliberately NOT gated on `grant.latestEnvelopeId`. That column is
            // a denormalised copy of "has this share ever published", and using
            // it to skip the read would mean one missed write permanently hides
            // a live dot — a far worse failure than an extra request. The
            // cadence below is driven by the response itself, so it self-heals.
            //
            // Defensive: viewGrantEnvelope already resolves rather than rejects
            // for every state it knows about, but a future throw inside it must
            // degrade this grant to backoff — never take down the whole sweep.
            let outcome: OneLocationViewOutcome = "error";
            try {
              outcome = await view(grant, {
                silent: true,
                trigger: "foreground_interval",
              });
            } catch (error) {
              console.warn(
                "[OneLocationAgent] Live view sweep entry failed:",
                error,
              );
            }
            recordGrantPollOutcome(schedule, grant.id, outcome, now);
          }),
        );
      } finally {
        if (liveViewSweepIdRef.current === sweepId) {
          liveViewInFlightRef.current = false;
        }
      }
    };

    // Drop schedule entries for shares that are no longer on screen so a long
    // session cannot accumulate state for revoked/expired grants.
    const liveIds = new Set(visibleReceivedGrantKey.split(","));
    for (const id of [...grantPollScheduleRef.current.keys()]) {
      if (!liveIds.has(id)) grantPollScheduleRef.current.delete(id);
    }

    void refreshVisibleGrants();
    const interval = window.setInterval(() => {
      // A synchronous throw here would kill the interval for the rest of the
      // session, so nothing is allowed to escape the tick.
      try {
        void refreshVisibleGrants();
      } catch (error) {
        console.warn("[OneLocationAgent] Live view tick failed:", error);
      }
    }, LIVE_VIEW_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [visibleReceivedGrantKey, liveViewPollBlocked, setGrantViewErrors]);

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
      enabled: backgroundShareEnabled && !locationControl.paused,
      session,
    });
    return () => {
      void OneLocationService.stopBackgroundShare();
    };
  }, [
    backgroundShareEnabled,
    activeOwnerGrants,
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
        void refresh().catch(() => null);
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

  /**
   * Take back a request you sent, before the other person has answered it.
   *
   * Reported from QA: two requests sent, both rows reading "Asked", and no way
   * off either one -- a wrong person or a changed mind was permanent until the
   * other side happened to answer. Asking is a consent act, so undoing it is
   * the asker's own to make.
   *
   * Its own busy flag, not `revokingGrantId`: that one is keyed by grant, and
   * a pending request has no grant to key on.
   */
  const handleWithdrawRequest = useCallback(
    async (requestId: string) => {
      if (!vaultOwnerToken) return;
      setWithdrawingRequestId(requestId);
      try {
        await OneLocationService.withdrawRequest({
          vaultOwnerToken,
          requestId,
        });
        toast.success("Request taken back.");
        void refresh().catch(() => null);
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(error, "Could not take back request."),
        );
      } finally {
        setWithdrawingRequestId(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  /**
   * Edit a received grant's remaining time -- from any list that shows one
   * (Ask's "already sharing" rows, Requests sent, Shared with me).
   *
   * The owner already agreed to be seen up to the grant's ceiling -- the
   * furthest expiry ever explicitly authorized -- so moving the live expiry
   * anywhere at or under that ceiling applies immediately, whichever
   * direction it moves ("shorten" or "grow"). Shrinking a 1-hour share to 15
   * minutes and then back up to 30 is still inside what was already agreed,
   * so it needs nobody's permission a second time. Only a candidate PAST the
   * ceiling grows how long the recipient can see the owner, and that is the
   * owner's consent to give again, via a fresh request_access the owner
   * approves like any other.
   *
   * Which one this is gets decided here, from the same expiry the row is
   * already rendering as "30 more min", plus the ceiling that came with it.
   * It used to be decided by calling shorten_grant and waiting for the
   * backend to refuse: every ask-for-more-time paid for a doomed round trip
   * before the real one, which is the "Save is slow" report. The refusal is
   * still handled -- a client clock can disagree with the server's near the
   * boundary -- but it is now the rare correction rather than the normal
   * path.
   */
  const handleEditGrantDuration = useCallback(
    async (
      params: { ownerUserId: string; grantId: string; ownerLabel: string },
      durationHours: number,
    ) => {
      if (!vaultOwnerToken) return;
      const { ownerUserId, grantId, ownerLabel } = params;
      const grant = activeReceivedGrants.find((row) => row.id === grantId);
      // Its own flag, not the revoke one. Sharing `revokingGrantId` made
      // saving a duration disable that row's Remove button, and a save that
      // returned early left the flag set for good -- so the next Edit on
      // that person opened with Save already spinning and permanently
      // disabled. That is the "save button takes more time" report.
      setSavingGrantId(grantId);
      try {
        const intent = grantDurationEditIntent({
          grant,
          durationHours,
          nowMs: Date.now(),
        });
        // Save on a picker still showing what the share already has left is
        // not a change. It used to spend a refused shorten and then ask the
        // owner for one more minute of their location, and report that as
        // "Asked ... for more time" over a row whose time never moved.
        if (intent === "unchanged") {
          setEditingGrantId(null);
          return;
        }
        if (intent === "shorten" || intent === "grow") {
          try {
            await OneLocationService.shortenGrant({
              vaultOwnerToken,
              grantId,
              durationHours,
            });
            toast.success(
              intent === "grow" ? "Time updated." : "Access shortened.",
            );
            setEditingGrantId(null);
            // Held until the list has actually reconciled, so this grant is
            // not savable again against the expiry it just replaced.
            await refresh({ background: true }).catch(() => null);
            return;
          } catch (error) {
            if (apiErrorCode(error) !== "LOCATION_GRANT_SHORTEN_ONLY") {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Couldn't change the time. Try again.",
              );
              return;
            }
            // The backend says this is past what was approved (a stale
            // ceiling/expiry read, or a genuine excess). Fall through and ask.
          }
        }
        // Extending needs the owner's approval again -- send a new request
        // rather than silently lengthening the existing grant.
        try {
          // The amount travels WITH the request now. This used to send the
          // literal string "Requesting more time." and nothing else, so the
          // number the person had just chosen from the picker directly above
          // this button was the one fact the owner never received.
          const durationLabel = formatLocationDurationLabel(durationHours);
          await OneLocationService.requestAccess({
            vaultOwnerToken,
            ownerUserId,
            message: durationLabel
              ? `Requesting ${durationLabel} more of your live location.`
              : "Requesting more time.",
            requestedDurationHours: durationHours,
            requestedDurationMode: "timed",
            extendsGrantId: grantId,
          });
          toast.success(
            durationLabel
              ? `Asked ${ownerLabel} for ${durationLabel} more.`
              : `Asked ${ownerLabel} for more time.`,
          );
          setEditingGrantId(null);
          await refresh({ background: true }).catch(() => null);
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : `Couldn't ask ${ownerLabel} for more time. Try again.`,
          );
        }
      } finally {
        setSavingGrantId(null);
      }
    },
    [activeReceivedGrants, refresh, vaultOwnerToken],
  );

  /**
   * Open the live share card's time editor, seeded on what the share has left.
   *
   * Seeded, not defaulted: an editor that always opens on "1 hour" is not
   * showing the share, and Save on that untouched field silently becomes a
   * change nobody asked for. The wheel snaps to its own 15-minute grid, so the
   * value we hold has to be snapped too, or the screen and the save disagree.
   */
  const handleEditLiveShareDurationStart = useCallback(() => {
    const grantId = liveShareStatus?.stoppableGrantId;
    const grant = grantId
      ? activeOwnerGrants.find((row) => row.id === grantId)
      : undefined;
    if (grant?.durationMode === "until_stopped") {
      setLiveShareDurationHours("until_stopped");
    } else {
      const remaining = grantRemainingHours(grant, Date.now());
      setLiveShareDurationHours(
        snapToWheelDurationHours(
          remaining && remaining > 0 ? remaining : Number(GRANT_EDIT_DURATION_FALLBACK),
        ),
      );
    }
    setLiveShareDurationEditing(true);
  }, [activeOwnerGrants, liveShareStatus?.stoppableGrantId]);

  const handleSaveLiveShareDuration = useCallback(async () => {
    const grantId = liveShareStatus?.stoppableGrantId;
    if (!vaultOwnerToken || !grantId) return;
    const grant = activeOwnerGrants.find((row) => row.id === grantId);
    const untilStopped = liveShareDurationHours === "until_stopped";
    const durationHours = untilStopped ? null : Number(liveShareDurationHours);

    // Save on a wheel still showing what the share already has left is not a
    // change. Sending it anyway spends a round trip, writes an audit row, and
    // pushes the recipient an alert about a time that did not move.
    if (
      durationHours !== null &&
      grant?.durationMode !== "until_stopped" &&
      grantDurationEditIntent({
        grant,
        durationHours,
        nowMs: Date.now(),
      }) === "unchanged"
    ) {
      setLiveShareDurationEditing(false);
      return;
    }

    setLiveShareDurationSaving(true);
    try {
      await OneLocationService.setGrantDuration({
        vaultOwnerToken,
        grantId,
        durationHours,
        durationMode: untilStopped ? "until_stopped" : "timed",
      });
      toast.success("Time updated.");
      setLiveShareDurationEditing(false);
      // Held until the list has reconciled, so the card's countdown is already
      // reading the new expiry when the editor closes.
      await refresh({ background: true }).catch(() => null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't change the time. Try again.",
      );
    } finally {
      setLiveShareDurationSaving(false);
    }
  }, [
    activeOwnerGrants,
    liveShareDurationHours,
    liveShareStatus?.stoppableGrantId,
    refresh,
    vaultOwnerToken,
  ]);

  // A share that ends, or a second share starting, takes the single grant this
  // editor was opened against out from under it. Closing is the honest answer:
  // the wheel would otherwise still be pointing at a share that is gone.
  useEffect(() => {
    if (!liveShareStatus?.stoppableGrantId) setLiveShareDurationEditing(false);
  }, [liveShareStatus?.stoppableGrantId]);

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
      void refresh().catch(() => null);
    } catch {
      /* refresh failure is non-fatal; sharing has already been stopped */
    }
  }, [refresh, sosIncident, vaultOwnerToken]);

  // Lets the "Check more" remedy re-run the sync (and so reopen the web
  // Contact Picker) without the callback having to reference itself.
  const handleSyncContactSignalRef = useRef<(() => Promise<void>) | null>(null);

  // Onboarding's own contacts step. It reuses the same matcher as the hub, but
  // returns a typed result instead of driving hub state: onboarding needs to
  // render the matches inline, and the contact-permission prompt is fired by a
  // deliberate tap on that screen rather than by opening the app.
  // Can this device read an address book at all? A desktop browser without the
  // Contact Picker reports "unavailable", and onboarding then skips the step
  // instead of showing a screen whose only content is that it cannot work.
  // Assume it can until proven otherwise, so a slow plugin never costs the step
  // on a phone that does support it.
  const [contactsStepAvailable, setContactsStepAvailable] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void HushhContacts.getPermissionState()
      .then((state) => {
        if (!cancelled && state?.state === "unavailable") {
          setContactsStepAvailable(false);
        }
      })
      .catch(() => {
        // No plugin at all is the same answer as "unavailable".
        if (!cancelled) setContactsStepAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSyncOnboardingContacts =
    useCallback(async (): Promise<OnboardingContactSyncResult> => {
      const idToken = await auth.user?.getIdToken();
      if (!idToken) {
        return {
          status: "failed",
          message: "Sign in to check your contacts.",
          canOpenSettings: false,
        };
      }
      try {
        const result = await syncOneLocationContactSignals({
          idToken,
          accountPhoneNumber: auth.user?.phoneNumber,
        });
        const matches = result.matches
          .map((match) => ({
            userId: match.user_id,
            displayName: match.display_name,
          }))
          .filter((match) => match.userId && match.userId !== auth.userId);
        trackEvent("one_location_contact_signal_synced", {
          route_id: "one_location",
          result: "success",
          source_platform: result.sourcePlatform,
          contact_count_bucket: contactCountBucket(result.totalContacts),
          matched_count: matches.length,
          invite_candidate_count: result.inviteCandidateCount,
          contact_region: result.region ?? "unknown",
          partial_access: result.limited,
          truncated: result.truncated,
        });
        if (matches.length > 0) return { status: "matched", matches };
        // A partial read is not proof that nobody matched -- the web picker and
        // iOS limited access only ever return a hand-picked subset.
        return { status: "none", partial: result.limited };
      } catch (error) {
        const failure =
          error instanceof OneLocationContactSyncError ? error.failure : "error";
        const canOpenSettings =
          failure === "denied" || failure === "restricted";
        return {
          status: "failed",
          message:
            failure === "denied"
              ? "One does not have access to your contacts yet."
              : failure === "restricted"
                ? "Contact access is restricted on this device."
                : failure === "unavailable"
                  ? "Reading contacts is not available here. You can add people later from the People tab."
                  : "We couldn't check your contacts. You can try again later.",
          canOpenSettings,
        };
      }
    }, [auth.user, auth.userId]);

  const handleAddOnboardingContact = useCallback(
    async (addresseeUserId: string) => {
      const idToken = await auth.user?.getIdToken();
      if (!idToken) throw new Error("Sign in to add people.");
      await ConnectionsService.sendRequest({
        idToken,
        addresseeUserId,
        message: "I would like to add you to my private Location circle.",
      });
    },
    [auth.user],
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
      const result = await syncOneLocationContactSignals({
        idToken,
        // Tells the normalizer which region a bare "9876543210" belongs to.
        // Without it every 10-digit contact was read as North American.
        accountPhoneNumber: auth.user.phoneNumber,
      });
      const nextStatus: OneLocationContactSignalStatus =
        result.matchedUserIds.length > 0 ? "matched" : "empty";
      setContactSignal({
        status: nextStatus,
        matchedUserIds: result.matchedUserIds,
        matchedCount: result.matchedUserIds.length,
        totalContacts: result.totalContacts,
        inviteCandidateCount: result.inviteCandidateCount,
        sourcePlatform: result.sourcePlatform,
        limited: result.limited,
        truncated: result.truncated,
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
        contact_region: result.region ?? "unknown",
        partial_access: result.limited,
        truncated: result.truncated,
      });
      // A partial read must never be reported as a whole one. The web Contact
      // Picker and iOS limited access both return only a hand-picked subset,
      // so "3 people added" would claim the whole address book was searched.
      const outcome = describeContactSyncOutcome(result);
      const outcomeOptions = {
        description: outcome.description,
        ...(outcome.remedy === "pick_more"
          ? {
              action: {
                label: "Check more",
                // Re-running the sync reopens the picker. There is no settings
                // page to send a browser to; openAppSettings resolves false.
                onClick: () => void handleSyncContactSignalRef.current?.(),
              },
            }
          : outcome.remedy === "open_settings"
            ? {
                action: {
                  label: "Open Settings",
                  onClick: () => void openContactPermissionSettings(),
                },
              }
            : {}),
      };
      if (result.matchedUserIds.length > 0) {
        toast.success(outcome.title, outcomeOptions);
      } else {
        toast.info(outcome.title, outcomeOptions);
      }
    } catch (error) {
      const failure =
        error instanceof OneLocationContactSyncError ? error.failure : "error";
      const message = oneLocationErrorMessage(
        error,
        "Could not sync contacts.",
      );
      setContactSignal((current) => ({
        ...current,
        status: failure,
        error: message,
        syncedAt: new Date().toISOString(),
      }));
      trackEvent("one_location_contact_signal_synced", {
        route_id: "one_location",
        result: failure === "error" ? "error" : "expected_error",
        source_platform: contactSignal.sourcePlatform ?? "unknown",
        contact_count_bucket: contactCountBucket(contactSignal.totalContacts),
        matched_count: contactSignal.matchedCount,
        invite_candidate_count: contactSignal.inviteCandidateCount,
        failure_reason: failure,
      });
      if (failure === "denied") {
        // The OS will not prompt again, so a retry button would do nothing.
        // Settings is the only route back.
        toast.error(message, {
          action: {
            label: "Open Settings",
            onClick: () => void openContactPermissionSettings(),
          },
        });
      } else if (failure === "unavailable") {
        toast.info(message);
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(null);
    }
  }, [auth.user, contactSignal]);

  useEffect(() => {
    handleSyncContactSignalRef.current = handleSyncContactSignal;
  }, [handleSyncContactSignal]);

  // Resolves true only when at least one request actually reached the server.
  // The Ask screen latches its "Request sent." confirmation on this, so a failed
  // send can never leave a success message on screen (it used to latch
  // optimistically the moment the button was tapped).
  const handleRequestAccess = useCallback(async (reason?: string | null) => {
    if (!vaultOwnerToken || !selectedRequestOwners.length) return false;
    if (!auth.user || !auth.userId) {
      toast.error("Refresh your session before sending a location request.");
      return false;
    }
    const activeUser = auth.user;
    const activeUserId = auth.userId;
    const activeVaultOwnerToken = vaultOwnerToken;
    setBusy("request");
    let successCount = 0;
    const sentUserIds: string[] = [];
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
        // Send the duration the person actually picked. The Ask screen has
        // shown a "Duration requested" control all along; it was collected
        // and then dropped here, so the owner was asked an unquantified
        // question and approved whatever their own control happened to say.
        await OneLocationService.requestAccess({
          vaultOwnerToken: activeVaultOwnerToken,
          ownerUserId: owner.userId,
          message: buildOneLocationRequestMessage(reason, requestMessage),
          requestedDurationHours: Number(durationHours),
          requestedDurationMode: "timed",
        });
        successCount += 1;
        // Recorded as each one lands, not from the selection up front: an id the
        // recipient list cannot resolve is never actually sent, and subtracting
        // it anyway would clear a person nobody asked.
        sentUserIds.push(owner.userId);
      }
      trackEvent("one_location_request_sent", {
        route_id: "one_location",
        result: oneLocationEventResult(successCount, 0),
        selected_count: selectedRequestOwners.length,
        success_count: successCount,
        failure_count: 0,
        has_note: Boolean(requestMessage.trim()),
      });
      resetRequestComposer(sentUserIds);
      playOneLocationNotificationSound();
      toast.success(
        selectedRequestOwners.length === 1
          ? "Request sent. We'll notify you here when they respond."
          : `Requests sent to ${peopleCountLabel(
              selectedRequestOwners.length,
            )}. We'll notify you here when they respond.`,
      );
      void refresh().catch(() => null);
      return true;
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
      // Partial success still counts: the people who were asked really were
      // asked, and their rows now read "Asked". Only a total failure denies the
      // confirmation.
      return successCount > 0;
    } finally {
      setBusy(null);
    }
  }, [
    auth.user,
    auth.userId,
    // The request now carries the duration this composer is showing, so the
    // callback has to be rebuilt when that changes -- otherwise it closes over
    // the value the screen opened with and sends a stale amount.
    durationHours,
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
      // Goes through the same readiness gate as every other share entry point.
      // Reaching for the device directly is what left this control with no way
      // to say "your location is off" — it could only spin and then fail.
      const readiness = await ensureForegroundLocationReady({
        capturePoint: true,
        autoOpenSettings: true,
      });
      if (!readiness.ready || !readiness.point) return;
      const point = readiness.point;
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: publicInviteDurationHours(durationHours),
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
      void refresh().catch(() => null);
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
  }, [
    activePublicInvites.length,
    durationHours,
    ensureForegroundLocationReady,
    refresh,
    vaultOwnerToken,
  ]);

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
      if (isShareCancellationError(error)) return;
      toast.error("Could not open the share sheet.");
    }
  }, [publicInviteUrl]);

  const handleShareContactInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("contactInvite");
    try {
      let url = publicInviteUrl;
      if (!url) {
        const readiness = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
        });
        if (!readiness.ready || !readiness.point) return;
        const point = readiness.point;
        const response = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: publicInviteDurationHours(durationHours),
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
        void refresh().catch(() => null);
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
      if (isShareCancellationError(error)) return;
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
    ensureForegroundLocationReady,
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
        durationHours: inviteDurationHours(
          durationHours,
          CIRCLE_INVITE_MAX_DURATION_HOURS,
        ),
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
      trackLocationFunnelStepCompleted("invite_shared");
      toast.success(
        copiedToClipboard
          ? "Invite to One link created and copied."
          : "Invite to One link created.",
      );
      void refresh().catch(() => null);
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
      if (isShareCancellationError(error)) return;
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
        void refresh().catch(() => null);
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

  const scheduleNamedCircleStateRefresh = useCallback(() => {
    const activeUserId = auth.userId;
    if (!activeUserId) return;
    const priorRefresh = refreshInFlightRef.current;
    OneLocationStateResource.invalidate(activeUserId);
    void (async () => {
      if (priorRefresh) await priorRefresh;
      await refresh({ background: true });
    })();
  }, [auth.userId, refresh]);

  const refreshIncomingCircleMemberInvites = useCallback(async () => {
    const requestId = ++circleMemberInviteRequestRef.current;
    if (!vaultOwnerToken) {
      setIncomingCircleMemberInvites([]);
      setIncomingCircleMemberInvitesLoading(false);
      setIncomingCircleMemberInvitesError(null);
      setResolvedCircleMemberInviteFocusId(null);
      return;
    }
    setIncomingCircleMemberInvitesLoading(true);
    setIncomingCircleMemberInvitesError(null);
    if (focusedCircleMemberInviteId) {
      setResolvedCircleMemberInviteFocusId(null);
    }
    try {
      const invites = await OneLocationService.listNamedCircleMemberInvites({
        vaultOwnerToken,
        direction: "incoming",
        status: "pending",
      });
      if (requestId === circleMemberInviteRequestRef.current) {
        setIncomingCircleMemberInvites(invites);
        setResolvedCircleMemberInviteFocusId(focusedCircleMemberInviteId);
      }
    } catch {
      if (requestId === circleMemberInviteRequestRef.current) {
        setIncomingCircleMemberInvitesError(
          "Check your connection and try loading the invitations again.",
        );
      }
    } finally {
      if (requestId === circleMemberInviteRequestRef.current) {
        setIncomingCircleMemberInvitesLoading(false);
      }
    }
  }, [focusedCircleMemberInviteId, vaultOwnerToken]);

  useEffect(() => {
    void refreshIncomingCircleMemberInvites();
    return () => {
      circleMemberInviteRequestRef.current += 1;
    };
  }, [refreshIncomingCircleMemberInvites, state]);

  const handleLoadNamedCircle = useCallback(
    async (circleId: string): Promise<OneLocationCircleDetail> => {
      if (!vaultOwnerToken) throw new Error("Unlock One before opening a Circle.");
      try {
        return await OneLocationService.getCircle({
          vaultOwnerToken,
          circleId,
        });
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not load this Circle."),
        );
      }
    },
    [vaultOwnerToken],
  );

  const handleResolveNamedCircleRecipients = useCallback(
    async (
      circleId: string,
      purpose: "location" | "sms" = "location",
    ): Promise<CircleRecipientSelection> => {
      const circle = await handleLoadNamedCircle(circleId);
      return resolveCircleRecipientSelection({
        circle,
        currentUserId: auth.userId,
        requirePhoneVerified: purpose === "sms",
      });
    },
    [auth.userId, handleLoadNamedCircle],
  );

  const handleSelectNamedCircleForShare = useCallback(
    async (circleId: string) => {
      // Tapping an already-selected Circle clears it. But a Circle whose members
      // have been individually deselected below no longer reads as selected, so
      // the same tap has to re-apply the roster instead of clearing the leftovers.
      if (
        selectedShareCircleSelection?.circle.id === circleId &&
        isCircleSelectionFullySelected(
          selectedShareCircleSelection,
          selectedRecipientIds,
        )
      ) {
        setSelectedShareCircleSelection(null);
        setNamedCircleShareContext(null);
        setSelectedRecipientId("");
        setSelectedRecipientIds([]);
        setShareReviewOpen(false);
        return;
      }

      setBusy(`shareCircle:${circleId}`);
      try {
        const selection =
          await handleResolveNamedCircleRecipients(circleId, "location");
        const recipientUserIds = selection.ready.map(
          (target) => target.recipient.userId,
        );
        if (!recipientUserIds.length) {
          throw new Error(
            "No current Circle members are ready to receive encrypted location.",
          );
        }
        setSelectedShareCircleSelection(selection);
        setNamedCircleShareContext({
          circleId: selection.circle.id,
          circleName: selection.circle.name,
          recipientUserIds,
        });
        setSelectedRecipientId(recipientUserIds[0] ?? "");
        setSelectedRecipientIds(recipientUserIds);
        setShareReviewOpen(false);
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(
            error,
            "Could not load this Circle for sharing.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [
      handleResolveNamedCircleRecipients,
      selectedRecipientIds,
      selectedShareCircleSelection,
      setSelectedRecipientIds,
    ],
  );

  const handleCreateNamedCircle = useCallback(
    async (
      name: string,
      kind: OneLocationCircleKind,
    ): Promise<OneLocationCircleDetail> => {
      if (!vaultOwnerToken) throw new Error("Unlock One before creating a Circle.");
      setBusy("namedCircle");
      try {
        const circle = await OneLocationService.createNamedCircle({
          vaultOwnerToken,
          name,
          kind,
        });
        scheduleNamedCircleStateRefresh();
        // The kind, never the name — a Circle name is the user's own words and
        // often identifies a household.
        trackEvent("one_location_circle_created", {
          route_id: "one_location",
          result: "success",
          circle_kind: kind,
        });
        trackLocationFunnelStepCompleted("circle_created");
        toast.success(`${circle.name} created.`);
        return circle;
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not create the Circle."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const handleResolveNamedCircleCode = useCallback(
    async (code: string): Promise<OneLocationCircleInvitePreview> => {
      if (!vaultOwnerToken) throw new Error("Unlock One before joining a Circle.");
      setBusy("namedCircle");
      try {
        return await OneLocationService.resolveNamedCircleCode({
          vaultOwnerToken,
          code,
        });
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(
            error,
            "That Circle code is invalid or no longer available.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [vaultOwnerToken],
  );

  const handleRenameNamedCircle = useCallback(
    async (
      circleId: string,
      name: string,
    ): Promise<OneLocationCircleDetail> => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before changing a Circle.");
      }
      setBusy("namedCircle");
      try {
        const circle = await OneLocationService.updateNamedCircle({
          vaultOwnerToken,
          circleId,
          name,
        });
        scheduleNamedCircleStateRefresh();
        toast.success("Circle name updated.");
        return circle;
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not rename the Circle."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const handleJoinNamedCircle = useCallback(
    async (
      code: string,
    ): Promise<{ circle: OneLocationCircleDetail; joined: boolean }> => {
      if (!vaultOwnerToken) throw new Error("Unlock One before joining a Circle.");
      setBusy("namedCircle");
      try {
        const result = await OneLocationService.joinNamedCircle({
          vaultOwnerToken,
          code,
        });
        scheduleNamedCircleStateRefresh();
        toast.success(
          result.joined
            ? `Joined ${result.circle.name}.`
            : `${result.circle.name} is already in your Circles.`,
        );
        return result;
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not join the Circle."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const handleGenerateNamedCircleCode = useCallback(
    async (
      circleId: string,
      rotate = false,
    ): Promise<OneLocationCircleInviteCode> => {
      if (!vaultOwnerToken) throw new Error("Unlock One before inviting people.");
      setBusy("namedCircle");
      try {
        const inviteCode =
          await OneLocationService.createNamedCircleInviteCode({
            vaultOwnerToken,
            circleId,
            rotate,
          });
        toast.success(rotate ? "Invite code rotated." : "Invite code ready.");
        return inviteCode;
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not create an invite code."),
        );
      } finally {
        setBusy(null);
      }
    },
    [vaultOwnerToken],
  );

  const handleCopyNamedCircleCode = useCallback(async (code: string) => {
    if (await copyToClipboard(code)) {
      toast.success("Circle code copied.");
      return;
    }
    toast.error("Could not copy the Circle code.");
  }, []);

  const handleShareNamedCircleCode = useCallback(
    async (circle: OneLocationCircleDetail, code: string) => {
      try {
        // Not window.location.origin: inside the installed iOS/Android build
        // that is a Capacitor scheme, and the link it produced was dead.
        const joinOrigin = resolveCircleJoinOrigin();
        const joinUrl = joinOrigin
          ? buildCircleJoinUrl(joinOrigin, code)
          : undefined;
        const circleLabel = circleShareLabel(circle.name);
        const delivery = await shareNamedCircleCode({
          title: `Join ${circle.name} on One`,
          // The link lives in `url` only. Repeating it inline made share targets
          // that append `url` to `text` (WhatsApp, Messages) deliver it twice.
          text: buildCircleInviteShareText({
            circleLabel,
            code,
            hasJoinLink: Boolean(joinUrl),
          }),
          dialogTitle: "Share Circle code",
          url: joinUrl,
        });
        if (delivery === "copied") toast.success("Circle code copied.");
      } catch (error) {
        if (isShareCancellationError(error)) return;
        toast.error("Could not open the share sheet.");
      }
    },
    [],
  );

  // Onboarding (third screen, before the contact list): find-or-create the
  // person's first owned Circle and return its active, member-visible invite
  // code so a brand-new user can immediately copy/share a joinable code. Called
  // by the onboarding flow when the Invite screen opens. Provisioning is quiet
  // (no create/rotate toasts) since it runs implicitly during setup. The code is
  // re-readable by active members and is never persisted in client storage/URLs.
  const handlePreviewCircleCode = useCallback(
    async (code: string) => {
      const idToken = await auth.user?.getIdToken();
      if (!idToken) throw new Error("Sign in to look up a circle code.");
      const preview = await OneLocationService.previewOnboardingCircleCode({
        idToken,
        code,
      });
      return {
        name: preview.name,
        ownerDisplayName: preview.ownerDisplayName,
        memberCount: preview.memberCount,
        alreadyMember: preview.alreadyMember,
      };
    },
    [auth.user],
  );

  const handleAcceptCircleCode = useCallback(
    async (code: string) => {
      // Redeem now if a vault already exists; otherwise park it. Joining is
      // vault-gated and the vault arrives only when the setup wizard finishes,
      // so the accept and the redeem genuinely cannot be the same moment for a
      // first-run joiner.
      if (vaultOwnerToken) {
        await OneLocationService.joinNamedCircle({ vaultOwnerToken, code });
        scheduleNamedCircleStateRefresh();
        return;
      }
      if (!auth.userId || !rememberPendingCircleJoin(auth.userId, code)) {
        throw new Error(
          "We couldn't hold on to that code here. You can join from Circles once setup finishes.",
        );
      }
    },
    [auth.userId, scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  // Redeem a parked code the moment a vault token exists. Runs once per code:
  // it is cleared before the request so a rejection cannot loop, and a spent or
  // expired code simply fails closed with the circle unjoined.
  useEffect(() => {
    if (!vaultOwnerToken || !auth.userId) return;
    const pending = readPendingCircleJoin(auth.userId);
    if (!pending) return;
    // Recorded before the join is attempted: arriving on someone's circle code
    // is the viral acquisition, whether or not the code turns out to be spent.
    // Without this the invite_source dimension is never populated and viral
    // joins cannot be told apart from cold ones.
    rememberLocationInviteSource("circle_code");
    clearPendingCircleJoin(auth.userId);
    let cancelled = false;
    void OneLocationService.joinNamedCircle({ vaultOwnerToken, code: pending })
      .then((result) => {
        if (cancelled) return;
        scheduleNamedCircleStateRefresh();
        toast.success(`You joined ${result?.circle?.name ?? "the circle"}.`);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(
          "That circle code could not be used. Ask for a fresh one from Circles.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [auth.userId, scheduleNamedCircleStateRefresh, vaultOwnerToken]);

  const handlePrepareOnboardingCircleInvite =
    useCallback(async (): Promise<OnboardingCircleInvite> => {
      const ownerName = String(
        auth.user?.displayName || auth.user?.email || "",
      ).trim();
      const firstName = ownerName.split(/\s+/)[0] || "";
      const defaultCircleName = firstName
        ? `${firstName}'s Circle`
        : "My Circle";

      // No vault yet — the wizard only introduces one once /one/setup finishes,
      // so a first-run person has nothing but their sign-in. Bootstrap does the
      // same find-or-create server-side against their user id, and the Circle
      // rows it writes are the same rows the vault-gated calls below read later:
      // the vault gates access to them, it never stored them.
      if (!vaultOwnerToken) {
        const idToken = await auth.user?.getIdToken();
        if (!idToken) {
          throw new Error("Sign in to prepare your circle code.");
        }
        return OneLocationService.bootstrapOnboardingCircle({
          idToken,
          name: defaultCircleName,
        });
      }

      // Reuse the person's first owned Circle so re-entering onboarding never
      // spawns duplicates; fall back to any membership, else create one.
      let targetCircleId: string | null = null;
      try {
        const circles = await OneLocationService.listCircles(vaultOwnerToken);
        targetCircleId =
          circles.find((circle) => circle.role === "owner")?.id ??
          circles[0]?.id ??
          null;
      } catch {
        // A listing hiccup shouldn't block setup — fall through to create.
        targetCircleId = null;
      }

      let circle: OneLocationCircleDetail;
      if (targetCircleId) {
        circle = await OneLocationService.getCircle({
          vaultOwnerToken,
          circleId: targetCircleId,
        });
      } else {
        circle = await OneLocationService.createNamedCircle({
          vaultOwnerToken,
          name: defaultCircleName,
          kind: "family",
        });
        scheduleNamedCircleStateRefresh();
      }

      let code = circle.activeInviteCode?.code ?? null;
      if (!code) {
        const generated = await OneLocationService.createNamedCircleInviteCode({
          vaultOwnerToken,
          circleId: circle.id,
          rotate: false,
        });
        code = generated.code;
      }
      if (!code) {
        throw new Error("Could not prepare an invite code for your circle.");
      }

      return { circleId: circle.id, circleName: circle.name, code };
    }, [auth.user, scheduleNamedCircleStateRefresh, vaultOwnerToken]);

  // Onboarding invite screen: reuse the same native/web share sheet copy the
  // Circle detail screen uses, so the shared message is consistent everywhere.
  const handleShareOnboardingCircleInvite = useCallback(
    async (invite: OnboardingCircleInvite) => {
      try {
        // See handleShareNamedCircleCode: the live origin is a Capacitor scheme
        // in the installed build, so the shared link has to come from here.
        const joinOrigin = resolveCircleJoinOrigin();
        const joinUrl = joinOrigin
          ? buildCircleJoinUrl(joinOrigin, invite.code)
          : undefined;
        const circleLabel = circleShareLabel(invite.circleName);
        const delivery = await shareNamedCircleCode({
          title: `Join ${invite.circleName} on One`,
          // Link in `url` only — see the note on handleShareNamedCircleCode.
          text: buildCircleInviteShareText({
            circleLabel,
            code: invite.code,
            hasJoinLink: Boolean(joinUrl),
          }),
          dialogTitle: "Share Circle code",
          url: joinUrl,
        });
        if (delivery === "copied") toast.success("Circle code copied.");
      } catch (error) {
        if (isShareCancellationError(error)) return;
        toast.error("Could not open the share sheet.");
      }
    },
    [],
  );

  // Share a Circle's invite code from a surface that only knows the circle id

  // (Check-In, SMS contacts, share composer). Loads the circle, reuses its
  // active member-visible code, and — for members allowed to view/rotate a code
  // when none is cached — generates one on demand before opening the share
  // sheet. Never fabricates a code the viewer is not permitted to see.
  const handleShareNamedCircleCodeById = useCallback(
    async (circleId: string): Promise<void> => {
      const circle = await handleLoadNamedCircle(circleId);
      const capabilities = circle.viewerCapabilities;
      const canViewInviteCode =
        capabilities?.canViewInviteCode ?? circle.role === "owner";
      const canRotateInviteCode =
        capabilities?.canRotateInviteCode ?? circle.role === "owner";
      if (!canViewInviteCode) {
        throw new Error(
          "Ask the Circle owner to share the invite code for this Circle.",
        );
      }
      let code = circle.activeInviteCode?.code ?? null;
      if (!code && canRotateInviteCode) {
        const generated = await handleGenerateNamedCircleCode(circleId, false);
        code = generated.code;
      }
      if (!code) {
        throw new Error(
          "This Circle has no invite code yet. Ask the owner to create one.",
        );
      }
      await handleShareNamedCircleCode(circle, code);
    },
    [
      handleGenerateNamedCircleCode,
      handleLoadNamedCircle,
      handleShareNamedCircleCode,
    ],
  );


  const handleRemoveNamedCircleMember = useCallback(
    async (circleId: string, memberUserId: string) => {
      if (!vaultOwnerToken) throw new Error("Unlock One before changing a Circle.");
      setBusy("namedCircle");
      try {
        await OneLocationService.removeNamedCircleMember({
          vaultOwnerToken,
          circleId,
          memberUserId,
        });
        scheduleNamedCircleStateRefresh();
        toast.success("Member removed.");
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not remove this member."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const handleLoadNamedCircleEligibleConnections = useCallback(
    async (
      circleId: string,
    ): Promise<OneLocationCircleEligibleConnections> => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before inviting people.");
      }
      try {
        return await OneLocationService.listNamedCircleEligibleConnections({
          vaultOwnerToken,
          circleId,
        });
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(
            error,
            "Could not load your eligible connections.",
          ),
        );
      }
    },
    [vaultOwnerToken],
  );

  const handleInviteNamedCircleConnections = useCallback(
    async (circleId: string, inviteeUserIds: string[]) => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before inviting people.");
      }
      if (!inviteeUserIds.length) return;
      setBusy("circleMemberInvite");
      try {
        await OneLocationService.createNamedCircleMemberInvites({
          vaultOwnerToken,
          circleId,
          inviteeUserIds,
        });
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(
            error,
            "Could not send the Circle invitation.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [vaultOwnerToken],
  );

  const handleAcceptNamedCircleMemberInvite = useCallback(
    async (inviteId: string) => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before joining a Circle.");
      }
      setBusy("circleMemberInvite");
      try {
        const circle =
          await OneLocationService.acceptNamedCircleMemberInvite({
            vaultOwnerToken,
            inviteId,
          });
        setIncomingCircleMemberInvites((current) =>
          current.filter((invite) => invite.id !== inviteId),
        );
        dispatchConsentStateChanged({
          action: "circle_member_invite_accepted",
          inviteId,
          source: "one_location_circle_member_invite",
        });
        scheduleNamedCircleStateRefresh();
        toast.success(`Joined ${circle.name}.`);
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not join the Circle."),
        );
      } finally {
        setBusy(null);
        void refreshIncomingCircleMemberInvites();
      }
    },
    [
      refreshIncomingCircleMemberInvites,
      scheduleNamedCircleStateRefresh,
      vaultOwnerToken,
    ],
  );

  const handleDeclineNamedCircleMemberInvite = useCallback(
    async (inviteId: string) => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before changing a Circle invitation.");
      }
      setBusy("circleMemberInvite");
      try {
        await OneLocationService.declineNamedCircleMemberInvite({
          vaultOwnerToken,
          inviteId,
        });
        setIncomingCircleMemberInvites((current) =>
          current.filter((invite) => invite.id !== inviteId),
        );
        dispatchConsentStateChanged({
          action: "circle_member_invite_declined",
          inviteId,
          source: "one_location_circle_member_invite",
        });
        toast.success("Circle invitation declined.");
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(
            error,
            "Could not decline the Circle invitation.",
          ),
        );
      } finally {
        setBusy(null);
        void refreshIncomingCircleMemberInvites();
      }
    },
    [refreshIncomingCircleMemberInvites, vaultOwnerToken],
  );

  const handleCancelNamedCircleMemberInvite = useCallback(
    async (inviteId: string) => {
      if (!vaultOwnerToken) {
        throw new Error("Unlock One before changing a Circle invitation.");
      }
      setBusy("circleMemberInvite");
      try {
        await OneLocationService.cancelNamedCircleMemberInvite({
          vaultOwnerToken,
          inviteId,
        });
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(
            error,
            "Could not cancel the Circle invitation.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [vaultOwnerToken],
  );

  const handleLeaveNamedCircle = useCallback(
    async (circleId: string) => {
      if (!vaultOwnerToken) throw new Error("Unlock One before leaving a Circle.");
      setBusy("namedCircle");
      try {
        await OneLocationService.leaveNamedCircle({
          vaultOwnerToken,
          circleId,
        });
        scheduleNamedCircleStateRefresh();
        toast.success("You left the Circle.");
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not leave the Circle."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const handleDeleteNamedCircle = useCallback(
    async (circleId: string) => {
      if (!vaultOwnerToken) throw new Error("Unlock One before deleting a Circle.");
      setBusy("namedCircle");
      try {
        await OneLocationService.deleteNamedCircle({
          vaultOwnerToken,
          circleId,
        });
        scheduleNamedCircleStateRefresh();
        toast.success("Circle deleted.");
      } catch (error) {
        throw new Error(
          oneLocationErrorMessage(error, "Could not delete the Circle."),
        );
      } finally {
        setBusy(null);
      }
    },
    [scheduleNamedCircleStateRefresh, vaultOwnerToken],
  );

  const prepareNamedCircleShare = useCallback(
    (circleId: string, recipientUserId: string) => {
      setSelectedShareCircleSelection(null);
      setNamedCircleShareContext({
        circleId,
        circleName:
          namedCircles.find((circle) => circle.id === circleId)?.name ??
          "Circle",
        recipientUserIds: [recipientUserId],
      });
      setSelectedRecipientId(recipientUserId);
      setSelectedRecipientIds([recipientUserId]);
      setShareReviewOpen(false);
    },
    [namedCircles, setSelectedRecipientIds],
  );

  const clearNamedCircleShareContext = useCallback(() => {
    setNamedCircleShareContext(null);
    setSelectedShareCircleSelection(null);
  }, []);

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
        void refresh().catch(() => null);
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

  /**
   * Approve one incoming request: grant, then publish the first encrypted
   * point to the person who asked.
   *
   * Shared by the Approve button and by auto-approve, so both take exactly the
   * same path -- the automatic one differs only in what it says afterwards and
   * in not claiming the screen's `busy` slot, which belongs to whatever the
   * person is doing with their hands.
   */
  const approveAccessRequest = useCallback(
    async (
      request: OneLocationAccessRequest,
      options?: { automatic?: boolean },
    ): Promise<boolean> => {
      if (!vaultOwnerToken) return false;
      const automatic = options?.automatic === true;
      const requester = recipients.find(
        (recipient) => recipient.userId === request.requesterUserId,
      );
      if (!requester?.keyId || !requester.publicKeyJwk) {
        if (!automatic) {
          toast.error(
            "They need to open Location once before approval can finish.",
          );
        }
        return false;
      }
      if (!automatic) setBusy("approve");
      try {
        // Grant what they asked for. The owner is answering a request that
        // named an amount -- their own duration control belongs to shares
        // THEY start, and reading it here is how a person who asked for four
        // hours silently got one. Fall back to the owner's control only when
        // the ask carried no amount (older clients, referral requests).
        const requestedHours = Number(request.requestedDurationHours);
        const approvedHours =
          Number.isFinite(requestedHours) && requestedHours > 0
            ? requestedHours
            : Number(durationHours);
        const response = await OneLocationService.approveRequest({
          vaultOwnerToken,
          requestId: request.id,
          durationHours: approvedHours,
          durationMode:
            request.requestedDurationMode === "until_stopped"
              ? "until_stopped"
              : "timed",
        });
        await publishEnvelopeWithRetry(response.grant, requester, "manual");
        // Name the person. An automatic approval is still a share starting
        // without a tap, so it has to be legible as it happens rather than
        // discoverable later in a list.
        toast.success(
          automatic
            ? `Shared with ${recipientLabel(requester)} automatically.`
            : "Request approved and encrypted update published.",
        );
        // Non-blocking, per the latency fix on main: the approval is already
        // done and published, and holding the button through a full state
        // reload only makes it feel slower than it is.
        void refresh().catch(() => null);
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : automatic
              ? `Could not approve ${recipientLabel(requester)}'s request automatically.`
              : "Could not approve request.",
        );
        return false;
      } finally {
        if (!automatic) setBusy(null);
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

  const handleApprove = useCallback(
    async (request: OneLocationAccessRequest) => {
      await approveAccessRequest(request);
    },
    [approveAccessRequest],
  );

  /**
   * Requests this device has already put through auto-approve, so a failure
   * (or the refresh that follows a success) cannot start the same approval a
   * second time. Attempted, not succeeded: a request that failed once will
   * keep failing, and retrying it on every state change would spam the person
   * with the same error until they gave up on the screen.
   */
  const autoApprovedRequestIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A different account carries different standing permission.
    autoApprovedRequestIdsRef.current = new Set();
  }, [auth.userId]);

  useEffect(() => {
    // Approving needs vault authority anyway, so a locked vault is not a
    // separate policy decision -- it simply cannot proceed.
    if (!vaultOwnerToken) return;
    const approvable = selectAutoApprovableRequests({
      pendingRequests: pendingOwnerRequests,
      enabled: locationControl.autoApproveRequestsEnabled,
      enabledAt: locationControl.autoApproveEnabledAt,
      paused: locationControl.paused,
      alreadyAttemptedIds: autoApprovedRequestIdsRef.current,
    });
    if (approvable.length === 0) return;

    for (const request of approvable) {
      autoApprovedRequestIdsRef.current.add(request.id);
    }
    void (async () => {
      // Sequential: each approval ends in a refresh, and running them together
      // would have several overlapping refreshes racing to write the same state.
      for (const request of approvable) {
        await approveAccessRequest(request, { automatic: true });
      }
    })();
  }, [
    approveAccessRequest,
    locationControl.autoApproveEnabledAt,
    locationControl.autoApproveRequestsEnabled,
    locationControl.paused,
    pendingOwnerRequests,
    vaultOwnerToken,
  ]);

  const handleDeny = useCallback(
    async (requestId: string) => {
      if (!vaultOwnerToken) return;
      setBusy("deny");
      try {
        await OneLocationService.denyRequest({ vaultOwnerToken, requestId });
        toast.success("Request denied.");
        void refresh().catch(() => null);
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
        void refresh().catch(() => null);
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
      const nextSelectedIds = setSelectedRecipientIds((current) =>
        addSelectedId(current, recipientId),
      );
      setSelectedRecipientId(recipientId);
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
    [recipients, setSelectedRecipientIds, trackRecommendationSelection],
  );
  const toggleShareRecipient = useCallback(
    (
      recipientId: string,
      selectionSurface: OneLocationSelectionSurface = "quick_circle",
    ) => {
      const recipient = recipients.find((item) => item.userId === recipientId);
      const nextSelectedIds = setSelectedRecipientIds((current) =>
        toggleSelectedId(current, recipientId),
      );
      setSelectedRecipientId(recipientId);
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
    [recipients, setSelectedRecipientIds, trackRecommendationSelection],
  );
  const removeShareRecipient = useCallback(
    (recipientId: string) => {
      const nextSelectedIds = setSelectedRecipientIds((current) =>
        current.filter((selectedId) => selectedId !== recipientId),
      );
      setSelectedRecipientId((current) =>
        current === recipientId ? nextSelectedIds[0] || "" : current,
      );
      setShareReviewOpen(false);
    },
    [setSelectedRecipientIds],
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
        // sourceCircleId is carried on the request for Circle-targeted
        // check-ins; the selected Circle's ready members are already merged
        // into the recipient set upstream, so no extra handling is needed here.
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
          // Prints its own message below.
          announce: false,
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
        trackLocationShareConfirmed({
          route_id: "one_location",
          result: oneLocationEventResult(successCount, failureCount),
          selected_count: selected.length,
          success_count: successCount,
          failure_count: failureCount,
          duration_bucket: oneLocationDurationBucket(durationHoursValue),
          review_required: false,
        });
        // Emitted alongside the share event, not instead of it: a check-in *is*
        // a recipient-scoped share and still counts toward activation, but
        // without its own event Check-In and live sharing are indistinguishable
        // in reporting, so we cannot tell which feature people actually use.
        trackEvent("one_location_check_in_completed", {
          route_id: "one_location",
          result: oneLocationEventResult(successCount, failureCount),
          selected_count: selected.length,
          success_count: successCount,
          failure_count: failureCount,
          circle_targeted: Boolean(request.sourceCircleId),
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
        void refresh().catch((refreshError) => {
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
        trackLocationShareConfirmed({
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
          // Prints its own message below.
          announce: false,
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
        void refresh().catch(() => null);
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
            // Prints its own message below.
            announce: false,
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
        trackLocationShareConfirmed({
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
        void refresh().catch(() => null);
      } catch (error) {
        const failureCount = selected.length - successCount || 1;
        trackLocationShareConfirmed({
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
          // Prints its own message below.
          announce: false,
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
        void refresh().catch(() => null);
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
  // Marks the consent read-back as on screen and records that it was seen.
  //
  // Deliberately free of side effects: the redesign flow calls this when its
  // merged confirm step mounts, and a step that asked the OS for permission
  // just by being rendered would prompt before the person has done anything.
  // The permission work belongs to the share itself, which already runs the
  // same pre-flight inside `handleShare`.
  const announceShareReviewOpened = useCallback(() => {
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
    permission?.state,
    setupNeededSelectedRecipients.length,
    shareDurationHours,
    shareReadySelectedRecipients,
  ]);

  // Legacy single-screen composer: there the review IS a separate screen, so
  // opening it stays gated on the device pre-flight.
  const handleOpenShareReview = useCallback(async () => {
    if (!canShare) return;
    const attemptId = shareReviewAttemptRef.current + 1;
    shareReviewAttemptRef.current = attemptId;
    shareReviewPendingRef.current = true;
    setBusy("share");
    const readiness = await ensureForegroundLocationReady({
      capturePoint: false,
      autoOpenSettings: true,
      // Opening the review screen is not the owner asking for a fix. Failing
      // here used to toast before the screen they pressed had even appeared.
      announce: false,
    });
    if (shareReviewAttemptRef.current !== attemptId) return;
    shareReviewPendingRef.current = false;
    setBusy(null);
    if (!readiness.ready) return;
    announceShareReviewOpened();
  }, [announceShareReviewOpened, canShare, ensureForegroundLocationReady]);
  const dataState: "loading" | "loaded" | "unavailable-valid" = loadError
    ? "unavailable-valid"
    : state
      ? "loaded"
      : "loading";
  // Voice surface for the Location screen. Until this existed One could route
  // here and delegate to the Location specialist, but arrived blind: it knew
  // the screen's name and nothing about what was on it.
  //
  // Only the workspace instance publishes. `/one/setup/location` renders this
  // same component and publishes its own metadata, and two publishers on one
  // route is exactly the race that made One describe the wrong screen.
  const locationVoiceSurfaceMetadata = useMemo(() => {
    if (mode !== "workspace") return null;
    // Read from the hub's own params. This memo used to describe the legacy
    // compose/activity tabs, which USE_LOCATION_REDESIGN made unreachable, so
    // One was handed a confident account of a screen nobody could see.
    const hubTab = LOCATION_HUB_TAB_LABELS[
      String(searchParams.get("view") || "").trim()
    ]
      ? String(searchParams.get("view") || "").trim()
      : "now";
    const hubTabLabel = LOCATION_HUB_TAB_LABELS[hubTab];
    const openFlow =
      String(searchParams.get("action") || "").trim() || null;
    const openFlowLabel = openFlow
      ? (LOCATION_FLOW_LABELS[openFlow] ?? null)
      : null;
    const actions = LOCATION_VOICE_ACTIONS;
    // Location can only be shared with a connection or a circle member, so an
    // account with neither cannot finish either of these flows however long it
    // stays on them. The screen says "no connections" and stops; this is what
    // lets One finish the sentence and offer to open Connect.
    const hasSomeoneToShareWith =
      shareRecipientPool.length > 0 || namedCircles.length > 0;
    const deadEnd = (() => {
      if (!openFlow) return null;
      if (!hasSomeoneToShareWith) {
        if (openFlow === "sms-contacts") {
          return {
            reason:
              "There is no one to add as an emergency contact yet: contacts come from your connections and circles, and this account has neither.",
            remedyActionId: "location.add_connections",
          };
        }
        if (openFlow === "share") {
          return {
            reason:
              "There is no one to share location with yet: sharing needs a connection or a circle member, and this account has neither.",
            remedyActionId: "location.add_connections",
          };
        }
        return null;
      }
      // There ARE people to share with, but none are picked. Saying "share my
      // location" here refuses -- deliberately, because the recipient is never
      // a voice slot -- and without this the person just hears no twice and is
      // told nothing about which half is missing. Naming the remedy turns the
      // refusal into the next step.
      if (openFlow === "share" && shareReadySelectedRecipients.length === 0) {
        return {
          reason:
            "Nobody is picked for this share yet, so starting it will refuse. The share needs a person chosen before it can run.",
          remedyActionId: "location.select_share_recipient",
        };
      }
      return null;
    })();
    return {
      screenId: "one_location",
      title: "Location",
      purpose:
        "This screen shares live location with chosen people and reviews who currently has access.",
      // Deliberately null. The subjects here are people and places -- the
      // recipients of a share, their names, an address. None of that crosses
      // into what the model may say aloud, so this screen names only itself.
      primaryEntity: null,
      spokenSubject: openFlowLabel
        ? `Location, ${openFlowLabel}`
        : `Location, ${hubTabLabel} tab`,
      deadEnd,
      sections: [
        { id: "now", title: "Overview", purpose: "See current sharing status and start a quick action." },
        { id: "people", title: "People", purpose: "See the people and circles you share location with." },
        { id: "links", title: "Links", purpose: "See and create temporary sharing links." },
      ],
      actions,
      controls: LOCATION_VOICE_CONTROLS,
      concepts: [
        {
          id: "location_share",
          label: "Location share",
          explanation:
            "A location share gives a chosen person time-limited access to your live location, and can be revoked at any time.",
          aliases: ["location", "share location", "live location"],
        },
        {
          id: "location_circle",
          label: "Circle",
          explanation:
            "A circle is a named group you can share location with at once. Members join by invite or code, and a circle member can be shared with even if they are not a connection.",
          aliases: ["circle", "group", "my circle"],
        },
      ],
      activeSection: openFlowLabel || hubTabLabel,
      activeTab: hubTab,
      selectedEntity: null,
      visibleModules: openFlowLabel
        ? [openFlowLabel]
        : LOCATION_TAB_MODULES[hubTab],
      focusedWidget: openFlowLabel || `${hubTabLabel} tab`,
      availableActions: actions.map((action) => action.label),
      activeControlId: null,
      lastInteractedControlId: null,
      busyOperations: [
        ...(dataState === "loading" ? ["location_state_load"] : []),
        ...(busy ? [`location_${busy}`] : []),
      ],
      // Counts only -- never who, never where.
      screenMetadata: {
        location_tab: hubTab,
        location_flow: openFlow,
        data_state: dataState,
        permission_state: permission?.state ?? null,
        pending_request_count: pendingOwnerRequests.length,
        connection_count: shareRecipientPool.length,
        circle_count: namedCircles.length,
        has_load_error: Boolean(loadError),
      },
    };
  }, [
    busy,
    dataState,
    loadError,
    mode,
    namedCircles.length,
    pendingOwnerRequests.length,
    permission?.state,
    searchParams,
    shareRecipientPool.length,
    // Picking someone clears the dead end, so the metadata has to be rebuilt
    // when the selection changes -- not only when the pool does.
    shareReadySelectedRecipients.length,
  ]);
  usePublishVoiceSurfaceMetadata(locationVoiceSurfaceMetadata);

  // `location.open_compose` / `location.open_activity` used to be wired here.
  // They drove the legacy compose/activity page tabs, which USE_LOCATION_REDESIGN
  // made unreachable: `setLocationTab` wrote `?view=compose`, the hub read a value
  // it does not know and fell back to Now, so both actions silently landed the
  // person on the wrong screen. Every hub tab and action flow is now authored as
  // a `route` action in this surface's contract, addressed by the same
  // `?view=` / `?action=` params the hub already owns — so One can reach them
  // from anywhere, instead of only while standing on this page.
  useLocalOnboardingActionHandler("location.refresh", () => {
    // refresh() reports its own failure through loadError, so the rejection is
    // redundant here — but leaving it unhandled surfaces as an unhandled
    // promise rejection in the console.
    void refresh().catch(() => null);
    return { status: "succeeded", summary: "Location refreshed." };
  });
  const showInitialSkeleton =
    !loadError &&
    !state &&
    (auth.loading ||
      busy === "load" ||
      Boolean(auth.userId && vaultOwnerToken));
  const locationReadiness = useMemo(
    () => readinessCopy(permission, locationDenialObserved),
    [permission, locationDenialObserved],
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

  // Returns its outcome so the voice handler below can report what actually
  // happened rather than assuming success. Tap call sites discard it.
  //
  // Turning Location on is a PREFERENCE, and the preference is local — nothing
  // about storing it needs the network. What takes time is the device: a cold
  // GPS fix is a second or two on a phone and can run the whole sampling budget
  // on a laptop with no GPS at all. Holding the switch until that fix arrives
  // is what made this control feel broken, identically, on every platform.
  //
  // So the switch moves first and the fix follows it. The one thing that could
  // make that flip wrong is the platform refusing outright, and that is
  // readable synchronously from state we already hold — so the common case
  // never shows an "on" it has to take back.
  const handleShowMyLiveLocation =
    useCallback(async (): Promise<LocalOnboardingActionResult> => {
      const intent = ++locationIntentSeqRef.current;
      const isStale = () => locationIntentSeqRef.current !== intent;
      const superseded: LocalOnboardingActionResult = {
        status: "succeeded",
        summary: "A newer location change replaced this one.",
      };
      setMyLocationError(null);

      // Already-known refusal: do not claim an "on" the device cannot deliver.
      // Everything below still runs, so the person is routed to settings.
      const platformRefuses = Boolean(locationBlockReason(permission));
      const previous = locationControl;
      const applyOptimisticOn = () => {
        if (platformRefuses) return;
        automaticPrivatePublishingAllowedRef.current = true;
        updateOneLocationControlState(auth.userId, (current) => ({
          ...current,
          paused: false,
          selfPreviewEnabled: true,
        }));
      };
      const rollbackOptimisticOn = () => {
        if (platformRefuses) return;
        automaticPrivatePublishingAllowedRef.current = !previous.paused;
        updateOneLocationControlState(auth.userId, (current) => ({
          ...current,
          paused: previous.paused,
          selfPreviewEnabled: previous.selfPreviewEnabled,
        }));
      };

      applyOptimisticOn();
      setBusy("selfLocation");
      try {
        const result = await ensureForegroundLocationReady({
          capturePoint: true,
          autoOpenSettings: true,
          isStale,
          // Renders its outcome inline on the switch itself.
          announce: false,
          // Turning location on must not succeed on a remembered position:
          // pause is a privacy control, and resuming a share on a coordinate
          // the owner has left starts telling people something untrue.
          requireMeasurement: true,
        });
        // A newer tap owns the control now. Reporting this one's outcome would
        // describe a state the person has already moved on from, and rolling
        // back would fight the newer intent.
        if (isStale()) return superseded;
        if (!result.ready || !result.point) {
          rollbackOptimisticOn();
          // Say which of the two it was. "Needs device Location permission"
          // was printed even when permission was fine and the device had
          // simply not answered yet, which sent people to a settings screen
          // with nothing to change on it.
          const message =
            result.failure === "no-fix"
              ? LOCATION_COPY.noFix
              : LOCATION_COPY.denied;
          setMyLocationError(message);
          return { status: "blocked", summary: message };
        }
        setMapViewportResetKey((current) => current + 1);
        toast.success("Your live location preview is ready.");
        return {
          status: "succeeded",
          summary: "Location updates are on again for this device.",
        };
      } catch (error) {
        if (isStale()) return superseded;
        rollbackOptimisticOn();
        // The gate already decided whether this was a refusal; asserting a
        // cause from the error text guessed wrong on every timeout.
        const message = isLocationPermissionDeniedError(error)
          ? LOCATION_COPY.denied
          : LOCATION_COPY.noFix;
        setMyLocationError(message);
        toast.error(message);
        return { status: "failed", summary: message };
      } finally {
        // A newer intent owns `busy` and will clear it itself; clearing it here
        // would wipe the pending state of work that is still running.
        if (!isStale()) setBusy(null);
      }
    }, [
      auth.userId,
      ensureForegroundLocationReady,
      locationControl,
      permission,
    ]);

  // One coordinated pause owns every Location entry point. Private grants keep
  // their consent/expiry contract, but all new foreground/background updates
  // stop. Nearby presence is a separate authority and must explicitly check
  // out before the UI may claim that Nearby is clear.
  //
  // The ORDER here is the whole safety argument. Every part of a pause that
  // this device controls happens synchronously, before any await: someone who
  // says "stop showing me" should not stay visible locally for as long as a
  // round trip takes, and none of that state lives on a server anyway. What
  // genuinely is remote — nearby checkout — follows, and is still reported
  // exactly as honestly as before.
  //
  // The pause used to sit BEHIND two serialized nearby calls, which is what
  // made the switch take seconds to move.
  const handleHideMyLiveLocation =
    useCallback(async (): Promise<LocalOnboardingActionResult> => {
    if (!auth.userId) {
      return { status: "blocked", summary: "Sign in to pause your location." };
    }

    const intent = ++locationIntentSeqRef.current;
    const isStale = () => locationIntentSeqRef.current !== intent;
    // A capture still in flight from an earlier "on" no longer owns the pending
    // state, and its own `finally` will decline to clear it. Clear it here so
    // the control cannot be stranded looking busy.
    setBusy((current) => (current === "selfLocation" ? null : current));

    automaticPrivatePublishingAllowedRef.current = false;
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

    // Nearby presence lives on the server under the vault's authority. A locked
    // vault means we cannot check out — but that is no longer a reason to
    // refuse the pause, which has already taken effect on this device. Refusing
    // outright left the person MORE exposed than telling them both halves does.
    if (nearbyCheckInAvailable && !vaultOwnerToken) {
      const message =
        "Location updates are paused on this device, but I could not check you out of nearby presence -- unlock One and pause again to finish that.";
      toast.error(message);
      return { status: "succeeded", summary: message };
    }

    // Checkout is idempotent server-side: it clears an ACTIVE row and reports
    // success either way. So the presence GET that used to precede it bought
    // nothing but a second serialized round trip inside the pause — and asking
    // first is strictly worse than just telling, because the answer can go
    // stale between the two calls. The dedupe window below keeps a flurry of
    // taps off the 6/minute nearby-write limit without letting this device act
    // on a stale belief about account-wide presence.
    const checkedOutRecently =
      nearbyCheckoutConfirmedAtRef.current > 0 &&
      Date.now() - nearbyCheckoutConfirmedAtRef.current <
        NEARBY_CHECKOUT_DEDUPE_MS;
    const shouldCheckOut =
      nearbyCheckInAvailable && Boolean(vaultOwnerToken) && !checkedOutRecently;
    if (shouldCheckOut && vaultOwnerToken) {
      try {
        await OneLocationService.checkoutNearby({ vaultOwnerToken });
        nearbyCheckoutConfirmedAtRef.current = Date.now();
      } catch {
        // Both halves of the truth, in the order that matters: what is now
        // private, then what is not. Told as `succeeded` because the thing
        // asked for did happen -- reporting failure would send someone to
        // retry a pause that is already in effect, while the part that is
        // actually still exposed goes unmentioned.
        const message =
          "Location updates are paused on this device, but I could not check you out of nearby presence -- you may still be visible to people around you.";
        toast.error(message);
        return { status: "succeeded", summary: message };
      }
    }

    // The checkout still had to happen, but announcing a pause after the person
    // has already turned Location back on would describe a state that is no
    // longer true.
    if (isStale()) {
      return {
        status: "succeeded",
        summary: "A newer location change replaced this one.",
      };
    }
    toast.success("Location updates are paused on this device.");
    return {
      status: "succeeded",
      summary: "Location updates are paused on this device.",
    };
  }, [
    auth.userId,
    clearMyLocationPreview,
    nearbyCheckInAvailable,
    vaultOwnerToken,
  ]);

  // The Location surface's first two actions that DO something rather than
  // open something. Both delegate to the same callbacks the on-screen controls
  // use, so voice can never take a path a tap could not, and both report the
  // real outcome -- including a refusal -- instead of assuming success.
  //
  // The asymmetry in policy is deliberate and is the whole safety argument
  // here. Pausing only ever removes visibility, so it runs directly: someone
  // who says "hide my location" is in no position to be asked twice. Resuming
  // makes them visible again to every active grant, so its contract marks it
  // `confirm_required` and it does not run until they have looked at it.
  useLocalOnboardingActionHandler(
    "location.pause_updates",
    () => handleHideMyLiveLocation(),
  );
  useLocalOnboardingActionHandler(
    "location.resume_updates",
    () => handleShowMyLiveLocation(),
  );

  // Sharing a live location is the most consequential thing this surface can
  // do, so voice is given exactly one half of it: the duration, and the word
  // go. WHO it goes to is never a slot. The recipients come from what the
  // person has selected in the composer with their own hands, and if that is
  // empty this refuses and says so rather than choosing anyone.
  //
  // That division is what makes a spoken share safe without a name resolver:
  // the worst a misheard sentence can do is send to the people already on
  // screen for the wrong number of hours, which the person is looking at.
  // Saying a name resolves to a SELECTION, never to a send.
  //
  // The obvious design -- One resolves "Sarah" to a user id and shares with
  // her -- would need the model to know who your connections are, and the
  // live-context boundary redacts exactly that: `selected_entity` and
  // `primary_entity` are stripped server-side because surfaces fill them with
  // real names and email addresses. Handing the model a contact list to search
  // would reverse that decision for the sake of one convenience.
  //
  // So the matching happens here, in the browser, against the list it already
  // holds. The model only ever echoes back a name the person just said out
  // loud, and gets no names in return: the summaries below deliberately count
  // people rather than name them, because the summary is relayed to the model
  // while the SCREEN is what shows the person who was picked.
  //
  // And it stops at selected. A misheard name becomes a wrong face on screen,
  // in front of someone who can see it, rather than a live location already
  // sent to the wrong person.
  useLocalOnboardingActionHandler("location.select_share_recipient", async (slots) => {
    const spoken = String(slots?.person ?? "").trim().toLowerCase();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say who you want to share with." };
    }
    let matches = rankedRecipients.filter((recipient) =>
      recommendationSearchText(recipient).includes(spoken),
    );
    // Finding nobody while the vault is LOCKED says nothing about who the
    // person is connected to -- the protected recipient list cannot be read at
    // all without the owner token, so "nobody matches that name" would be a
    // statement about their connections made without being able to see them.
    // It reads as "that person is not your connection", which may be flatly
    // untrue, and sends someone off to re-add somebody they already have.
    if (matches.length === 0 && !vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see who you are connected to while the vault is locked, so I cannot tell whether they are there.",
      };
    }
    // A navigation journey can arrive before the full Location workspace
    // snapshot has finished loading. Do one focused, server-authoritative
    // recipient read before concluding that the named connection is absent.
    // This stays inside the browser's existing vault-authorized boundary; the
    // private agent still receives only the words the person spoke.
    if (matches.length === 0 && vaultOwnerToken) {
      try {
        const freshRecipients = await OneLocationService.listRecipients(
          vaultOwnerToken,
        );
        matches = rankRecipientsForRecommendation(
          enrichRecipientsWithContactSignal(
            freshRecipients,
            contactMatchedUserIds,
          ),
          contactMatchedUserIds,
        ).filter((recipient) => recommendationSearchText(recipient).includes(spoken));
      } catch {
        return {
          status: "blocked" as const,
          summary: "Location is still loading your connections. Please try that name again in a moment.",
        };
      }
    }
    if (matches.length === 0) {
      return {
        status: "blocked" as const,
        summary: "Nobody in your connections matches that name.",
      };
    }
    if (matches.length > 1) {
      // Never guess between people. Two colleagues sharing a first name is
      // ordinary, and picking the wrong one here is not recoverable once the
      // share starts.
      // Naming them is the point: "which Sarah?" is only answerable if the
      // person hears both. Bounded to the handful that actually matched the
      // name they just said.
      const names = matches
        .slice(0, 4)
        .map((recipient) => recipientLabel(recipient).trim())
        .filter(Boolean)
        .join(", ");
      return {
        status: "blocked" as const,
        summary: names
          ? `${matches.length} people match that name: ${names}. Ask which one they meant.`
          : `${matches.length} people match that name. Ask which one they meant.`,
      };
    }
    const match = matches[0];
    const matchedUserId = match?.userId;
    if (!match || !matchedUserId) {
      return {
        status: "blocked" as const,
        summary: "Nobody in your connections matches that name.",
      };
    }
    setSelectedRecipientIds((current) =>
      current.includes(matchedUserId) ? current : [...current, matchedUserId],
    );
    // The RESOLVED name goes back, and that is the safety mechanism rather
    // than a leak.
    //
    // Phase 4 deliberately counted people instead of naming them, to keep the
    // contact list out of the model's context. Echoing back what the person
    // already said verifies nothing though: "sarah" confirms only that we
    // heard a sound. Hearing "Sarah Chen" is what lets a wrong match die in
    // the question instead of on someone's phone.
    //
    // The disclosure is bounded to exactly that: one contact, the person's
    // own, resolved from a name they just said aloud, spoken back to them.
    // No id, no address, no list -- and still nothing about anyone they did
    // not name.
    const matchedName = recipientLabel(match).trim();
    return {
      status: "succeeded" as const,
      // Say the matched name and keep going. This used to end "ask the person
      // to confirm that is who they meant", which was the design when the
      // question existed to catch a mis-heard name -- but a spoken yes to a
      // question One just asked adds nothing the original sentence did not,
      // and it was the last thing standing between this flow and hands-free.
      //
      // Naming the match out loud still does the work the question was for:
      // the person hears "Abdul Rashid" when they said "Abdul", and a wrong
      // match is audible at the moment it happens rather than after.
      summary: matchedName
        ? `Matched ${matchedName}. Now start the share with location.share_selected and the duration they asked for; say who it is going to as you do it.`
        : "Matched one person. Now start the share with location.share_selected and the duration they asked for.",
    };
  });

  useLocalOnboardingActionHandler("location.share_selected", async (slots) => {
    const requested = String(slots?.duration_hours ?? "").trim();
    // Only the durations the share composer itself offers. An unrecognised
    // value is ignored in favour of what is on screen rather than coerced
    // into some nearest number the person never asked for.
    //
    // This used to check DURATION_OPTIONS — a different list belonging to a
    // different screen — so "2 hours", "8 hours" and "until I stop" were all
    // refused by voice while "24 hours" was accepted and then silently
    // rewritten to 23h45m by the picker's grid.
    const duration = SHARE_VOICE_DURATION_VALUES.has(requested)
      ? requested
      : undefined;
    if (duration) setShareDurationHours(duration);

    // A hands-free share is otherwise invisible: One says it started and the
    // screen returns to a hub that looks exactly as it did before. Landing on
    // Active shares makes the result something the person can see and stop.
    // Only set for the voice path -- taps keep returning to the clean hub.
    const landOn = "/one/location?action=active-shares";
    const result = await handleShare(duration, landOn);
    if (result.status !== "succeeded") return result;
    // Declared only once the completion effect will really navigate there.
    // `routeAfter` makes the runtime WAIT for that settlement -- on an action
    // that does not navigate it waits for nothing and times out into a false
    // "started", which is why it cannot simply be returned unconditionally.
    return { ...result, routeAfter: landOn, screenAfter: "one_location" };
  });

  useLocalOnboardingActionHandler("location.stop_share", async (slots) => {
    const spoken = String(slots?.person ?? "").trim();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say whose access you want to stop." };
    }
    if (!vaultOwnerToken) {
      return { status: "blocked" as const, summary: "Unlock One before stopping a share." };
    }
    const resolved = resolveBySpokenName(
      activeOwnerGrants,
      spoken,
      (grant) => grant.recipientDisplayName,
    );
    if (resolved.kind === "none") {
      return {
        status: "blocked" as const,
        summary: "Nobody currently has your location shared with that name.",
      };
    }
    if (resolved.kind === "many") {
      // Never guess between people, same as picking a share recipient.
      const names = ambiguousMatchNames(resolved.matches, (grant) => grant.recipientDisplayName);
      return {
        status: "blocked" as const,
        summary: names
          ? `${resolved.matches.length} active shares match that name: ${names}. Ask which one they meant.`
          : `${resolved.matches.length} active shares match that name. Ask which one they meant.`,
      };
    }
    const grant = resolved.match;
    // handleRevoke is best-effort (its own toast carries a real failure); the
    // same trust handleStopSos already gets for the identical shape.
    await handleRevoke(grant.id);
    return {
      status: "succeeded" as const,
      summary: `Stopped sharing your location with ${(grant.recipientDisplayName || "them").trim()}.`,
    };
  });

  useLocalOnboardingActionHandler("location.approve_request", async (slots) => {
    const spoken = String(slots?.person ?? "").trim();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say whose request you want to approve." };
    }
    if (!vaultOwnerToken) {
      return { status: "blocked" as const, summary: "Unlock One before approving a request." };
    }
    const resolved = resolveBySpokenName(
      pendingOwnerRequests,
      spoken,
      (request) => request.requesterDisplayName,
    );
    if (resolved.kind === "none") {
      return {
        status: "blocked" as const,
        summary: "Nobody is waiting on your decision with that name.",
      };
    }
    if (resolved.kind === "many") {
      const names = ambiguousMatchNames(
        resolved.matches,
        (request) => request.requesterDisplayName,
      );
      return {
        status: "blocked" as const,
        summary: names
          ? `${resolved.matches.length} requests match that name: ${names}. Ask which one they meant.`
          : `${resolved.matches.length} requests match that name. Ask which one they meant.`,
      };
    }
    const request = resolved.match;
    await handleApprove(request);
    return {
      status: "succeeded" as const,
      summary: `Approved ${(request.requesterDisplayName || "their").trim()}'s request.`,
    };
  });

  useLocalOnboardingActionHandler("location.decline_request", async (slots) => {
    const spoken = String(slots?.person ?? "").trim();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say whose request you want to decline." };
    }
    if (!vaultOwnerToken) {
      return { status: "blocked" as const, summary: "Unlock One before declining a request." };
    }
    const resolved = resolveBySpokenName(
      pendingOwnerRequests,
      spoken,
      (request) => request.requesterDisplayName,
    );
    if (resolved.kind === "none") {
      return {
        status: "blocked" as const,
        summary: "Nobody is waiting on your decision with that name.",
      };
    }
    if (resolved.kind === "many") {
      const names = ambiguousMatchNames(
        resolved.matches,
        (request) => request.requesterDisplayName,
      );
      return {
        status: "blocked" as const,
        summary: names
          ? `${resolved.matches.length} requests match that name: ${names}. Ask which one they meant.`
          : `${resolved.matches.length} requests match that name. Ask which one they meant.`,
      };
    }
    const request = resolved.match;
    await handleDeny(request.id);
    return {
      status: "succeeded" as const,
      summary: `Declined ${(request.requesterDisplayName || "their").trim()}'s request.`,
    };
  });

  useLocalOnboardingActionHandler("location.change_share_duration", async (slots) => {
    const spoken = String(slots?.person ?? "").trim();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say whose access time you want to change." };
    }
    if (!vaultOwnerToken) {
      return { status: "blocked" as const, summary: "Unlock One before changing a share's time." };
    }
    const requested = String(slots?.duration_hours ?? "").trim();
    if (!SHARE_VOICE_DURATION_VALUES.has(requested)) {
      return {
        status: "blocked" as const,
        summary:
          "Say how long: 15 minutes, 30 minutes, 1 hour, 2 hours, 4 hours, 8 hours, 24 hours, or until you stop it.",
      };
    }
    const resolved = resolveBySpokenName(
      activeOwnerGrants,
      spoken,
      (grant) => grant.recipientDisplayName,
    );
    if (resolved.kind === "none") {
      return {
        status: "blocked" as const,
        summary: "Nobody currently has your location shared with that name.",
      };
    }
    if (resolved.kind === "many") {
      const names = ambiguousMatchNames(resolved.matches, (grant) => grant.recipientDisplayName);
      return {
        status: "blocked" as const,
        summary: names
          ? `${resolved.matches.length} active shares match that name: ${names}. Ask which one they meant.`
          : `${resolved.matches.length} active shares match that name. Ask which one they meant.`,
      };
    }
    const grant = resolved.match;
    const untilStopped = requested === SHARE_DURATION_UNTIL_STOP_VALUE;
    try {
      await OneLocationService.setGrantDuration({
        vaultOwnerToken,
        grantId: grant.id,
        durationHours: untilStopped ? null : Number(requested),
        durationMode: untilStopped ? "until_stopped" : "timed",
      });
      void refresh({ background: true }).catch(() => null);
    } catch (error) {
      return {
        status: "blocked" as const,
        summary:
          error instanceof Error ? error.message : "Couldn't change the time. Try again.",
      };
    }
    const name = (grant.recipientDisplayName || "them").trim();
    return {
      status: "succeeded" as const,
      summary: untilStopped
        ? `Changed ${name}'s access to last until you stop it.`
        : `Changed ${name}'s access to ${shareVoiceDurationSpokenLabel(requested)}.`,
    };
  });

  useLocalOnboardingActionHandler("location.select_ask_recipient", async (slots) => {
    // Mirrors location.select_share_recipient's own matching/ambiguity
    // rules exactly -- same connections list, same "never guess" discipline
    // -- because asking someone for their location and sharing yours with
    // them draw from the identical pool of people.
    const spoken = String(slots?.person ?? "").trim();
    if (!spoken) {
      return { status: "blocked" as const, summary: "Say who you want to ask." };
    }
    let resolved = resolveBySpokenName(
      contactSignalRecipients,
      spoken,
      recipientLabel,
      recommendationSearchText,
    );
    if (resolved.kind === "none" && !vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see who you are connected to while the vault is locked, so I cannot tell whether they are there.",
      };
    }
    if (resolved.kind === "none" && vaultOwnerToken) {
      try {
        const freshRecipients = await OneLocationService.listRecipients(vaultOwnerToken);
        resolved = resolveBySpokenName(
          rankRecipientsForRecommendation(
            enrichRecipientsWithContactSignal(freshRecipients, contactMatchedUserIds),
            contactMatchedUserIds,
          ),
          spoken,
          recipientLabel,
          recommendationSearchText,
        );
      } catch {
        return {
          status: "blocked" as const,
          summary: "Location is still loading your connections. Please try that name again in a moment.",
        };
      }
    }
    if (resolved.kind === "none") {
      return { status: "blocked" as const, summary: "Nobody in your connections matches that name." };
    }
    if (resolved.kind === "many") {
      const names = ambiguousMatchNames(resolved.matches, recipientLabel);
      return {
        status: "blocked" as const,
        summary: names
          ? `${resolved.matches.length} people match that name: ${names}. Ask which one they meant.`
          : `${resolved.matches.length} people match that name. Ask which one they meant.`,
      };
    }
    const match = resolved.match;
    addRequestOwner(match.userId);
    return {
      status: "succeeded" as const,
      summary: `Picked ${recipientLabel(match).trim()} to ask. Say "send it" to send the request.`,
    };
  });

  useLocalOnboardingActionHandler("location.send_request", async () => {
    if (!vaultOwnerToken) {
      return { status: "blocked" as const, summary: "Unlock One before sending a request." };
    }
    if (!selectedRequestOwners.length) {
      return {
        status: "blocked" as const,
        summary: "Say who you want to ask first, then say send it.",
      };
    }
    const names = selectedRequestOwners
      .map((owner) => recipientLabel(owner).trim())
      .filter(Boolean)
      .join(", ");
    const sent = await handleRequestAccess();
    if (!sent) {
      return {
        status: "blocked" as const,
        summary: "Couldn't send the request. Try again.",
      };
    }
    return {
      status: "succeeded" as const,
      summary:
        selectedRequestOwners.length === 1
          ? `Asked ${names || "them"} for their location.`
          : `Asked ${selectedRequestOwners.length} people for their location.`,
    };
  });

  useLocalOnboardingActionHandler("location.stop_sos", async () => {
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary: "Unlock One before stopping an SOS.",
      };
    }
    const incident = sosIncident;
    if (!incident?.grantIds.length) {
      return {
        status: "blocked" as const,
        summary: "There is no SOS running to stop.",
      };
    }
    const grantCount = incident.grantIds.length;
    // Reuses the screen's own teardown rather than revoking here. That loop
    // tolerates a grant that has already expired and keeps tearing the rest
    // down, which is the behaviour worth having: a half-stopped SOS is the
    // worst outcome, so one failure must not abandon the others.
    await handleStopSos();
    return {
      status: "succeeded" as const,
      // Says what was torn down, not that every recipient definitely lost
      // access -- individual revokes are best-effort by design and a claim
      // stronger than that would be one this cannot actually check.
      summary:
        grantCount === 1
          ? "Stopped the SOS and revoked the share it created."
          : `Stopped the SOS and revoked the ${grantCount} shares it created.`,
    };
  });

  useLocalOnboardingActionHandler("location.trigger_sos", async (slots) => {
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary: "Unlock One before sending an SOS alert.",
      };
    }
    // Same re-entry guard handleTriggerSos itself enforces -- checked here
    // too so the person hears why nothing happened, instead of a silent
    // no-op behind a "succeeded" that never actually sent a second alert.
    if (sosIncident) {
      return {
        status: "blocked" as const,
        summary: "There is already an SOS running. Say stop the S O S to end it first.",
      };
    }
    if (locationPermissionBlocksSharing(permission)) {
      return {
        status: "blocked" as const,
        summary: "Location access is off, so I cannot send an SOS alert with your position.",
      };
    }
    const readyRecipients = smsActionRecipients.filter(isSosShareReadyRecipient);
    if (!readyRecipients.length) {
      return {
        status: "blocked" as const,
        summary: smsActionRecipients.length
          ? "Your emergency contacts are not ready to receive an alert yet."
          : "Add at least one emergency contact before sending an SOS alert.",
      };
    }
    const note = String(slots?.note ?? "").trim() || null;
    if (slots?.confirmed !== true) {
      // The highest-consequence action on this surface -- a misheard "yes"
      // here dispatches a real emergency alert, including a fallback email,
      // to real people. Every other destructive action on Location gets a
      // spoken confirmation at most; this one gets the same explicit,
      // tappable card as removing an emergency contact, but never skips it.
      const names = formatNameList(readyRecipients.map((r) => recipientLabel(r)));
      return {
        status: "blocked" as const,
        summary: "Sending an SOS alert needs a confirmation.",
        data: {
          [VOICE_CONFIRM_DATA_KEY]: {
            actionId: "location.trigger_sos",
            slots: { note: note ?? "", confirmed: true },
            prompt: `Send an SOS alert to ${names} right now?`,
            subject: { name: "SOS alert", detail: names },
            consequence: getKaiActionById("location.trigger_sos")?.meaning ?? null,
            confirmLabel: "Send SOS",
          },
        },
      };
    }
    void handleTriggerSos(note);
    return {
      status: "succeeded" as const,
      summary: "Sending your SOS alert now.",
    };
  });

  useLocalOnboardingActionHandler("location.add_emergency_contact", async (slots) => {
    const spoken = String(slots?.person ?? "").trim().toLowerCase();
    if (!spoken) {
      return {
        status: "blocked" as const,
        summary: "Say who you want as an emergency contact.",
      };
    }
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see who you are connected to while the vault is locked.",
      };
    }
    // Resolved against the people who are ELIGIBLE to receive an SOS, not the
    // whole connection list. Someone who has not finished their own Location
    // setup cannot receive one, and adding them would build an emergency
    // contact list that quietly does not work when it is needed.
    const matches = sosActionRecipients.filter((recipient) =>
      recommendationSearchText(recipient).includes(spoken),
    );
    if (matches.length === 0) {
      return {
        status: "blocked" as const,
        summary: "Nobody in your connections can receive an SOS under that name.",
      };
    }
    if (matches.length > 1) {
      return {
        status: "blocked" as const,
        summary: `More than one person matches that name: ${matches
          .map((recipient) => recipientLabel(recipient).trim())
          .filter(Boolean)
          .join(", ")}. Say which one.`,
      };
    }
    const match = matches[0];
    const matchedUserId = match?.userId;
    if (!match || !matchedUserId) {
      return {
        status: "blocked" as const,
        summary: "Nobody in your connections matches that name.",
      };
    }
    if (smsContactUserIds.includes(matchedUserId)) {
      return {
        status: "succeeded" as const,
        summary: `${recipientLabel(match).trim()} is already one of your emergency contacts.`,
      };
    }
    const added = await handleAddSmsContact(matchedUserId);
    if (!added) {
      return {
        status: "failed" as const,
        summary: "Could not add that emergency contact.",
      };
    }
    return {
      status: "succeeded" as const,
      summary: `${recipientLabel(match).trim()} will now be sent your location if you trigger an SOS.`,
    };
  });

  useLocalOnboardingActionHandler("location.remove_emergency_contact", async (slots) => {
    const spoken = String(slots?.person ?? "").trim().toLowerCase();
    if (!spoken) {
      return {
        status: "blocked" as const,
        summary: "Say which emergency contact to remove.",
      };
    }
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see your emergency contacts while the vault is locked.",
      };
    }
    // Only the people actually ON the list. Matching the wider connection list
    // would let "remove Sarah" report success about somebody who was never an
    // emergency contact, leaving the real list untouched and the person
    // believing otherwise.
    const matches = smsActionRecipients.filter((recipient) =>
      recommendationSearchText(recipient).includes(spoken),
    );
    if (matches.length === 0) {
      return {
        status: "blocked" as const,
        summary: "Nobody by that name is one of your emergency contacts.",
      };
    }
    if (matches.length > 1) {
      return {
        status: "blocked" as const,
        summary: `More than one emergency contact matches that name: ${matches
          .map((recipient) => recipientLabel(recipient).trim())
          .filter(Boolean)
          .join(", ")}. Say which one.`,
      };
    }
    const match = matches[0];
    const matchedUserId = match?.userId;
    if (!match || !matchedUserId) {
      return {
        status: "blocked" as const,
        summary: "Nobody by that name is one of your emergency contacts.",
      };
    }
    if (slots?.confirmed !== true) {
      // Shown before it happens, not reported after. This list is the one
      // consulted in an emergency, so a name misheard once quietly removes the
      // person who would have been told.
      const label = recipientLabel(match).trim() || "this person";
      return {
        status: "blocked" as const,
        summary: `Removing ${label} needs a confirmation.`,
        data: {
          [VOICE_CONFIRM_DATA_KEY]: {
            actionId: "location.remove_emergency_contact",
            slots: { person: String(slots?.person ?? ""), confirmed: true },
            prompt: `Remove ${label} as an emergency contact?`,
            subject: {
              name: label,
              detail: recipientRecommendationLine(match) || null,
            },
            consequence:
              getKaiActionById("location.remove_emergency_contact")?.meaning ?? null,
            confirmLabel: "Remove",
          },
        },
      };
    }
    const removed = await handleRemoveSmsContact(matchedUserId);
    if (!removed) {
      return {
        status: "failed" as const,
        summary: "Could not remove that emergency contact.",
      };
    }
    return {
      status: "succeeded" as const,
      summary: `${recipientLabel(match).trim()} will no longer be sent your location in an SOS.`,
    };
  });

  useLocalOnboardingActionHandler("location.set_auto_share", async (slots) => {
    const spoken = String(slots?.enabled ?? "").trim().toLowerCase();
    const turnOn = ["on", "true", "yes", "enable", "enabled", "resume"].includes(spoken);
    const turnOff = ["off", "false", "no", "disable", "disabled", "stop"].includes(spoken);
    // Never guess a consent setting. An unrecognised word here would otherwise
    // fall to a default, and one of the two defaults hands out standing
    // permission to approve people without being asked.
    if (!turnOn && !turnOff) {
      return {
        status: "blocked" as const,
        summary: "Say whether automatic approval should be on or off.",
      };
    }
    handleAutoApproveChange(turnOn);
    return {
      status: "succeeded" as const,
      summary: turnOn
        ? "Automatic approval is on. New location requests will be approved without asking you."
        : "Automatic approval is off. You will be asked about each location request.",
    };
  });

  /**
   * Shared by the add/remove circle voice handlers.
   *
   * Returns either the single circle the person meant, or the sentence One
   * should say instead of guessing. Membership changes are irreversible from
   * the other person's side, so an ambiguous circle name must stop the action
   * rather than resolve to whichever circle happens to sort first.
   */
  const resolveVoiceCircle = useCallback(
    (
      spoken: string,
    ): { circle: OneLocationCircleSummary } | { blocked: string } => {
      const circleNames = namedCircles.map((circle) => circle.name).join(", ");
      if (!namedCircles.length) {
        return {
          blocked: "You do not have any circles yet. Say create a circle first.",
        };
      }
      if (!spoken) {
        // One circle means there is nothing to disambiguate, so not naming it is
        // unambiguous rather than incomplete.
        const [onlyCircle] = namedCircles;
        if (onlyCircle && namedCircles.length === 1) {
          return { circle: onlyCircle };
        }
        return { blocked: `Say which circle: ${circleNames}.` };
      }
      const { match, ambiguous } = matchCircleByName(namedCircles, spoken);
      if (ambiguous.length) {
        return {
          blocked: `More than one circle matches that: ${ambiguous
            .map((circle) => circle.name)
            .join(", ")}. Say which one.`,
        };
      }
      if (!match) {
        return {
          blocked: `You do not have a circle by that name. Your circles are: ${circleNames}.`,
        };
      }
      return { circle: match };
    },
    [namedCircles],
  );

  /** Shared by the accept/decline circle-invitation voice handlers. */
  const resolveVoiceCircleInvite = useCallback(
    (
      spoken: string,
    ): { invite: OneLocationCircleMemberInvite } | { blocked: string } => {
      if (!incomingCircleMemberInvites.length) {
        return { blocked: "You do not have any pending circle invitations." };
      }
      if (!spoken) {
        const [onlyInvite] = incomingCircleMemberInvites;
        if (onlyInvite && incomingCircleMemberInvites.length === 1) {
          return { invite: onlyInvite };
        }
        return {
          blocked: `Say which circle: ${incomingCircleMemberInvites
            .map((invite) => invite.circleName)
            .join(", ")}.`,
        };
      }
      const resolved = resolveBySpokenName(
        incomingCircleMemberInvites,
        spoken,
        (invite) => invite.circleName,
      );
      if (resolved.kind === "none") {
        return {
          blocked: `No pending invitation matches that circle name. Your invitations are: ${incomingCircleMemberInvites
            .map((invite) => invite.circleName)
            .join(", ")}.`,
        };
      }
      if (resolved.kind === "many") {
        return {
          blocked: `More than one invitation matches that: ${ambiguousMatchNames(
            resolved.matches,
            (invite) => invite.circleName,
          )}. Say which one.`,
        };
      }
      return { invite: resolved.match };
    },
    [incomingCircleMemberInvites],
  );

  useLocalOnboardingActionHandler("location.create_circle", async (slots) => {
    const spokenName = String(slots?.name ?? "").trim();
    if (!spokenName) {
      return {
        status: "blocked" as const,
        summary: "Say what you want to call the circle.",
      };
    }
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot create a circle while the vault is locked.",
      };
    }
    const spokenKind = String(slots?.kind ?? "")
      .trim()
      .toLowerCase();
    const kind: OneLocationCircleKind =
      spokenKind === "family"
        ? "family"
        : spokenKind === "friends"
          ? "friends"
          : "other";
    // Exact name only. A near match must still create the circle the person
    // asked for; silently treating "Family trip" as the existing "Family" would
    // leave them adding people to the wrong group.
    const duplicate = namedCircles.find(
      (circle) =>
        normalizeSpokenName(circle.name) === normalizeSpokenName(spokenName),
    );
    if (duplicate) {
      return {
        status: "succeeded" as const,
        summary: `You already have a circle called ${duplicate.name}.`,
      };
    }
    try {
      const circle = await handleCreateNamedCircle(spokenName, kind);
      return {
        status: "succeeded" as const,
        summary: `Created the circle ${circle.name}. Nobody is in it yet -- say who to add.`,
      };
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(error, "Could not create the circle."),
      };
    }
  });

  useLocalOnboardingActionHandler("location.add_to_circle", async (slots) => {
    const spokenPerson = String(slots?.person ?? "").trim();
    if (!spokenPerson) {
      return {
        status: "blocked" as const,
        summary: "Say who you want to add to the circle.",
      };
    }
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see your circles while the vault is locked.",
      };
    }
    const resolved = resolveVoiceCircle(String(slots?.circle ?? "").trim());
    if ("blocked" in resolved) {
      return { status: "blocked" as const, summary: resolved.blocked };
    }
    const circle = resolved.circle;
    if (circle.viewerCapabilities?.canInviteMembers === false) {
      return {
        status: "blocked" as const,
        summary: `You cannot invite people to ${circle.name}. Only its owner can.`,
      };
    }
    let eligible: OneLocationCircleEligibleConnections;
    try {
      eligible = await handleLoadNamedCircleEligibleConnections(circle.id);
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(
          error,
          "Could not check who can be added to that circle.",
        ),
      };
    }
    const target = normalizeSpokenName(spokenPerson);
    // Answer about an invitation that already exists rather than sending a
    // second one the other person would see twice.
    const alreadyInvited = eligible.pendingInvites.find(
      (invite) =>
        invite.status === "pending" &&
        normalizeSpokenName(String(invite.inviteeDisplayName ?? "")).includes(
          target,
        ),
    );
    if (alreadyInvited) {
      return {
        status: "succeeded" as const,
        summary: `${alreadyInvited.inviteeDisplayName} already has a pending invitation to ${circle.name}.`,
      };
    }
    // Server-authoritative: eligible connections already exclude current
    // members and anyone not connected, so a match here is genuinely addable.
    const matches = eligible.eligibleConnections.filter((connection) =>
      normalizeSpokenName(connection.displayName).includes(target),
    );
    if (matches.length === 0) {
      return {
        status: "blocked" as const,
        summary: `Nobody who can be added to ${circle.name} matches that name. They have to be connected to you and not already in it.`,
      };
    }
    if (matches.length > 1) {
      return {
        status: "blocked" as const,
        summary: `More than one person matches that name: ${matches
          .map((connection) => connection.displayName)
          .join(", ")}. Say which one.`,
      };
    }
    if (eligible.remainingCapacity < 1) {
      return {
        status: "blocked" as const,
        summary: `${circle.name} is already at its member limit.`,
      };
    }
    const invitee = matches[0];
    if (!invitee) {
      return {
        status: "blocked" as const,
        summary: `Nobody who can be added to ${circle.name} matches that name.`,
      };
    }
    try {
      await handleInviteNamedCircleConnections(circle.id, [invitee.userId]);
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(
          error,
          "Could not send that circle invitation.",
        ),
      };
    }
    scheduleNamedCircleStateRefresh();
    // "Invited", never "added". Joining is the other person's decision, and
    // reporting it as done would claim a consent that has not been given.
    return {
      status: "succeeded" as const,
      summary: `Invited ${invitee.displayName} to ${circle.name}. They join once they accept.`,
    };
  });

  useLocalOnboardingActionHandler(
    "location.remove_from_circle",
    async (slots) => {
      const spokenPerson = String(slots?.person ?? "").trim();
      if (!spokenPerson) {
        return {
          status: "blocked" as const,
          summary: "Say who you want to remove from the circle.",
        };
      }
      if (!vaultOwnerToken) {
        return {
          status: "blocked" as const,
          summary:
            "Unlock One first -- I cannot see your circles while the vault is locked.",
        };
      }
      const resolved = resolveVoiceCircle(String(slots?.circle ?? "").trim());
      if ("blocked" in resolved) {
        return { status: "blocked" as const, summary: resolved.blocked };
      }
      const circle = resolved.circle;
      if (circle.viewerCapabilities?.canManageCircle === false) {
        return {
          status: "blocked" as const,
          summary: `You cannot change who is in ${circle.name}. Only its owner can.`,
        };
      }
      let detail: OneLocationCircleDetail;
      try {
        detail = await handleLoadNamedCircle(circle.id);
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(
            error,
            "Could not load who is in that circle.",
          ),
        };
      }
      const target = normalizeSpokenName(spokenPerson);
      // Only people actually IN the circle. Matching the wider connection list
      // would let "remove Sarah" report success about somebody who was never a
      // member, leaving the real membership untouched and the person believing
      // otherwise.
      const matches = detail.members.filter((member) =>
        normalizeSpokenName(member.displayName).includes(target),
      );
      if (matches.length === 0) {
        return {
          status: "blocked" as const,
          summary: `Nobody in ${circle.name} matches that name.`,
        };
      }
      if (matches.length > 1) {
        return {
          status: "blocked" as const,
          summary: `More than one person in ${circle.name} matches that name: ${matches
            .map((member) => member.displayName)
            .join(", ")}. Say which one.`,
        };
      }
      const member = matches[0];
      if (!member) {
        return {
          status: "blocked" as const,
          summary: `Nobody in ${circle.name} matches that name.`,
        };
      }
      if (member.role === "owner") {
        return {
          status: "blocked" as const,
          summary: `${member.displayName} owns ${circle.name}, so they cannot be removed from it.`,
        };
      }
      if (slots?.confirmed !== true) {
        // Removing someone from a circle takes away what that circle shared
        // with them. It is not the person's own data to put back, so this is
        // shown before it happens rather than reported afterwards.
        return {
          status: "blocked" as const,
          summary: `Removing ${member.displayName} from ${circle.name} needs a confirmation.`,
          data: {
            [VOICE_CONFIRM_DATA_KEY]: {
              actionId: "location.remove_from_circle",
              slots: {
                person: spokenPerson,
                circle: String(slots?.circle ?? ""),
                confirmed: true,
              },
              prompt: `Remove ${member.displayName} from ${circle.name}?`,
              subject: { name: member.displayName, detail: circle.name },
              consequence:
                getKaiActionById("location.remove_from_circle")?.meaning ?? null,
              confirmLabel: "Remove",
            },
          },
        };
      }
      try {
        await handleRemoveNamedCircleMember(circle.id, member.userId);
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(
            error,
            "Could not remove that person from the circle.",
          ),
        };
      }
      return {
        status: "succeeded" as const,
        summary: `Removed ${member.displayName} from ${circle.name}. They no longer get your location through it.`,
      };
    },
  );

  useLocalOnboardingActionHandler("location.rename_circle", async (slots) => {
    const spokenName = String(slots?.name ?? "").trim();
    if (!spokenName) {
      return {
        status: "blocked" as const,
        summary: "Say what you want to rename the circle to.",
      };
    }
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see your circles while the vault is locked.",
      };
    }
    const resolved = resolveVoiceCircle(String(slots?.circle ?? "").trim());
    if ("blocked" in resolved) {
      return { status: "blocked" as const, summary: resolved.blocked };
    }
    const circle = resolved.circle;
    if (circle.viewerCapabilities?.canManageCircle === false) {
      return {
        status: "blocked" as const,
        summary: `You cannot rename ${circle.name}. Only its owner can.`,
      };
    }
    // Exact name only, same discipline as creating one -- a near match must
    // still rename to what was actually said rather than silently no-op'ing.
    if (normalizeSpokenName(circle.name) === normalizeSpokenName(spokenName)) {
      return {
        status: "succeeded" as const,
        summary: `${circle.name} is already called that.`,
      };
    }
    const duplicate = namedCircles.find(
      (other) =>
        other.id !== circle.id &&
        normalizeSpokenName(other.name) === normalizeSpokenName(spokenName),
    );
    if (duplicate) {
      return {
        status: "blocked" as const,
        summary: `You already have a circle called ${duplicate.name}. Pick a different name.`,
      };
    }
    try {
      const renamed = await handleRenameNamedCircle(circle.id, spokenName);
      return {
        status: "succeeded" as const,
        summary: `Renamed ${circle.name} to ${renamed.name}.`,
      };
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(error, "Could not rename the circle."),
      };
    }
  });

  useLocalOnboardingActionHandler("location.leave_circle", async (slots) => {
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see your circles while the vault is locked.",
      };
    }
    const resolved = resolveVoiceCircle(String(slots?.circle ?? "").trim());
    if ("blocked" in resolved) {
      return { status: "blocked" as const, summary: resolved.blocked };
    }
    const circle = resolved.circle;
    if (circle.role === "owner") {
      return {
        status: "blocked" as const,
        summary: `You own ${circle.name}, so you cannot leave it. Delete it instead, or hand off ownership first.`,
      };
    }
    if (slots?.confirmed !== true) {
      // Leaving takes away what this circle was sharing with the person, and
      // is not always reversible if the owner does not re-invite them.
      return {
        status: "blocked" as const,
        summary: `Leaving ${circle.name} needs a confirmation.`,
        data: {
          [VOICE_CONFIRM_DATA_KEY]: {
            actionId: "location.leave_circle",
            slots: { circle: String(slots?.circle ?? ""), confirmed: true },
            prompt: `Leave ${circle.name}?`,
            subject: { name: circle.name, detail: null },
            consequence:
              getKaiActionById("location.leave_circle")?.meaning ?? null,
            confirmLabel: "Leave",
          },
        },
      };
    }
    try {
      await handleLeaveNamedCircle(circle.id);
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(error, "Could not leave the circle."),
      };
    }
    return {
      status: "succeeded" as const,
      summary: `You left ${circle.name}.`,
    };
  });

  useLocalOnboardingActionHandler("location.delete_circle", async (slots) => {
    if (!vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary:
          "Unlock One first -- I cannot see your circles while the vault is locked.",
      };
    }
    const resolved = resolveVoiceCircle(String(slots?.circle ?? "").trim());
    if ("blocked" in resolved) {
      return { status: "blocked" as const, summary: resolved.blocked };
    }
    const circle = resolved.circle;
    if (circle.role !== "owner") {
      return {
        status: "blocked" as const,
        summary: `You cannot delete ${circle.name}. Only its owner can -- leave it instead.`,
      };
    }
    if (slots?.confirmed !== true) {
      return {
        status: "blocked" as const,
        summary: `Deleting ${circle.name} needs a confirmation.`,
        data: {
          [VOICE_CONFIRM_DATA_KEY]: {
            actionId: "location.delete_circle",
            slots: { circle: String(slots?.circle ?? ""), confirmed: true },
            prompt: `Delete ${circle.name}? Everyone in it loses access through it.`,
            subject: {
              name: circle.name,
              detail: `${circle.memberCount} member${circle.memberCount === 1 ? "" : "s"}`,
            },
            consequence:
              getKaiActionById("location.delete_circle")?.meaning ?? null,
            confirmLabel: "Delete",
          },
        },
      };
    }
    try {
      await handleDeleteNamedCircle(circle.id);
    } catch (error) {
      return {
        status: "failed" as const,
        summary: oneLocationErrorMessage(error, "Could not delete the circle."),
      };
    }
    return {
      status: "succeeded" as const,
      summary: `Deleted ${circle.name}.`,
    };
  });

  useLocalOnboardingActionHandler(
    "location.accept_circle_invite",
    async (slots) => {
      if (!vaultOwnerToken) {
        return {
          status: "blocked" as const,
          summary:
            "Unlock One first -- I cannot see your circle invitations while the vault is locked.",
        };
      }
      const resolved = resolveVoiceCircleInvite(
        String(slots?.circle ?? "").trim(),
      );
      if ("blocked" in resolved) {
        return { status: "blocked" as const, summary: resolved.blocked };
      }
      try {
        await handleAcceptNamedCircleMemberInvite(resolved.invite.id);
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(error, "Could not join the circle."),
        };
      }
      return {
        status: "succeeded" as const,
        summary: `Joined ${resolved.invite.circleName}.`,
      };
    },
  );

  useLocalOnboardingActionHandler(
    "location.decline_circle_invite",
    async (slots) => {
      if (!vaultOwnerToken) {
        return {
          status: "blocked" as const,
          summary:
            "Unlock One first -- I cannot see your circle invitations while the vault is locked.",
        };
      }
      const resolved = resolveVoiceCircleInvite(
        String(slots?.circle ?? "").trim(),
      );
      if ("blocked" in resolved) {
        return { status: "blocked" as const, summary: resolved.blocked };
      }
      try {
        await handleDeclineNamedCircleMemberInvite(resolved.invite.id);
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(
            error,
            "Could not decline the invitation.",
          ),
        };
      }
      return {
        status: "succeeded" as const,
        summary: `Declined the invitation to ${resolved.invite.circleName}.`,
      };
    },
  );

  useLocalOnboardingActionHandler(
    "location.save_current_location",
    async (slots) => {
      const spokenLabel = String(slots?.label ?? "").trim();
      if (!spokenLabel) {
        return {
          status: "blocked" as const,
          summary:
            "Say what to call this place -- home, work, or a name like the gym.",
        };
      }
      if (!vaultKey || !vaultOwnerToken || !auth.userId) {
        return {
          status: "blocked" as const,
          summary: "Unlock One first -- I cannot save a place while the vault is locked.",
        };
      }
      const normalized = normalizeSpokenName(spokenLabel);
      const category: SavedLocationCategory =
        normalized === "home" ? "home" : normalized === "work" ? "work" : "other";
      const readiness = await ensureForegroundLocationReady({
        capturePoint: true,
        announce: false,
      });
      if (!readiness.ready || !readiness.point) {
        return {
          status: "failed" as const,
          summary:
            "Could not get your current location. Check that location access is on and try again.",
        };
      }
      try {
        await addSavedLocation({
          context: { userId: auth.userId, vaultKey, vaultOwnerToken },
          input: {
            category,
            label: spokenLabel,
            latitude: readiness.point.latitude,
            longitude: readiness.point.longitude,
          },
        });
      } catch (error) {
        if (error instanceof DuplicateSavedLocationError) {
          return {
            status: "succeeded" as const,
            summary: `You already have a saved place near here called ${error.existingLabel}.`,
          };
        }
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(error, "Could not save this location."),
        };
      }
      return {
        status: "succeeded" as const,
        summary:
          category === "other"
            ? `Saved this location as ${spokenLabel}.`
            : `Saved this location as ${defaultLabelForCategory(category)}.`,
      };
    },
  );

  useLocalOnboardingActionHandler(
    "location.delete_saved_location",
    async (slots) => {
      const spokenLabel = String(slots?.label ?? "").trim();
      if (!vaultKey || !vaultOwnerToken || !auth.userId) {
        return {
          status: "blocked" as const,
          summary:
            "Unlock One first -- I cannot see your saved places while the vault is locked.",
        };
      }
      let saved: SavedLocation[];
      try {
        saved = await loadSavedLocations({
          userId: auth.userId,
          vaultKey,
          vaultOwnerToken,
        });
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(error, "Could not load your saved places."),
        };
      }
      if (!saved.length) {
        return {
          status: "blocked" as const,
          summary: "You do not have any saved places yet.",
        };
      }
      let target: SavedLocation | undefined;
      if (!spokenLabel && saved.length === 1) {
        target = saved[0];
      } else {
        const resolved = resolveBySpokenName(saved, spokenLabel, (loc) => loc.label);
        if (resolved.kind === "none") {
          return {
            status: "blocked" as const,
            summary: spokenLabel
              ? `No saved place matches that name. Your saved places are: ${saved
                  .map((loc) => loc.label)
                  .join(", ")}.`
              : `Say which saved place: ${saved.map((loc) => loc.label).join(", ")}.`,
          };
        }
        if (resolved.kind === "many") {
          return {
            status: "blocked" as const,
            summary: `More than one saved place matches that: ${ambiguousMatchNames(
              resolved.matches,
              (loc) => loc.label,
            )}. Say which one.`,
          };
        }
        target = resolved.match;
      }
      if (!target) {
        return {
          status: "blocked" as const,
          summary: "You do not have any saved places yet.",
        };
      }
      const resolvedTarget = target;
      if (slots?.confirmed !== true) {
        return {
          status: "blocked" as const,
          summary: `Deleting ${resolvedTarget.label} needs a confirmation.`,
          data: {
            [VOICE_CONFIRM_DATA_KEY]: {
              actionId: "location.delete_saved_location",
              slots: { label: spokenLabel, confirmed: true },
              prompt: `Delete the saved place called ${resolvedTarget.label}?`,
              subject: {
                name: resolvedTarget.label,
                detail: resolvedTarget.address ?? null,
              },
              consequence:
                getKaiActionById("location.delete_saved_location")?.meaning ?? null,
              confirmLabel: "Delete",
            },
          },
        };
      }
      try {
        await removeSavedLocation({
          context: { userId: auth.userId, vaultKey, vaultOwnerToken },
          id: resolvedTarget.id,
        });
      } catch (error) {
        return {
          status: "failed" as const,
          summary: oneLocationErrorMessage(error, "Could not delete that saved place."),
        };
      }
      return {
        status: "succeeded" as const,
        summary: `Deleted ${resolvedTarget.label}.`,
      };
    },
  );

  // A tap-only child (`CheckInFlow`) owns the check-in draft's selection state
  // and cannot be called into directly. Bumping this and threading it through
  // `LocationHubViewModel` lets that component notice and submit its OWN
  // already-seeded draft, instead of page.tsx trying to reconstruct it.
  const [voiceCheckInSendRequestId, setVoiceCheckInSendRequestId] =
    useState(0);
  const triggerVoiceCheckInSend = useCallback(() => {
    setVoiceCheckInSendRequestId((current) => current + 1);
  }, []);

  useLocalOnboardingActionHandler("location.send_check_in", async () => {
    const currentAction = searchParams.get("action");
    if (currentAction !== "check-in" && currentAction !== "event-check-in") {
      return {
        status: "blocked" as const,
        summary: "Open Check-In first, then say send it.",
      };
    }
    const readyRecipients = sosActionRecipients.filter((recipient) =>
      isShareReadyRecipient(recipient),
    );
    if (!readyRecipients.length) {
      return {
        status: "blocked" as const,
        summary: "You do not have anyone ready to check in with yet.",
      };
    }
    if (!myLocationPoint) {
      return {
        status: "blocked" as const,
        summary: "I need a location fix first -- give it a moment and try again.",
      };
    }
    triggerVoiceCheckInSend();
    return {
      status: "succeeded" as const,
      summary: "Sending your check-in.",
    };
  });

  const handleAutoApproveChange = useCallback(
    (enabled: boolean) => {
      updateOneLocationControlState(auth.userId, (current) => ({
        ...current,
        autoApproveRequestsEnabled: enabled,
      }));
      // Say what it does NOT cover. Someone switching this on while people are
      // already waiting will otherwise read the empty approvals list they were
      // expecting, find it unchanged, and conclude the switch is broken.
      toast.success(
        enabled
          ? pendingOwnerRequests.length
            ? "New location requests will be approved automatically. The ones already waiting are still yours to answer."
            : "New location requests will be approved automatically."
          : "You will be asked about each location request again.",
      );
    },
    [auth.userId, pendingOwnerRequests.length],
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
            "Check permission and try again.",
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
        // The finale's copy. Same value, different lifetime: this one has to
        // outlive the modal below, because the map that uses it comes after it.
        setOnboardingConfirmedPoint(point);
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
      /**
       * The address line exactly as the modal had it when Save was pressed.
       * The modal already dropped this in favour of `saveLocationAddress`
       * state, which is null for the whole of root setup -- there is no vault
       * token yet, so nothing ever reverse-geocodes into it. The place then
       * saved with no address at all, which is what "address is not
       * populating" looked like once it reached the vault.
       */
      addressLine?: string | null,
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
        // What was on screen wins over what state happened to hold.
        const composedFrom =
          (typeof addressLine === "string" ? addressLine.trim() : "") ||
          saveLocationAddress;
        const input = {
          category,
          label,
          latitude: saveLocationPoint.latitude,
          longitude: saveLocationPoint.longitude,
          address: details
            ? buildSavedLocationAddress(composedFrom, details)
            : composedFrom,
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
        // Confirming a place turns the live preview on.
        //
        // Onboarding captures a position directly rather than through
        // `ensureForegroundLocationReady`, so it never reached
        // `activateMyLocation` and never set `selfPreviewEnabled`. A brand-new
        // owner also has no grants and no nearby presence, so all three
        // disjuncts behind `locationEnabled` were false and the hub they are
        // redirected to greeted them with "Location off" — seconds after they
        // granted permission, let the device take a fix, dragged a pin and
        // tagged it Home. Saving a place really is a different authority from
        // sharing one, but "my location is off" is not a true reading of the
        // state the person just created.
        //
        // The same two-field write the header switch itself performs, so both
        // entry points leave the control in one state.
        updateOneLocationControlState(auth.userId, (current) => ({
          ...current,
          paused: false,
          selfPreviewEnabled: true,
        }));
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
    // Dismissing the saved-place picker must stay reversible during onboarding.
    // Going back and continuing again should offer the picker again.
    savedLocationPromptedRef.current = false;
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
      const selectedPoint: PlainLocationPoint = {
        ...saveLocationPoint,
        latitude: place.latitude,
        longitude: place.longitude,
        accuracyM: null,
        capturedAt: new Date().toISOString(),
      };
      setSaveLocationPoint(selectedPoint);
      // Choosing a different address moves the finale's camera too: the point
      // the person confirmed is the one the last screen should show.
      setOnboardingConfirmedPoint(selectedPoint);
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
      // Stamped once, outside the updater: a state updater has to be pure, and
      // one that reads the clock hands back a different point each time React
      // chooses to re-run it.
      const pickedAt = new Date().toISOString();
      setSaveLocationPoint((current) => ({
        latitude: picked.latitude,
        longitude: picked.longitude,
        accuracyM: null,
        capturedAt: pickedAt,
        sourcePlatform: current?.sourcePlatform ?? "web",
      }));
      // Dragging the pin is the most deliberate statement of "I am here" this
      // flow ever gets, so the finale honours it. Only the coordinate is read
      // there, which is why this copy does not need the platform above.
      setOnboardingConfirmedPoint({
        latitude: picked.latitude,
        longitude: picked.longitude,
        accuracyM: null,
        capturedAt: pickedAt,
        sourcePlatform: "web",
      });
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
      // "Locate me" drops a pin, so it needs a current fix — but only current,
      // not brand new. A reading from the last few seconds puts the pin in the
      // same place and saves the user a full acquisition.
      const point = await OneLocationService.captureCurrentPosition({
        fresh: true,
      });
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

      if (permission?.state === "restricted") {
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

      if (
        requestedPermission.state !== "granted" &&
        !(await OneLocationService.captureCurrentPosition()
          .then(() => true)
          .catch(() => false))
      ) {
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
    // Onboarding's own retry, unchanged: it owns the flag and the ordering that
    // the saved-place prompt depends on.
    const refreshIfPending = () => {
      if (!locationOnboardingRetryOnResumeRef.current) return;
      locationOnboardingRetryOnResumeRef.current = false;
      void refreshLocationPermission();
    };
    // Separately, and for everyone: permission is changed outside the app — iOS
    // Settings, Safari's site settings, the Android sheet — so coming back is
    // exactly when our copy of it is most likely to be stale. Re-reading only
    // behind onboarding's flag left every other surface showing an old verdict
    // until a full reload.
    const refreshPermissionOnReturn = () => {
      void refreshLocationPermission().then((next) => {
        // Once it is actually granted, an old observed denial is history, so
        // the UI stops claiming "blocked" the moment that stops being true.
        if (next?.state === "granted") {
          observedLocationDenialRef.current = false;
          setLocationDenialObserved(false);
        }
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") return;
      refreshIfPending();
      refreshPermissionOnReturn();
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
          locationPermission={permission}
          notificationDeliveryMode={notificationDeliveryMode}
          notificationBusy={isRetryingPushRegistration}
          locationBusy={locationOnboardingBusy}
          nativeTest={nativeTestConfig}
          // Setup hands back to the wizard to finish the remaining capabilities;
          // the workspace lands on the Location hub. Naming the destination beats
          // a generic "Done" that leaves the person guessing.
          completeLabel={mode === "setup" ? "Finish" : "Open One Location"}
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
          // Always passed. This used to be withheld without a vault, which made
          // the flow drop the invite screen entirely -- hiding it from exactly
          // the first-run people onboarding exists for. The handler now falls
          // back to the pre-vault bootstrap call, so the screen is always
          // reachable and a failure degrades to its own retry rather than to a
          // missing screen.
          // The point onboarding already captured for the save-place step.
          // Reused rather than re-requested: asking the device twice for the
          // same fix costs a second permission round-trip and a visible delay
          // on the one screen that has to feel instant. Null renders the
          // stylised map, which is a composed screen rather than an error.
          //
          // It reads `onboardingConfirmedPoint`, NOT `saveLocationPoint`. That
          // is the whole fix: the modal's draft is nulled when the modal
          // closes, two screens before this map exists, so feeding the finale
          // from it meant the finale was fed null on every run. See the state
          // declaration above for the full account.
          mapPoint={onboardingFinaleMapPoint}
          contactsStepAvailable={contactsStepAvailable}
          onPreviewCircleCode={handlePreviewCircleCode}
          onAcceptCircleCode={handleAcceptCircleCode}
          onSyncOnboardingContacts={handleSyncOnboardingContacts}
          onAddOnboardingContact={handleAddOnboardingContact}
          onOpenContactSettings={() => void openContactPermissionSettings()}
          onPrepareOnboardingCircleInvite={handlePrepareOnboardingCircleInvite}
          onCopyOnboardingCircleCode={handleCopyNamedCircleCode}
          onShareOnboardingCircleCode={handleShareOnboardingCircleInvite}
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
          onSave={(category, label, details, addressLine) =>
            void handleSaveOnboardingLocation(
              category,
              label,
              details,
              addressLine,
            )
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
    withdrawingRequestId,
    shareCompletedTick,
    shareCompletedDestination: shareCompletedDestinationRef.current,
    readiness: {
      tone: locationReadiness.tone,
      title: locationReadiness.title,
      description: locationReadiness.description,
      actionLabel: locationReadiness.actionLabel ?? null,
    },
    permissionIsPrompt: permission?.state === "prompt",
    locationEnabled,
    locationBlocked:
      resolveLocationReadiness({
        permission,
        hasFix: Boolean(myLocationPoint),
        observedDenial: locationDenialObserved,
      }) === "blocked",
    autoApproveRequestsEnabled: locationControl.autoApproveRequestsEnabled,
    mapPresenceEnabled,
    onMapPresenceChange: handleMapPresenceChange,
    locationPaused: locationControl.paused,
    locationAccuracyLimited,
    // The switch is already on and the device has not found us yet. This is the
    // honest replacement for the old disabled-and-pulsing switch: the control
    // stays live and the STATUS carries the waiting, instead of the person
    // being locked out of a control that looks stuck.
    locationAcquiring:
      locationEnabled && !myLocationPoint && busy === "selfLocation",
    myLocationPoint,
    myLocationError,
    recipients: shareRecipientPool,
    circles: namedCircles,
    selectedShareCircleSelection,
    incomingCircleMemberInvites,
    incomingCircleMemberInvitesLoading,
    incomingCircleMemberInvitesError,
    incomingCircleMemberInviteFocusResolved:
      !focusedCircleMemberInviteId ||
      resolvedCircleMemberInviteFocusId === focusedCircleMemberInviteId,
    visibleRecipients,
    visibleShareRecipients,
    activeOwnerGrants,
    liveShare: liveShareStatus,
    onLiveShareEnded: handleLiveShareEnded,
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
    onSelectShareCircle: handleSelectNamedCircleForShare,
    onResolveNamedCircleRecipients: handleResolveNamedCircleRecipients,
    toggleRequestOwner: (id) => toggleRequestOwner(id, "section_list"),
    onShowMyLocation: () => void handleShowMyLiveLocation(),
    onHideMyLocation: () => void handleHideMyLiveLocation(),
    onAutoApproveRequestsChange: handleAutoApproveChange,
    onRequestPermission: () => void handleRequestLocationPermission(),
    onOpenLocationSettings: () => void handleOpenLocationSettings(),
    onSyncContacts: () => void handleSyncContactSignal(),
    onOpenShareReview: () => void handleOpenShareReview(),
    onEnterShareConfirm: announceShareReviewOpened,
    onConfirmShare: () => void handleShare(),
    onSendRequest: (reason) => handleRequestAccess(reason),
    onApprove: (request) => void handleApprove(request),
    onDeny: (requestId) => void handleDeny(requestId),
    onWithdrawRequest: (requestId) => void handleWithdrawRequest(requestId),
    onViewGrant: (grant) => void handleView(grant),
    onStopGrant: (grantId) => void handleRevoke(grantId),
    onAskReshare: (grant) => void handleAskReshare(grant),
    editingGrantId,
    savingGrantId,
    onEditGrantStart: (grantId) => {
      // Open on what the share actually has left, not on a constant. The
      // editor used to say "1 hour" above a row reading "30 more min", so
      // the field was never the current duration and Save on the untouched
      // default asked for MORE time instead of changing anything.
      setEditGrantDurationHours(
        defaultEditDurationHours(
          activeReceivedGrants.find((grant) => grant.id === grantId),
          Date.now(),
        ),
      );
      setEditingGrantId(grantId);
    },
    onEditGrantCancel: () => setEditingGrantId(null),
    liveShareDurationEditing,
    liveShareDurationHours,
    setLiveShareDurationHours,
    liveShareDurationSaving,
    onEditLiveShareDurationStart: handleEditLiveShareDurationStart,
    onEditLiveShareDurationCancel: () => setLiveShareDurationEditing(false),
    onSaveLiveShareDuration: () => void handleSaveLiveShareDuration(),
    editGrantDurationHours,
    setEditGrantDurationHours,
    onEditGrantSave: (params) =>
      void handleEditGrantDuration(params, Number(editGrantDurationHours)),
    onCreatePublicInvite: () => void handleCreatePublicInvite(),
    onCopyPublicInvite: () => void handleCopyPublicInvite(),
    onSharePublicInvite: () => void handleSharePublicInvite(),
    onRevokePublicInvite: (invite) => void handleRevokePublicInvite(invite),
    onCreateCircleInvite: () => void handleCreateCircleInvite(),
    onCopyCircleInvite: () => void handleCopyCircleInvite(),
    onShareCircleInvite: () => void handleShareCircleInvite(),
    onRevokeCircleInvite: (invite) => void handleRevokeCircleInvite(invite),
    onLoadNamedCircle: handleLoadNamedCircle,
    onCreateNamedCircle: handleCreateNamedCircle,
    onRenameNamedCircle: handleRenameNamedCircle,
    onResolveNamedCircleCode: handleResolveNamedCircleCode,
    onJoinNamedCircle: handleJoinNamedCircle,
    onGenerateNamedCircleCode: handleGenerateNamedCircleCode,
    onCopyNamedCircleCode: handleCopyNamedCircleCode,
    onShareNamedCircleCode: handleShareNamedCircleCode,
    onShareNamedCircleCodeById: handleShareNamedCircleCodeById,
    onRemoveNamedCircleMember: handleRemoveNamedCircleMember,

    onLoadNamedCircleEligibleConnections:
      handleLoadNamedCircleEligibleConnections,
    onInviteNamedCircleConnections: handleInviteNamedCircleConnections,
    onAcceptNamedCircleMemberInvite:
      handleAcceptNamedCircleMemberInvite,
    onDeclineNamedCircleMemberInvite:
      handleDeclineNamedCircleMemberInvite,
    onCancelNamedCircleMemberInvite:
      handleCancelNamedCircleMemberInvite,
    onRetryNamedCircleMemberInvites: () =>
      void refreshIncomingCircleMemberInvites(),
    onLeaveNamedCircle: handleLeaveNamedCircle,
    onDeleteNamedCircle: handleDeleteNamedCircle,
    prepareNamedCircleShare,
    clearNamedCircleShareContext,
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
    expiresCountdownLabel: (value) =>
      expiresCountdownLabel(value, nowMs) ?? "Active",
    nowMs,
    renderMapPreview: (point, showNavigation, viewportResetKey, staleAction) => (
      <LocalMapPreview
        point={point}
        showNavigation={showNavigation}
        viewportResetKey={`${mapViewportResetKey}:${viewportResetKey ?? "default"}`}
        staleAction={staleAction}
      />
    ),
    mapLocationHref: googleMapsLocationUrl,
    decryptedPoints,
    // The page has always computed these on every five-second poll; until now
    // the only component that rendered them was the retired legacy UI below,
    // so a recipient waiting on a first point — the most common receiving
    // state — saw a card with a name, a date, and no explanation at all.
    grantViewStatuses: grantViewErrors,
    reverseGeocodePoint: (point) =>
      reverseGeocodeForSavedLocation(point.latitude, point.longitude),
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
    onAddSmsCircle: handleAddSmsCircle,
    onRemoveSmsContact: handleRemoveSmsContact,
    onCheckIn: handleCheckIn,
    onDiscardPrivateCheckInOperation: discardPrivateCheckInOperation,
    voiceCheckInSendRequestId,
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
        width="agent"
        className="relative isolate"
        nativeTest={nativeTestConfig}
      >
        <AppPageContentRegion className="min-w-0 space-y-4 overflow-x-hidden">
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
            <>
              {/* A running share is the one thing here that cannot wait for the
                  network — it is already happening. Hiding a live privacy state
                  behind a spinner is exactly what made a one-hour share look
                  forgotten on the way back to this screen. Stopping works from
                  here too; it needs the grant id, not the workspace. */}
              {liveShareStatus ? (
                <LiveShareStatusCard
                  status={liveShareStatus}
                  onManage={() =>
                    router.push("/one/location?action=active-shares")
                  }
                  onStop={
                    liveShareStatus.stoppableGrantId
                      ? () =>
                          void handleRevoke(
                            liveShareStatus.stoppableGrantId ?? "",
                          )
                      : undefined
                  }
                  stopBusy={
                    Boolean(liveShareStatus.stoppableGrantId) &&
                    revokingGrantId === liveShareStatus.stoppableGrantId
                  }
                  onEnded={handleLiveShareEnded}
                />
              ) : null}
              <HushhLoader variant="page" label="Loading location..." />
            </>
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
          description="Share only when you choose."
          icon={MapPin}
          accent="success"
          actionsInlineMobile
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh().catch(() => null)}
              disabled={busy === "load"}
              className="h-9 rounded-full px-3"
              data-voice-control-id="one-location-refresh"
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
                    ? "1 location request waiting."
                    : `${pendingOwnerRequests.length} location requests waiting.`}
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
                            : "Add people to start sharing."
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
                          <p className="px-1 text-right text-[11px] font-medium text-[#8e8e93] dark:text-white/70">
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
                                {expiresLabel(grant)}
                                {grant.durationMode === "until_stopped" ||
                                grant.durationHours == null
                                  ? ""
                                  : ` - ${grant.durationHours}h`}
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
                          {/* What is being asked, before anything else. The
                              amount and whether it is extra time on a live
                              share are the whole decision; the free-text
                              note and timestamp are context underneath. */}
                          <p className="text-[13px] font-semibold leading-relaxed text-[#1c1c1e] dark:text-white">
                            {locationAskPromptLine(request, approvalsNowMs)}
                          </p>
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
                              {/* The button names the amount, so pressing it is
                                  agreeing to a number rather than finding out
                                  which one afterwards. */}
                              {locationApproveActionLabel(
                                request,
                                approvalsNowMs,
                              )}
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
                      const viewError = grantViewErrors[grant.id]?.message;
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
                                expiresCountdownLabel(grant.expiresAt, nowMs) ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-[#34c759]/12 px-2 py-0.5 text-[11px] font-semibold text-[#2dbd5a] dark:bg-[#34c759]/15">
                                    <Clock3
                                      className="h-3 w-3"
                                      aria-hidden="true"
                                    />
                                    {expiresCountdownLabel(grant.expiresAt, nowMs)}
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
                              <LocalMapPreview
                                point={point}
                                staleAction={
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleAskReshare(grant)}
                                    disabled={busy === "request"}
                                    className="h-8 rounded-full border-amber-500/30 bg-white/70 px-3 text-[12px] font-semibold text-amber-800 hover:bg-white dark:border-amber-300/25 dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/15"
                                  >
                                    {busy === "request" ? (
                                      <Loader2
                                        className="mr-1.5 h-3.5 w-3.5 animate-spin"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <Send
                                        className="mr-1.5 h-3.5 w-3.5"
                                        aria-hidden="true"
                                      />
                                    )}
                                    Ask to refresh
                                  </Button>
                                }
                              />
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
                          : "Shared locations appear here."
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
                        description="Responses appear here."
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

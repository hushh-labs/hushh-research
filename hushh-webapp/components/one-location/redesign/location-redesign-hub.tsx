"use client";

/**
 * LocationRedesignHub — mobile-first re-skin of the One Location feature.
 *
 * Figma source of truth: one_location_final_fixed_clean_navigation (node 10:1054),
 * Focused mobile screens organised around three hub tabs (Now | People | Links)
 * plus focused, full-screen task flows (Share / Ask / Invite / Public location link).
 *
 * STRICTLY PRESENTATION + LOCAL VIEW-ROUTING.
 * - All data and every action handler are passed in via `vm` from the existing
 *   page component (hushh-webapp/app/one/location/page.tsx). This component does
 *   NOT call services, encrypt, or mutate consent state. It only renders and
 *   delegates to the existing handlers, so the feature's functionality, consent
 *   gating, analytics, and crypto are unchanged.
 * - The global shell owns the visible tab strip. This route consumes the same
 *   central registry only to render the active swipe panel; focused task flows
 *   hide the shell tabs through their `?action=` route state.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  ChevronRight,
  Link as LinkIcon,
  Lock,
  Map,
  MapPin,
  Navigation,
  Plus,
  Send,
  Shield,
  ShieldCheck,
  UserPlus,
  UsersRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app-ui/page-sections";
import type {
  OneLocationAccessRequest,
  OneLocationCircleInvite,
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { locationStatusLabel } from "@/lib/one-location/location-readiness";
import type { CircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";

import {
  EmptyState,
  SectionCard,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "./primitives";
import { MUTED_TEXT, SECTION_HEADING, SUBCARD_SURFACE } from "./tokens";
import {
  RequestCard,
  SharedWithMeCard,
  TemporaryLinkCard,
  TrustedPersonCard,
} from "./cards";
// LocationTypeSelector stays exported from ./selectors, unused for now, so
// PR #4767 can wire it back to a real precision mode without rebuilding it.
import {
  DurationSelector,
  PersonSearchInput,
  ReasonChips,
  type ReasonValue,
} from "./selectors";
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import {
  QuickActionCard,
  QuickActionsSection,
} from "@/components/one-location/redesign/quick-actions";
import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ROUTES } from "@/lib/navigation/routes";
import {
  CircleDetailFlow,
  CirclesSection,
  CreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import {
  buildNearbyCheckInResumeHref,
  isNearbyPrivateReturnToken,
  NEARBY_PRIVATE_RETURN_TOKEN_PARAM,
} from "@/lib/one-location/nearby-private-navigation";
import type {
  EmergencyInfo,
  EmergencyNumberLookupStatus,
} from "@/lib/one-location/emergency-numbers";
import { ONE_LOCATION_SHARE_NOTE_MAX_LENGTH } from "@/lib/one-location/message-limits";
import { CIRCLE_JOIN_CODE_PARAM } from "@/lib/one-location/circle-join-url";

type ReadinessTone = "ready" | "warning" | "blocked" | "checking";

export const ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS = "0.25";

export type PrivateCheckInResult = {
  succeededRecipientIds: string[];
  failedRecipientIds: string[];
};

export type PrivateCheckInRequest = {
  recipientIds: string[];
  durationHours: string;
  message?: string;
  point: PlainLocationPoint;
  clientOperationId: string;
  confirmedAt: string;
  /** Named-Circle provenance when the check-in was targeted at a Circle. */
  sourceCircleId?: string | null;
};

import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import {
  resolveRegisteredTopShellTabValue,
  TOP_SHELL_TAB_REGISTRY,
} from "@/lib/navigation/top-shell-tabs";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";

const LOCATION_TAB_DEFINITION = TOP_SHELL_TAB_REGISTRY.location;
type LocationHubTab = (typeof LOCATION_TAB_DEFINITION.tabs)[number]["value"];
const LOCATION_HUB_TAB_PARAM = LOCATION_TAB_DEFINITION.queryParam;
const LOCATION_SWIPE_OPTIONS = LOCATION_TAB_DEFINITION.tabs;

function resolveLocationHubTab(value: string | null): LocationHubTab {
  return resolveRegisteredTopShellTabValue(
    LOCATION_TAB_DEFINITION,
    value,
  ) as LocationHubTab;
}

export type LocationHubViewModel = {
  /* identity / gating */
  userId: string | null;
  canShare: boolean;
  busy: string | null;
  /** Id of the grant currently being revoked (per-grant Stop sharing spinner). */
  revokingGrantId: string | null;
  /** Bumped on each successful share so the hub can close the share flow. */
  shareCompletedTick: number;
  /** Where a completed share should land, when not the clean hub. */
  shareCompletedDestination?: string | null;

  /* device + self location */
  readiness: {
    tone: ReadinessTone;
    title: string;
    description: string;
    actionLabel?: string | null;
  };
  permissionIsPrompt: boolean;
  locationEnabled: boolean;
  /**
   * The device has refused location and only its settings can undo that.
   * Distinct from `locationEnabled`, which is the preview control's own state:
   * a user whose location works perfectly still starts with the preview off,
   * and must not be told their location is blocked.
   */
  locationBlocked: boolean;
  autoShareEnabled: boolean;
  locationPaused: boolean;
  locationAccuracyLimited: boolean;
  myLocationPoint: PlainLocationPoint | null;
  myLocationError: string | null;

  /* data lists */
  recipients: OneLocationRecipient[];
  circles: OneLocationCircleSummary[];
  selectedShareCircleSelection: CircleRecipientSelection | null;
  incomingCircleMemberInvites: OneLocationCircleMemberInvite[];
  incomingCircleMemberInvitesLoading: boolean;
  incomingCircleMemberInvitesError: string | null;
  incomingCircleMemberInviteFocusResolved: boolean;
  visibleRecipients: OneLocationRecipient[];
  visibleShareRecipients: OneLocationRecipient[];
  activeOwnerGrants: OneLocationGrant[];
  receivedGrants: OneLocationGrant[];
  pendingOwnerRequests: OneLocationAccessRequest[];
  requestedByMe: OneLocationAccessRequest[];
  latestActivePublicInvite: OneLocationPublicInvite | null;
  latestActiveCircleInvite: OneLocationCircleInvite | null;
  activityReceipts: { id: string; title: string; detail: string }[];

  /* composer state */
  recipientSearch: string;
  shareRecipientSearch: string;
  selectedRecipientIds: string[];
  selectedRequestOwnerIds: string[];
  shareDurationHours: string;
  shareMessage: string;
  durationHours: string;
  requestMessage: string;
  shareReviewOpen: boolean;
  publicInviteUrl: string;
  circleInviteUrl: string;

  /* setters (presentation state owned by page) */
  setRecipientSearch: (v: string) => void;
  setShareRecipientSearch: (v: string) => void;
  setShareDurationHours: (v: string) => void;
  setShareMessage: (v: string) => void;
  setDurationHours: (v: string) => void;
  setRequestMessage: (v: string) => void;
  setShareReviewOpen: (v: boolean) => void;
  resetShareComposer: () => void;
  startShareComposer: (initialRecipientId?: string) => void;

  /* selection */
  toggleShareRecipient: (id: string, surface?: string) => void;
  onSelectShareCircle: (circleId: string) => Promise<void>;
  onResolveNamedCircleRecipients: (
    circleId: string,
    purpose?: "location" | "sms",
  ) => Promise<CircleRecipientSelection>;
  toggleRequestOwner: (id: string, surface?: string) => void;

  /* actions — wired 1:1 to existing handlers */
  onShowMyLocation: () => void;
  onHideMyLocation: () => void;
  onResumeMyLocation: () => void;
  onAutoShareChange: (enabled: boolean) => void;
  onRequestPermission: () => void;
  onOpenLocationSettings: () => void;
  onSyncContacts: () => void;
  onShareToContacts: () => void;
  onOpenShareReview: () => void;
  onConfirmShare: () => void;
  onSendRequest: (reason?: string | null) => void;
  onApprove: (request: OneLocationAccessRequest) => void;
  onDeny: (requestId: string) => void;
  onViewGrant: (grant: OneLocationGrant) => void;
  onStopGrant: (grantId: string) => void;
  onCreatePublicInvite: () => void;
  onCopyPublicInvite: () => void;
  onSharePublicInvite: () => void;
  onRevokePublicInvite: (invite: OneLocationPublicInvite) => void;
  onCreateCircleInvite: () => void;
  onCopyCircleInvite: () => void;
  onShareCircleInvite: () => void;
  onRevokeCircleInvite: (invite: OneLocationCircleInvite) => void;

  /* Durable named Circles. Legacy one-person Circle invites above remain
     isolated for backward compatibility. */
  onLoadNamedCircle: (circleId: string) => Promise<OneLocationCircleDetail>;
  onCreateNamedCircle: (
    name: string,
    kind: OneLocationCircleKind,
  ) => Promise<OneLocationCircleDetail>;
  onRenameNamedCircle: (
    circleId: string,
    name: string,
  ) => Promise<OneLocationCircleDetail>;
  onResolveNamedCircleCode: (
    code: string,
  ) => Promise<OneLocationCircleInvitePreview>;
  onJoinNamedCircle: (
    code: string,
  ) => Promise<{ circle: OneLocationCircleDetail; joined: boolean }>;
  onGenerateNamedCircleCode: (
    circleId: string,
    rotate?: boolean,
  ) => Promise<OneLocationCircleInviteCode>;
  onCopyNamedCircleCode: (code: string) => Promise<void>;
  onShareNamedCircleCode: (
    circle: OneLocationCircleDetail,
    code: string,
  ) => Promise<void>;
  /** Share a Circle's invite code from a surface that only knows its id. */
  onShareNamedCircleCodeById: (circleId: string) => Promise<void>;

  onRemoveNamedCircleMember: (
    circleId: string,
    memberUserId: string,
  ) => Promise<void>;
  onLoadNamedCircleEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onInviteNamedCircleConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onAcceptNamedCircleMemberInvite: (inviteId: string) => Promise<void>;
  onDeclineNamedCircleMemberInvite: (inviteId: string) => Promise<void>;
  onCancelNamedCircleMemberInvite: (inviteId: string) => Promise<void>;
  onRetryNamedCircleMemberInvites: () => void;
  onLeaveNamedCircle: (circleId: string) => Promise<void>;
  onDeleteNamedCircle: (circleId: string) => Promise<void>;
  prepareNamedCircleShare: (circleId: string, recipientUserId: string) => void;
  clearNamedCircleShareContext: () => void;

  /* Save My Soul (internal compatibility identifier remains SOS). */
  /** Connected, share-ready circle used by non-SMS quick actions. */
  sosRecipients: OneLocationRecipient[];
  /** Explicit owner-selected Save My Soul recipients. */
  smsRecipients: OneLocationRecipient[];
  smsContactCandidates: OneLocationRecipient[];
  smsContactUserIds: string[];
  sosActive: boolean;
  sosBusy: boolean;
  sosStartedAtLabel: string | null;
  sosEmergency: EmergencyInfo | null;
  sosEmergencyStatus: EmergencyNumberLookupStatus;
  onResolveSosLocation: () => void;
  // Promise-returning on purpose: SosPanel awaits it to tell a real send from
  // an early bail-out, so narrowing it back to `void` here would strip the
  // signal the panel needs to release its fired latch.
  onTriggerSos: (message?: string | null) => void | Promise<void>;
  onStopSos: () => void;
  onAddSmsContact: (recipientUserId: string) => void;
  onAddSmsCircle: (circleId: string) => Promise<void>;
  onRemoveSmsContact: (recipientUserId: string) => Promise<boolean>;

  /* Check-In (quick action) — reuses the encrypted share pipeline. Circle
     provenance rides in the request's optional sourceCircleId. */
  onCheckIn: (request: PrivateCheckInRequest) => Promise<PrivateCheckInResult>;
  onDiscardPrivateCheckInOperation: (operationId: string | null) => void;

  /* label helpers (reuse existing formatting) */
  recipientLabel: (r: OneLocationRecipient) => string;
  recipientSubtitle: (r: OneLocationRecipient) => string;
  isRecipientShareReady: (r: OneLocationRecipient) => boolean;
  requestOwnerLabel: (r: OneLocationAccessRequest) => string;
  requesterLabel: (r: OneLocationAccessRequest) => string;
  grantRecipientLabel: (g: OneLocationGrant) => string;
  grantOwnerLabel: (g: OneLocationGrant) => string;
  formatDateTime: (value?: string | null) => string;
  expiresLabel: (value?: string | null) => string;
  expiresCountdownLabel: (value?: string | null) => string;

  /* map preview renderer (reuses page LocalMapPreview to keep crypto/view path) */
  renderMapPreview: (
    point: PlainLocationPoint,
    showNavigation?: boolean,
    viewportResetKey?: string | number,
  ) => ReactNode;
  mapLocationHref: (point: PlainLocationPoint) => string;
  decryptedPoints: Record<string, PlainLocationPoint>;
  /**
   * Reverse-geocode a decrypted shared point to a street address. Returns null
   * when unavailable (no vault token, provider error, or no match). Optional so
   * a view model without it degrades to the lat/lng fallback.
   */
  reverseGeocodePoint?: (point: PlainLocationPoint) => Promise<string | null>;
};

type FlowKind =
  | "none"
  | "share"
  | "ask"
  | "invite"
  | "create-circle"
  | "join-circle"
  | "circle-detail"
  | "temp-link"
  | "check-in"
  | "sos"
  | "sms-contacts"
  | "settings"
  | "active-shares"
  | "shared-with-me"
  | "needs-review";

// The open action flow is reflected in the URL as `?action=<slug>` so the single
// top-left back button in the app chrome (and the OS/hardware back button) knows
// to return to the Location hub instead of leaving the whole page to /one.
const FLOW_ACTION_PARAM = "action";
const FLOW_SOURCE_PARAM = "source";
const PRIVATE_CHECK_IN_ACTION = "private-check-in";
const NEARBY_CHECK_IN_SOURCE = "nearby";

const FLOW_TO_ACTION: Record<Exclude<FlowKind, "none">, string> = {
  share: "share",
  ask: "ask",
  invite: "invite",
  "create-circle": "create-circle",
  "join-circle": "join-circle",
  "circle-detail": "circle-detail",
  "temp-link": "temp-link",
  "check-in": "check-in",
  sos: "sos",
  "sms-contacts": "sms-contacts",
  settings: "settings",
  "active-shares": "active-shares",
  "shared-with-me": "shared-with-me",
  "needs-review": "needs-review",
};

const RETIRED_ACTIONS = new Set([
  "drive-to",
  "pick-me-up",
  "meeting",
  "safe-arrival",
]);

const ACTION_TO_FLOW: Record<string, FlowKind> = {
  ...Object.fromEntries(
    Object.entries(FLOW_TO_ACTION).map(([flow, action]) => [
      action,
      flow as FlowKind,
    ]),
  ),
  [PRIVATE_CHECK_IN_ACTION]: "check-in",
};

const LEGACY_ACTION_TO_FLOW: Readonly<Partial<Record<string, FlowKind>>> = {
  privacy: "settings",
};

/**
 * Focus a One-Location notification "Open" deep link resolves to. `detailAction`
 * opens a focused flow (e.g. Shared with me / Needs my review); `nextTab`
 * selects a hub tab.
 */
export type LocationDeepLinkFocus = {
  detailAction: Extract<FlowKind, "needs-review" | "shared-with-me"> | null;
  nextTab: LocationHubTab | null;
};

/**
 * Resolve where a location deep link should land. An explicit `section` (set by
 * the notification "Open" action) ALWAYS wins over the id-presence heuristics:
 * an approval notification carries BOTH the newly created grantId and the
 * originating requestId, so only the section separates "Shared with me"
 * (section=shared) from "Needs my review" (section=approvals). Checking
 * `hasRequest` before the section — as the previous inline logic did — stranded
 * an approved requester on "Needs my review". The id checks remain as fallbacks
 * for legacy links that omit the section.
 */
export function resolveLocationDeepLinkFocus(input: {
  section: string;
  hasRequest: boolean;
  hasGrant: boolean;
  hasSubmission: boolean;
}): LocationDeepLinkFocus {
  const { section, hasRequest, hasGrant, hasSubmission } = input;
  if (section === "approvals" || section === "my_requests") {
    return { detailAction: "needs-review", nextTab: null };
  }
  if (section === "shared") {
    return { detailAction: "shared-with-me", nextTab: null };
  }
  if (section === "public_responses") {
    return { detailAction: null, nextTab: "links" };
  }
  if (section === "people") {
    return { detailAction: null, nextTab: "people" };
  }
  if (hasRequest) {
    return { detailAction: "needs-review", nextTab: null };
  }
  if (hasGrant) {
    return { detailAction: "shared-with-me", nextTab: null };
  }
  if (hasSubmission) {
    return { detailAction: null, nextTab: "links" };
  }
  return { detailAction: null, nextTab: null };
}

const BUSY = (vm: LocationHubViewModel, key: string) => vm.busy === key;

function LocationHeaderActions({ vm }: { vm: LocationHubViewModel }) {
  const locationOn = vm.locationEnabled;
  const toggling = BUSY(vm, "selfLocation");
  const refreshing = BUSY(vm, "load");
  const statusLabel = locationStatusLabel({
    readiness: vm.locationBlocked ? "blocked" : locationOn ? "ready" : "askable",
    previewOn: locationOn,
    paused: vm.locationPaused,
    accuracyLimited: vm.locationAccuracyLimited,
  });

  const handleLocationChange = (checked: boolean) => {
    if (checked === locationOn) return;
    if (checked) {
      vm.onShowMyLocation();
      return;
    }
    vm.onHideMyLocation();
  };

  return (
    <div
      role="group"
      aria-label="Location preview control"
      className="ml-auto flex max-w-full shrink-0 items-center justify-end"
      data-testid="one-location-header-actions"
    >
      <div className="flex h-9 shrink-0 items-center gap-0 rounded-full bg-black/[0.05] px-2 text-[13px] font-semibold text-foreground sm:gap-2 sm:px-3 dark:bg-white/[0.07]">
        <span
          className="hidden whitespace-nowrap sm:inline"
          aria-hidden="true"
        >
          {statusLabel}
        </span>
        <Switch
          checked={locationOn}
          onCheckedChange={handleLocationChange}
          disabled={toggling || refreshing}
          aria-label={locationOn ? "Turn location off" : "Turn location on"}
          // The same pair of contract actions the Settings toggle carries.
          // Both are the same control in two places, so voice can offer
          // pause/resume from the Now tab without opening Settings first.
          data-voice-control-id="one-location-updates-toggle"
          // No colour override: the shared Switch already carries the iOS
          // system green, so this toggle reads the same as every other one.
          className={cn(toggling && "animate-pulse")}
        />
      </div>
    </div>
  );
}

// People lists (Ready people / Pending invites) can grow long. Cap their height
// and let them scroll internally so a large Circle doesn't stretch the page into
// an endless column. ~max-h fits roughly 5 cards before scrolling; a thin,
// touch-friendly scrollbar keeps it unobtrusive on mobile.
const PEOPLE_LIST_SCROLL_CLASS =
  "max-h-[340px] space-y-2.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

export function LocationRedesignHub({ vm }: { vm: LocationHubViewModel }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nearbyCheckInAvailable = isOneLocationNearbyCheckInAvailable();
  const nearbyPrivateCheckIn =
    searchParams.get(FLOW_ACTION_PARAM) === PRIVATE_CHECK_IN_ACTION &&
    searchParams.get(FLOW_SOURCE_PARAM) === NEARBY_CHECK_IN_SOURCE;
  const nearbyReturnToken = searchParams.get(NEARBY_PRIVATE_RETURN_TOKEN_PARAM);
  const nearbyCheckInReturnHref =
    nearbyPrivateCheckIn && isNearbyPrivateReturnToken(nearbyReturnToken)
      ? buildNearbyCheckInResumeHref(nearbyReturnToken)
      : `${ROUTES.ONE_LOCATION_MAP}?action=check-in`;
  const [tab, setTabState] = useState<LocationHubTab>(() =>
    resolveLocationHubTab(searchParams.get(LOCATION_HUB_TAB_PARAM)),
  );
  const [flow, setFlow] = useState<FlowKind>("none");
  const focusedCircleMemberInviteId =
    String(searchParams.get("circleInviteId") || "").trim() || null;
  // Router state can settle one paint after a tap. Keep the local focused
  // surface alive until its authored `?action=` update arrives so a stale query
  // snapshot cannot close a newly opened detail flow.
  const pendingFlowRef = useRef<FlowKind>("none");
  const [collapsedGrantIds, setCollapsedGrantIds] = useState<Set<string>>(
    () => new Set(),
  );

  const setTab = useCallback(
    (next: LocationHubTab) => {
      if (next === tab) return;
      setTabState(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "now") {
        params.delete(LOCATION_HUB_TAB_PARAM);
      } else {
        params.set(LOCATION_HUB_TAB_PARAM, next);
      }
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      beginRouteTransition(
        href,
        () => router.replace(href, { scroll: false }),
        "tap",
        "contextual",
      );
    },
    [pathname, router, searchParams, tab],
  );

  useEffect(() => {
    const next = resolveLocationHubTab(
      searchParams.get(LOCATION_HUB_TAB_PARAM),
    );
    setTabState((current) => (current === next ? current : next));
  }, [searchParams]);
  // Notification links resolve to focused detail surfaces. The inbox was a mixed
  // catch-all, so incoming shares and requests now land on exactly the task the
  // notification describes. `view=inbox` remains a harmless legacy alias for
  // the compact Now hub.
  useEffect(() => {
    const section = String(searchParams.get("section") || "").trim();
    const hasRequest = Boolean(
      String(searchParams.get("requestId") || "").trim(),
    );
    const hasGrant = Boolean(String(searchParams.get("grantId") || "").trim());
    const hasSubmission = Boolean(
      String(searchParams.get("submissionId") || "").trim(),
    );
    const { detailAction, nextTab } = resolveLocationDeepLinkFocus({
      section,
      hasRequest,
      hasGrant,
      hasSubmission,
    });
    const legacyInbox = searchParams.get(LOCATION_HUB_TAB_PARAM) === "inbox";
    if (detailAction || nextTab || legacyInbox) {
      setFlow("none");
      const params = new URLSearchParams(searchParams.toString());
      params.delete(LOCATION_HUB_TAB_PARAM);
      params.delete("section");
      if (detailAction) {
        params.set(FLOW_ACTION_PARAM, FLOW_TO_ACTION[detailAction]);
      } else {
        params.delete(FLOW_ACTION_PARAM);
        if (nextTab) {
          params.set(LOCATION_HUB_TAB_PARAM, nextTab);
        }
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    }
  }, [pathname, router, searchParams]);

  const [shareStep, setShareStep] = useState<"person" | "details">("person");
  const [reason, setReason] = useState<ReasonValue | null>("Safety check-in");
  const activeFlowRef = useRef<FlowKind>("none");
  const resetShareComposer = vm.resetShareComposer;
  const startShareComposer = vm.startShareComposer;

  const resetShareLocalState = useCallback(() => {
    setShareStep("person");
  }, []);
  const resetShareDraft = useCallback(() => {
    resetShareLocalState();
    resetShareComposer();
  }, [resetShareComposer, resetShareLocalState]);

  // A location action flow is a focused sub-screen of /one/location.
  // The open flow is mirrored into the URL (`?action=…`) so the SINGLE top-left
  // back button in the app chrome (and the OS/hardware back button) returns to
  // the Location hub instead of leaving to /one. Because that one chrome back
  // arrow now owns "return to hub", the redundant in-content back arrows have
  // been removed from the flows — each action screen shows exactly one back
  // affordance plus its own Cancel/Done control.
  const openFlow = useCallback(
    (next: Exclude<FlowKind, "none">) => {
      setFlow(next);
      activeFlowRef.current = next;
      pendingFlowRef.current = next;
      const params = new URLSearchParams(searchParams.toString());
      params.delete(FLOW_SOURCE_PARAM);
      params.set(FLOW_ACTION_PARAM, FLOW_TO_ACTION[next]);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const openCircleDetail = useCallback(
    (circleId: string, navigation: "push" | "replace" = "push") => {
      const next: FlowKind = "circle-detail";
      pendingFlowRef.current = next;
      const params = new URLSearchParams(searchParams.toString());
      params.set(FLOW_ACTION_PARAM, FLOW_TO_ACTION[next]);
      params.set("circleId", circleId);
      params.set(LOCATION_HUB_TAB_PARAM, "people");
      const href = `${pathname}?${params.toString()}`;
      router[navigation](href, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const openShareFlow = useCallback(
    (initialRecipientId?: string) => {
      resetShareLocalState();
      startShareComposer(initialRecipientId);
      openFlow("share");
    },
    [openFlow, resetShareLocalState, startShareComposer],
  );

  const closeFlow = useCallback(
    (nextTab?: LocationHubTab) => {
      if (flow === "share") {
        vm.clearNamedCircleShareContext();
      }
      setFlow("none");
      activeFlowRef.current = "none";
      pendingFlowRef.current = "none";
      setShareStep("person");
      vm.setShareReviewOpen(false);
      if (nextTab) {
        setTabState(nextTab);
      }

      const params = new URLSearchParams(searchParams.toString());
      params.delete(FLOW_ACTION_PARAM);
      params.delete("circleId");
      params.delete(FLOW_SOURCE_PARAM);
      if (nextTab === "now") {
        params.delete(LOCATION_HUB_TAB_PARAM);
      } else if (nextTab) {
        params.set(LOCATION_HUB_TAB_PARAM, nextTab);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [flow, pathname, router, searchParams, vm],
  );

  const dismissFocusedCircleMemberInvite = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("circleInviteId");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [pathname, router, searchParams]);

  const closeShareFlow = useCallback(() => {
    resetShareDraft();
    closeFlow();
  }, [closeFlow, resetShareDraft]);

  const returnToNearbyCheckIn = useCallback(() => {
    setFlow("none");
    activeFlowRef.current = "none";
    pendingFlowRef.current = "none";
    setShareStep("person");
    vm.setShareReviewOpen(false);
    router.replace(nearbyCheckInReturnHref, { scroll: false });
  }, [nearbyCheckInReturnHref, router, vm]);

  // Keep the flow view in sync with the URL action param: the chrome/OS back
  // button strips the param, which closes the flow back to the hub. A direct
  // deep-link to `?action=…` opens the matching flow on load. Resetting the
  // Share sub-step + review flag on close ensures re-opening Share always starts
  // clean at step 1 (never jumps back into the consent-review screen).
  useEffect(() => {
    const rawAction = (searchParams.get(FLOW_ACTION_PARAM) || "").trim();
    const action = LEGACY_ACTION_TO_FLOW[rawAction] ?? rawAction;
    if (rawAction && rawAction !== action) {
      const params = new URLSearchParams(searchParams.toString());
      params.set(FLOW_ACTION_PARAM, action);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
    if (RETIRED_ACTIONS.has(action)) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(FLOW_ACTION_PARAM);
      params.delete(LOCATION_HUB_TAB_PARAM);
      const query = params.toString();
      toast.message("This location action is no longer available.");
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
      return;
    }
    const flowAction = action === "event-check-in" ? "check-in" : action;
    const requested: FlowKind = flowAction
      ? (ACTION_TO_FLOW[flowAction] ?? "none")
      : "none";
    if (
      nearbyCheckInAvailable &&
      (action === "check-in" || action === "event-check-in")
    ) {
      router.replace(`${ROUTES.ONE_LOCATION_MAP}?action=check-in`, {
        scroll: false,
      });
      return;
    }
    const desired = requested;
    if (desired === "none" && pendingFlowRef.current !== "none") {
      return;
    }
    pendingFlowRef.current = "none";
    const previousFlow = activeFlowRef.current;
    if (previousFlow === "share" && desired !== "share") {
      resetShareDraft();
    } else if (previousFlow !== "share" && desired === "share") {
      resetShareDraft();
    }
    activeFlowRef.current = desired;
    setFlow((current) => (current === desired ? current : desired));
    if (desired === "none") {
      setShareStep("person");
      vm.setShareReviewOpen(false);
      vm.clearNamedCircleShareContext();
    }
  }, [
    nearbyCheckInAvailable,
    pathname,
    resetShareDraft,
    router,
    searchParams,
    vm,
  ]);

  // When a share completes successfully (page bumps shareCompletedTick), close
  // the 3-step share flow and return to the main One Location hub.
  const lastShareTickRef = useRef(vm.shareCompletedTick);
  useEffect(() => {
    if (vm.shareCompletedTick !== lastShareTickRef.current) {
      lastShareTickRef.current = vm.shareCompletedTick;
      // Closing the flow returns to the hub; the share flow always launches
      // from the "Now" tab, so no explicit tab change is needed.
      setFlow("none");
      activeFlowRef.current = "none";
      pendingFlowRef.current = "none";
      setShareStep("person");
      if (nearbyPrivateCheckIn) {
        router.replace(nearbyCheckInReturnHref, { scroll: false });
        return;
      }
      // An authored landing wins over the clean-up below, and has to be
      // decided HERE rather than pushed by the caller: this effect calls
      // router.replace on the very next render, so anything the caller
      // navigated to would simply be replaced away.
      if (vm.shareCompletedDestination) {
        router.replace(vm.shareCompletedDestination, { scroll: false });
        return;
      }
      // Drop the action param so the hub URL is clean after a completed share.
      if ((searchParams.get(FLOW_ACTION_PARAM) || "").trim()) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete(FLOW_ACTION_PARAM);
        params.delete(FLOW_SOURCE_PARAM);
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }
    }
  }, [
    vm.shareCompletedTick,
    vm.shareCompletedDestination,
    nearbyCheckInReturnHref,
    nearbyPrivateCheckIn,
    pathname,
    router,
    searchParams,
  ]);

  /* ----------------------------------------------------------------- */
  /* Task flows (full-screen, no local tabs)                           */
  /* ----------------------------------------------------------------- */
  if (flow !== "none") {
    return (
      <div
        className="space-y-6"
        data-ambient-chrome-ignore
        data-testid="one-location-action-flow"
      >
        {flow === "share" ? (
          <ShareFlow
            vm={vm}
            step={shareStep}
            setStep={setShareStep}
            onClose={closeShareFlow}
          />
        ) : flow === "ask" ? (
          <AskFlow
            vm={vm}
            reason={reason}
            setReason={setReason}
            onClose={closeFlow}
          />
        ) : flow === "check-in" ? (
          <CheckInFlow
            vm={vm}
            entrySource={nearbyPrivateCheckIn ? "nearby" : undefined}
            onClose={
              nearbyPrivateCheckIn ? returnToNearbyCheckIn : () => closeFlow()
            }
          />
        ) : flow === "sos" ? (
          <SosFlow
            vm={vm}
            onClose={() => closeFlow("now")}
            onEditContacts={() => openFlow("sms-contacts")}
          />
        ) : flow === "sms-contacts" ? (
          <SmsContactsFlow
            recipients={vm.smsContactCandidates}
            circles={vm.circles}
            selectedUserIds={vm.smsContactUserIds}
            busyKey={vm.busy}
            // SMS contacts is only ever opened from Settings, so its in-content
            // back arrow returns to Settings (not the default "Now" tab), which
            // matches the chrome/OS back button behavior.
            onBack={() => openFlow("settings")}
            onAdd={vm.onAddSmsContact}
            onAddCircle={vm.onAddSmsCircle}
            onRemove={vm.onRemoveSmsContact}
            recipientLabel={vm.recipientLabel}
            recipientSubtitle={vm.recipientSubtitle}
            isRecipientShareReady={vm.isRecipientShareReady}
          />

        ) : flow === "create-circle" ? (
          <CreateCircleFlow
            busy={vm.busy === "namedCircle"}
            onSubmit={async (name, kind) => {
              const circle = await vm.onCreateNamedCircle(name, kind);
              openCircleDetail(circle.id, "replace");
            }}
          />
        ) : flow === "join-circle" ? (
          <JoinCircleFlow
            busy={vm.busy === "namedCircle"}
            initialCode={
              searchParams.get(CIRCLE_JOIN_CODE_PARAM)?.trim() || undefined
            }
            onResolve={vm.onResolveNamedCircleCode}
            onJoin={async (code) => {
              const result = await vm.onJoinNamedCircle(code);
              openCircleDetail(result.circle.id, "replace");
            }}
          />
        ) : flow === "circle-detail" ? (
          <CircleDetailFlow
            circleId={String(searchParams.get("circleId") || "")}
            currentUserId={vm.userId}
            busy={vm.busy === "namedCircle"}
            onBack={() => closeFlow("people")}
            onLoad={vm.onLoadNamedCircle}
            onRename={vm.onRenameNamedCircle}
            onGenerateCode={vm.onGenerateNamedCircleCode}
            onCopyCode={vm.onCopyNamedCircleCode}
            onShareCode={vm.onShareNamedCircleCode}
            onShareWithMember={(circleId, recipientUserId) => {
              vm.prepareNamedCircleShare(circleId, recipientUserId);
              openFlow("share");
            }}
            onRemoveMember={vm.onRemoveNamedCircleMember}
            onLoadEligibleConnections={
              vm.onLoadNamedCircleEligibleConnections
            }
            onInviteConnections={vm.onInviteNamedCircleConnections}
            onCancelMemberInvite={vm.onCancelNamedCircleMemberInvite}
            onLeave={vm.onLeaveNamedCircle}
            onDelete={vm.onDeleteNamedCircle}
          />
        ) : flow === "active-shares" ||
          flow === "shared-with-me" ||
          flow === "needs-review" ? (
          <LocationDetailFlow
            kind={flow}
            vm={vm}
            collapsedGrantIds={collapsedGrantIds}
            onCollapseGrant={(grantId) =>
              setCollapsedGrantIds((current) => new Set(current).add(grantId))
            }
            onExpandGrant={(grant) => {
              setCollapsedGrantIds((current) => {
                const next = new Set(current);
                next.delete(grant.id);
                return next;
              });
              if (!vm.decryptedPoints[grant.id]) vm.onViewGrant(grant);
            }}
          />
        ) : flow === "invite" ? (
          <InviteFlow vm={vm} onClose={closeFlow} />
        ) : flow === "settings" ? (
          <LocationSettingsFlow
            vm={vm}
            smsContactCount={vm.smsContactUserIds.length}
            onManageSmsContacts={() => openFlow("sms-contacts")}
          />
        ) : (
          <TemporaryLinkFlow vm={vm} onClose={closeFlow} />
        )}
      </div>
    );
  }

  /* ----------------------------------------------------------------- */
  /* Hub (Now | People | Links)                                        */
  /* ----------------------------------------------------------------- */
  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="inline-flex h-9 items-center whitespace-nowrap">
            Location Agent
          </span>
        }
        icon={MapPin}
        accent="neutral"
        actionsInlineMobile
        actions={<LocationHeaderActions vm={vm} />}
      />


      <div className="-mx-[var(--page-inline-gutter-standard)]">
        <SwipeViews
          tabSetId={LOCATION_TAB_DEFINITION.id}
          activeValue={tab}
          options={LOCATION_SWIPE_OPTIONS}
          onSelectionChange={(value) => setTab(value as LocationHubTab)}
          viewportMinHeight="0px"
        >
          <LocationHubPanel>
            <NowHub
              vm={vm}
              onStartShare={() => {
                vm.clearNamedCircleShareContext();
                openShareFlow();
              }}
              onCheckIn={() =>
                nearbyCheckInAvailable
                  ? router.push(`${ROUTES.ONE_LOCATION_MAP}?action=check-in`)
                  : openFlow("check-in")
              }
              checkInSubtitle={
                nearbyCheckInAvailable ? "See people nearby" : "Share now"
              }
              onSos={() => openFlow("sos")}
              onOpenMap={() => router.push(ROUTES.ONE_LOCATION_MAP)}
              onOpenActiveShares={() => openFlow("active-shares")}
              onOpenSharedWithMe={() => openFlow("shared-with-me")}
              onOpenNeedsReview={() => openFlow("needs-review")}
              onRequestLocation={() => openFlow("ask")}
              onOpenSettings={() => openFlow("settings")}
            />
          </LocationHubPanel>

          <LocationHubPanel>
            <PeopleHub
              vm={vm}
              onAddConnections={() => router.push(ROUTES.CONNECT)}
              onInvite={() => openFlow("invite")}
              onCreateCircle={() => openFlow("create-circle")}
              onJoinCircle={() => openFlow("join-circle")}
              onOpenCircle={openCircleDetail}
              focusedInviteId={focusedCircleMemberInviteId}
              onDismissFocusedInvite={dismissFocusedCircleMemberInvite}
              onStartShare={openShareFlow}
              onAsk={() => openFlow("ask")}
            />
          </LocationHubPanel>

          <LocationHubPanel>
            <LinksHub vm={vm} onCreateTempLink={() => openFlow("temp-link")} />
          </LocationHubPanel>
        </SwipeViews>
      </div>
    </div>
  );
}

function LocationHubPanel({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5 px-[var(--page-inline-gutter-standard)]">
      {children}
    </div>
  );
}

/* =================================================================== */
/* NOW HUB                                                              */
/* =================================================================== */

function NowHub({
  vm,
  onStartShare,
  onCheckIn,
  checkInSubtitle,
  onSos,
  onOpenMap,
  onOpenActiveShares,
  onOpenSharedWithMe,
  onOpenNeedsReview,
  onRequestLocation,
  onOpenSettings,
}: {
  vm: LocationHubViewModel;
  onStartShare: () => void;
  onCheckIn: () => void;
  checkInSubtitle: string;
  onSos: () => void;
  onOpenMap: () => void;
  onOpenActiveShares: () => void;
  onOpenSharedWithMe: () => void;
  onOpenNeedsReview: () => void;
  onRequestLocation: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="one-location-now-hub">
      {/* Every row and tile below carries the `control_ids` / `action_id` pair
          it was authored with in the Location voice action contract, so One and
          the search bar can name the individual control a person is asking for
          rather than only the screen it lives on. */}
      <SettingsGroup separatorInset testId="one-location-now-primary">
        <SettingsRow
          icon={Navigation}
          iconTone="blue"
          title="Share location"
          density="compact"
          chevron
          onClick={onStartShare}
          testId="one-location-share-row"
          voiceControlId="one-location-action-share"
          voiceActionId="location.open_share"
        />
        <SettingsRow
          icon={Map}
          iconTone="green"
          title="Your Map"
          density="compact"
          chevron
          onClick={onOpenMap}
          testId="one-location-map-row"
          voiceControlId="one-location-open-map"
          voiceActionId="location.open_map"
        />
      </SettingsGroup>

      <SettingsGroup separatorInset testId="one-location-now-status">
        <SettingsRow
          icon={UsersRound}
          iconTone="purple"
          title="Active shares"
          density="compact"
          trailing={vm.activeOwnerGrants.length}
          chevron
          onClick={onOpenActiveShares}
          voiceControlId="one-location-action-active-shares"
          voiceActionId="location.open_active_shares"
        />
        <SettingsRow
          icon={MapPin}
          iconTone="blue"
          title="Shared with me"
          density="compact"
          trailing={vm.receivedGrants.length}
          chevron
          onClick={onOpenSharedWithMe}
          voiceControlId="one-location-action-shared-with-me"
          voiceActionId="location.open_shared_with_me"
        />
        <SettingsRow
          icon={ShieldCheck}
          iconTone="orange"
          title="Needs my review"
          density="compact"
          trailing={vm.pendingOwnerRequests.length}
          chevron
          onClick={onOpenNeedsReview}
          voiceControlId="one-location-action-needs-review"
          voiceActionId="location.open_needs_review"
        />
        {/* Asking someone to share was reachable only from the People tab, so
            the Now tab listed every way to give a location out and none to ask
            for one. Same flow and same voice control id as that entry -- this
            is an additional way in, not a second implementation. */}
        <SettingsRow
          icon={Send}
          iconTone="accent"
          title="Request Location"
          density="compact"
          chevron
          onClick={onRequestLocation}
          testId="one-location-request-row"
          voiceControlId="one-location-action-ask"
          voiceActionId="location.open_ask"
        />
        <SettingsRow
          icon={Lock}
          iconTone="gray"
          title="Settings"
          density="compact"
          chevron
          onClick={onOpenSettings}
          testId="one-location-settings-entry"
          voiceControlId="one-location-action-settings"
          voiceActionId="location.open_settings"
        />
      </SettingsGroup>

      <QuickActionsSection title="Quick actions" columns={2}>
        <QuickActionCard
          tone="green"
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Check-In"
          subtitle={checkInSubtitle}
          onClick={onCheckIn}
          controlId="one-location-action-check-in"
        />
        <QuickActionCard
          tone="red"
          icon={<Shield className="h-5 w-5" />}
          title="SMS"
          subtitle={vm.sosActive ? "Live now" : "Save my soul"}
          onClick={onSos}
          controlId="one-location-action-sos"
        />
      </QuickActionsSection>
    </div>
  );
}

/** Focused detail surfaces replace the former mixed inbox tab. */
function LocationDetailFlow({
  kind,
  vm,
  collapsedGrantIds,
  onCollapseGrant,
  onExpandGrant,
}: {
  kind: "active-shares" | "shared-with-me" | "needs-review";
  vm: LocationHubViewModel;
  collapsedGrantIds: Set<string>;
  onCollapseGrant: (grantId: string) => void;
  onExpandGrant: (grant: OneLocationGrant) => void;
}) {
  const [grantViewportResetKeys, setGrantViewportResetKeys] = useState<
    Record<string, number>
  >({});
  const recenterGrantViewport = useCallback((grantId: string) => {
    setGrantViewportResetKeys((current) => ({
      ...current,
      [grantId]: (current[grantId] ?? 0) + 1,
    }));
  }, []);

  // Reverse-geocode each received share's decrypted point to a street address,
  // keyed by grant id + coordinates so a moved point re-resolves. The ref
  // dedupes in-flight/resolved coordinate pairs without re-triggering the effect.
  const [addressByGrant, setAddressByGrant] = useState<
    Record<string, { key: string; status: "loading" | "done"; text: string | null }>
  >({});
  const resolvedAddressKeyRef = useRef<Record<string, string>>({});
  const reverseGeocodePoint = vm.reverseGeocodePoint;
  useEffect(() => {
    if (kind !== "shared-with-me" || !reverseGeocodePoint) return;
    let cancelled = false;
    for (const grant of vm.receivedGrants) {
      const point = vm.decryptedPoints[grant.id];
      if (!point) continue;
      const key = `${point.latitude},${point.longitude}`;
      if (resolvedAddressKeyRef.current[grant.id] === key) continue;
      resolvedAddressKeyRef.current[grant.id] = key;
      setAddressByGrant((current) => ({
        ...current,
        [grant.id]: { key, status: "loading", text: null },
      }));
      void reverseGeocodePoint(point).then((text) => {
        if (cancelled) return;
        setAddressByGrant((current) => {
          const entry = current[grant.id];
          if (!entry || entry.key !== key) return current;
          return { ...current, [grant.id]: { key, status: "done", text } };
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [kind, reverseGeocodePoint, vm.receivedGrants, vm.decryptedPoints]);
  const copy = {
    "active-shares": {
      title: "Active shares",
      description: "Only the people below can currently see your location.",
    },
    "shared-with-me": {
      title: "Shared with me",
      description: "Live locations disappear when access ends or is revoked.",
    },
    "needs-review": {
      title: "Needs my review",
      description: "Review every request before location is shared.",
    },
  }[kind];

  return (
    <div className="space-y-5" data-testid={`one-location-${kind}`}>
      <TaskFlowHeader title={copy.title} description={copy.description} />
      {kind === "active-shares" ? (
        vm.activeOwnerGrants.length ? (
          <SettingsGroup separatorInset>
            {vm.activeOwnerGrants.map((grant) => (
              <SettingsRow
                key={grant.id}
                icon={UsersRound}
                iconTone="purple"
                title={vm.grantRecipientLabel(grant)}
                description={vm.expiresCountdownLabel(grant.expiresAt)}
                trailing={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 text-destructive"
                    onClick={() => vm.onStopGrant(grant.id)}
                    disabled={vm.revokingGrantId === grant.id}
                  >
                    Stop
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
        ) : (
          <EmptyState
            title="No active shares"
            description="Start a consent-first share when you are ready."
          />
        )
      ) : null}
      {kind === "shared-with-me" ? (
        vm.receivedGrants.length ? (
          <div className="space-y-3">
            {vm.receivedGrants.map((grant) => {
              const point = vm.decryptedPoints[grant.id];
              const addressEntry = addressByGrant[grant.id];
              const expanded =
                Boolean(point) && !collapsedGrantIds.has(grant.id);
              return (
                <SharedWithMeCard
                  key={grant.id}
                  name={vm.grantOwnerLabel(grant)}
                  statusLine={vm.expiresLabel(grant.expiresAt)}
                  previewExpanded={expanded}
                  mapHref={point ? vm.mapLocationHref(point) : undefined}
                  onView={() => onExpandGrant(grant)}
                  onDismiss={() => onCollapseGrant(grant.id)}
                  onRecenter={
                    point ? () => recenterGrantViewport(grant.id) : undefined
                  }
                  viewBusy={vm.busy === "view"}
                  message={
                    point?.checkIn?.message ??
                    grant.shareMessage ??
                    undefined
                  }
                  address={
                    addressEntry?.status === "done" ? addressEntry.text : null
                  }
                  addressLoading={
                    Boolean(point) && addressEntry?.status === "loading"
                  }
                  coordinatesFallback={
                    point
                      ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
                      : undefined
                  }
                >
                  {expanded && point
                    ? vm.renderMapPreview(
                        point,
                        false,
                        `${grant.id}:${grantViewportResetKeys[grant.id] ?? 0}`,
                      )
                    : null}
                </SharedWithMeCard>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nothing shared with you"
            description="A person's live location appears here only while their grant is active."
          />
        )
      ) : null}
      {kind === "needs-review" ? (
        vm.pendingOwnerRequests.length ? (
          <div className="space-y-3">
            {vm.pendingOwnerRequests.map((request) => (
              <RequestCard
                key={request.id}
                name={vm.requesterLabel(request)}
                promptLine="Asks to see your location"
                reason={request.message ?? undefined}
                onApprove={() => vm.onApprove(request)}
                onDecline={() => vm.onDeny(request.id)}
                approveBusy={vm.busy === "approve"}
                declineBusy={vm.busy === "deny"}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing to review"
            description="Incoming location requests will appear here."
          />
        )
      ) : null}
    </div>
  );
}

/* =================================================================== */
/* PEOPLE HUB                                                           */
/* =================================================================== */

/* =================================================================== */
/* SETTINGS FLOW                                                        */
/* =================================================================== */

/** iOS-style switch (51×31, 27px knob) matching the Apple Blue v2 design. */
function LocationToggle({
  checked,
  onChange,
  label,
  disabled = false,
  voiceControlId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Anchors contract actions to this control so voice offers them only here. */
  voiceControlId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-voice-control-id={voiceControlId}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-[#34c759]" : "bg-black/15 dark:bg-white/20",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.15)] transition-[left] duration-200",
          checked ? "left-[22px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

function LocationSettingsFlow({
  vm,
  smsContactCount,
  onManageSmsContacts,
}: {
  vm: LocationHubViewModel;
  smsContactCount: number;
  onManageSmsContacts: () => void;
}) {
  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Location"
        title="Settings"
        description="You control who sees your location and when. Change this anytime."
      />

      <SettingsGroup title="Location sharing" separatorInset>
        <SettingsRow
          title="Auto-share my location"
          description="On — approved shares keep receiving live updates. Off — new shares send only the location you explicitly confirm."
          trailing={
            <LocationToggle
              checked={vm.autoShareEnabled}
              onChange={vm.onAutoShareChange}
              label="Auto-share my location"
              disabled={BUSY(vm, "selfLocation")}
            />
          }
          density="compact"
        />
        <SettingsRow
          title="Pause my location"
          description="Stop new private-share updates and check out from Nearby. Existing shares keep their expiry and may retain your last encrypted point."
          trailing={
            <LocationToggle
              checked={vm.locationPaused}
              onChange={(next) => {
                if (next) {
                  vm.onHideMyLocation();
                  return;
                }
                vm.onResumeMyLocation();
              }}
              label="Pause my location"
              disabled={BUSY(vm, "selfLocation")}
              voiceControlId="one-location-updates-toggle"
            />
          }
          density="compact"
        />
      </SettingsGroup>

      <div className="flex items-start gap-2.5 px-1">
        <Shield className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[color:var(--app-accent)]" />
        <p className={MUTED_TEXT}>
          Private shares stay in your circle. Nearby Check-In is separate and
          only starts after you explicitly agree.
        </p>
      </div>

      <SettingsGroup title="Safety" separatorInset>
        <SettingsRow
          title="SMS contacts"
          trailing={
            <span className="text-[15px] leading-5 text-muted-foreground">
              {smsContactCount}
            </span>
          }
          onClick={onManageSmsContacts}
          chevron
          density="compact"
          testId="one-location-sms-contacts-entry"
        />
      </SettingsGroup>

      <div>
        <SavedLocationsSection />
      </div>
    </div>
  );
}

/* =================================================================== */
/* PEOPLE HUB                                                           */
/* =================================================================== */

const PERSON_TINTS = [
  "#8b5cf6",
  "#3b82f6",
  "#f59e0b",
  "#14b8a6",
  "#ec4899",
] as const;

function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

/** One person in the People list: avatar (+ live dot) · name · status · action. */
function PersonRow({
  name,
  subtitle,
  active,
  tintIndex,
  first,
  action,
}: {
  name: string;
  subtitle: string;
  /** True when there's a live connection (you're sharing or they're sharing). */
  active: boolean;
  tintIndex: number;
  first: boolean;
  action: ReactNode;
}) {
  const tint = PERSON_TINTS[tintIndex % PERSON_TINTS.length] ?? PERSON_TINTS[0];
  return (
    <div
      className={cn(
        "flex min-h-[60px] items-center gap-3 p-3.5",
        !first && "border-t border-[color:var(--app-separator)]",
      )}
    >
      <div className="relative shrink-0">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full text-[14px] font-semibold text-white"
          style={{ backgroundColor: tint }}
        >
          {personInitials(name)}
        </span>
        {active ? (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-[color:var(--app-success)] dark:border-[color:var(--app-card-surface-default-solid)]" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[17px] font-normal leading-[22px] text-foreground">
          {name}
        </p>
        <p className="truncate text-[15px] leading-5 text-muted-foreground">
          {subtitle}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function PeopleHub({
  vm,
  onAddConnections,
  onInvite,
  onCreateCircle,
  onJoinCircle,
  onOpenCircle,
  focusedInviteId,
  onDismissFocusedInvite,
  onStartShare,
  onAsk,
}: {
  vm: LocationHubViewModel;
  onAddConnections: () => void;
  onInvite: () => void;
  onCreateCircle: () => void;
  onJoinCircle: () => void;
  onOpenCircle: (circleId: string) => void;
  focusedInviteId: string | null;
  onDismissFocusedInvite: () => void;
  onStartShare: (initialRecipientId?: string) => void;
  onAsk: () => void;
}) {
  const hasSearch = vm.recipientSearch.trim().length > 0;
  const filtered = vm.visibleRecipients;
  // Show the people list whenever there's anyone to show — this includes
  // contact-sync matches (which live in visibleRecipients, not `recipients`) —
  // or while a search is active. Otherwise fall back to the invite-first empty
  // state. (Gating on `recipients` alone hid freshly-synced contact matches.)
  const showPeopleList = filtered.length > 0 || hasSearch;

  // No one to show yet — keep the invite-first empty state. Per design, do NOT
  // show "Ask someone to share" here: there is no one to ask.
  if (!showPeopleList) {
    return (
      <div className="space-y-5">
        <CirclesSection
          circles={vm.circles}
          incomingInvites={vm.incomingCircleMemberInvites}
          incomingInvitesLoading={vm.incomingCircleMemberInvitesLoading}
          incomingInvitesError={vm.incomingCircleMemberInvitesError}
          focusedInviteId={focusedInviteId}
          focusedInviteResolutionReady={
            vm.incomingCircleMemberInviteFocusResolved
          }
          inviteBusy={vm.busy === "circleMemberInvite"}
          onCreate={onCreateCircle}
          onJoin={onJoinCircle}
          onOpen={onOpenCircle}
          onAcceptInvite={vm.onAcceptNamedCircleMemberInvite}
          onDeclineInvite={vm.onDeclineNamedCircleMemberInvite}
          onRetryInvites={vm.onRetryNamedCircleMemberInvites}
          onDismissFocusedInvite={onDismissFocusedInvite}
        />

        <SectionCard
          title="Connections"
          description="Connections and Circle members are eligible for explicit private sharing."
        >
          <div className="grid grid-cols-1 gap-2">
            <Button
              onClick={onAddConnections}
              data-voice-control-id="one-location-add-connections"
              className="h-11 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
            >
              <UsersRound className="mr-2 h-4 w-4" />
              Add Connections
            </Button>
            <Button
              variant="outline"
              onClick={onInvite}
              data-voice-control-id="one-location-action-invite"
              className="h-10 rounded-full text-sm font-semibold"
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Invite trusted person
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={vm.onSyncContacts}
                isLoading={vm.busy === "contactSync"}
                className="h-10 rounded-full text-sm"
              >
                Sync contacts
              </Button>
              <Button
                variant="outline"
                onClick={vm.onShareToContacts}
                isLoading={vm.busy === "contactInvite"}
                className="h-10 rounded-full text-sm"
              >
                Share to contacts
              </Button>
            </div>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CirclesSection
        circles={vm.circles}
        incomingInvites={vm.incomingCircleMemberInvites}
        incomingInvitesLoading={vm.incomingCircleMemberInvitesLoading}
        incomingInvitesError={vm.incomingCircleMemberInvitesError}
        focusedInviteId={focusedInviteId}
        focusedInviteResolutionReady={
          vm.incomingCircleMemberInviteFocusResolved
        }
        inviteBusy={vm.busy === "circleMemberInvite"}
        onCreate={onCreateCircle}
        onJoin={onJoinCircle}
        onOpen={onOpenCircle}
        onAcceptInvite={vm.onAcceptNamedCircleMemberInvite}
        onDeclineInvite={vm.onDeclineNamedCircleMemberInvite}
        onRetryInvites={vm.onRetryNamedCircleMemberInvites}
        onDismissFocusedInvite={onDismissFocusedInvite}
      />

      <PersonSearchInput
        value={vm.recipientSearch}
        onChange={vm.setRecipientSearch}
      />

      {/* Compact circle-management actions. Invite adds people; "Sync contacts"
          tags which existing connections are in your phone contacts. */}
      <div className="grid grid-cols-1 gap-2">
        <Button
          onClick={onAddConnections}
          data-voice-control-id="one-location-add-connections"
          className="h-10 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
        >
          <UsersRound className="mr-2 h-4 w-4" />
          Add Connections
        </Button>
        <Button
          variant="outline"
          onClick={onInvite}
          data-voice-control-id="one-location-action-invite"
          className="h-10 rounded-full border-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent)]"
        >
          <UserPlus className="mr-2 h-4 w-4" />
          Invite trusted person
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            onClick={vm.onSyncContacts}
            isLoading={vm.busy === "contactSync"}
            className="h-10 rounded-full text-sm"
          >
            Sync contacts
          </Button>
          <Button
            variant="outline"
            onClick={vm.onShareToContacts}
            isLoading={vm.busy === "contactInvite"}
            className="h-10 rounded-full text-sm"
          >
            Share to contacts
          </Button>
        </div>
      </div>

      {filtered.length ? (
        <div className={cn("overflow-hidden", SUBCARD_SURFACE)}>
          {filtered.map((r, i) => {
            const grant = vm.activeOwnerGrants.find(
              (g) => g.recipientUserId === r.userId,
            );
            const sharing = Boolean(grant);
            const receiving = vm.receivedGrants.some(
              (g) => g.ownerUserId === r.userId,
            );
            const ready = vm.isRecipientShareReady(r);
            return (
              <PersonRow
                key={r.userId}
                name={vm.recipientLabel(r)}
                subtitle={vm.recipientSubtitle(r)}
                active={sharing || receiving}
                tintIndex={i}
                first={i === 0}
                action={
                  sharing && grant ? (
                    <Button
                      variant="outline"
                      onClick={() => vm.onStopGrant(grant.id)}
                      isLoading={vm.revokingGrantId === grant.id}
                      className="h-9 rounded-full border-[color:var(--app-accent)] px-5 text-sm font-semibold text-[color:var(--app-accent)]"
                    >
                      Stop
                    </Button>
                  ) : ready ? (
                    <Button
                      onClick={() => onStartShare(r.userId)}
                      className="h-9 rounded-full bg-[color:var(--app-accent)] px-5 text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
                    >
                      Share
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No matching people"
          description="Try a different name."
        />
      )}

      {/* Ask someone to share — request another person's live location. */}
      <button
        type="button"
        onClick={onAsk}
        data-voice-control-id="one-location-action-ask"
        className={cn(
          "flex min-h-[60px] w-full items-center gap-3.5 p-3.5 text-left transition-colors hover:bg-foreground/[0.025]",
          SUBCARD_SURFACE,
        )}
      >
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12">
          <Navigation className="h-[17px] w-[17px] text-[color:var(--app-accent)]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-normal leading-[22px] text-[color:var(--app-accent)]">
            Ask someone to share
          </span>
          <span className="block text-[15px] leading-5 text-muted-foreground">
            Send a request — they approve first.
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--app-tertiary-label)]" />
      </button>

      {vm.requestedByMe.length ? (
        <SettingsGroup title="Requests sent" separatorInset>
          {vm.requestedByMe.map((request) => (
            <SettingsRow
              key={request.id}
              icon={Send}
              iconTone="blue"
              title={vm.requestOwnerLabel(request)}
              description={vm.formatDateTime(request.requestedAt)}
              trailing={
                /active|approved|shared|granted/i.test(request.status)
                  ? "Active"
                  : "Pending"
              }
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : null}
    </div>
  );
}

/* =================================================================== */
/* LINKS HUB                                                            */
/* =================================================================== */

/** One active-link row: tinted icon tile · title · subtitle · Copy (design). */
function ActiveLinkRow({
  icon,
  tileClass,
  title,
  subtitle,
  onCopy,
  first,
}: {
  icon: ReactNode;
  tileClass: string;
  title: string;
  subtitle: string;
  onCopy: () => void;
  first: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[60px] items-center gap-3.5 py-3.5",
        !first && "border-t border-[color:var(--app-separator)]",
      )}
    >
      <span
        className={cn(
          "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]",
          tileClass,
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[17px] font-normal leading-[22px] text-foreground">
          {title}
        </p>
        <p className="mt-0.5 truncate text-[15px] leading-5 text-muted-foreground">
          {subtitle}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={onCopy}
        className="h-9 shrink-0 rounded-full border-[color:var(--app-accent)] px-4 text-[14px] font-semibold text-[color:var(--app-accent)]"
      >
        Copy
      </Button>
    </div>
  );
}

function LinksHub({
  vm,
  onCreateTempLink,
}: {
  vm: LocationHubViewModel;
  onCreateTempLink: () => void;
}) {
  const temp = vm.latestActivePublicInvite;
  const invite = vm.latestActiveCircleInvite;
  const hasLinks = Boolean(temp) || Boolean(invite);

  return (
    <div className="space-y-4">
      <p className={cn(SECTION_HEADING, "px-[6px]")}>
        Active links
      </p>

      {hasLinks ? (
        <div className={cn("overflow-hidden px-3.5", SUBCARD_SURFACE)}>
          {temp ? (
            <ActiveLinkRow
              first
              tileClass="bg-[color:var(--app-purple)]/12 dark:bg-[color:var(--app-purple)]/15"
              icon={<LinkIcon className="h-[17px] w-[17px] text-[color:var(--app-purple)]" />}
              title="Live location link"
              subtitle={`${vm.expiresCountdownLabel(temp.expiresAt)} · anyone with the link`}
              onCopy={vm.onCopyPublicInvite}
            />
          ) : null}
          {invite ? (
            <ActiveLinkRow
              first={!temp}
              tileClass="bg-[color:var(--app-success)]/12 dark:bg-[color:var(--app-success)]/15"
              icon={<ShieldCheck className="h-[17px] w-[17px] text-[color:var(--app-success)]" />}
              title="Invite link"
              subtitle={`${vm.expiresCountdownLabel(invite.expiresAt)} · one person`}
              onCopy={vm.onCopyCircleInvite}
            />
          ) : null}
        </div>
      ) : (
        <EmptyState
          title="No active links"
          description="Create one below to share with someone outside your Circle."
        />
      )}

      <Button
        onClick={onCreateTempLink}
        data-voice-control-id="one-location-action-temp-link"
        className="h-12 w-full rounded-full bg-[color:var(--app-accent)] text-[15px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
      >
        <Plus className="mr-2 h-4 w-4" />
        Create a new link
      </Button>

      <div className="flex items-start gap-2 px-1">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className={MUTED_TEXT}>
          Links stop working automatically when they expire. You can revoke any
          link anytime.
        </p>
      </div>
    </div>
  );
}

/* =================================================================== */
/* SAVE MY SOUL FLOW (internal action identifier remains `sos`)          */
/* =================================================================== */

function SosFlow({
  vm,
  onClose,
  onEditContacts,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
  onEditContacts: () => void;
}) {
  const onResolveSosLocation = vm.onResolveSosLocation;
  const [lookupStartedForMount, setLookupStartedForMount] = useState(false);
  useEffect(() => {
    onResolveSosLocation();
    setLookupStartedForMount(true);
  }, [onResolveSosLocation]);

  return (
    <SosPanel
      recipients={vm.smsRecipients}
      active={vm.sosActive}
      busy={vm.sosBusy}
      onTrigger={vm.onTriggerSos}
      onStopSos={vm.onStopSos}
      stopBusy={vm.sosBusy}
      onClose={onClose}
      onEditContacts={onEditContacts}
      recipientLabel={vm.recipientLabel}
      isRecipientShareReady={vm.isRecipientShareReady}
      emergency={lookupStartedForMount ? vm.sosEmergency : null}
      emergencyStatus={
        lookupStartedForMount ? vm.sosEmergencyStatus : "idle"
      }
      onResolveEmergencyNumber={onResolveSosLocation}
    />

  );
}

/* =================================================================== */
/* SHARE FLOW                                                           */
/* =================================================================== */

/**
 * Sharing has exactly one precision: the point the device gives us.
 *
 * This flow used to offer "Approximate area" beside "Precise live location",
 * echo the choice back on the review step, and then discard it —
 * `onConfirmShare` takes no arguments, the state never left this component,
 * and `handleShare` published the raw captured point either way. There is no
 * coarsening anywhere in the client, so "Approximate area" shared exact
 * coordinates. A privacy control that does nothing is worse than no control:
 * it is relied upon.
 *
 * The control is gone rather than repaired because the real implementation
 * already exists in PR #4767 — grid-snapped areas with a radius, an update
 * interval, and a recipient-visible `location_mode` on the grant so the other
 * side can render an area instead of a confident, wrong pin. Coarsening here
 * without that column would only move the deception to the recipient. Restore
 * this when that lands.
 */
function ShareFlow({
  vm,
  step,
  setStep,
  onClose,
}: {
  vm: LocationHubViewModel;
  step: "person" | "details";
  setStep: (s: "person" | "details") => void;
  onClose: () => void;
}) {
  const filtered = vm.visibleShareRecipients;
  const recipientById = new globalThis.Map(
    vm.recipients.map((recipient) => [recipient.userId, recipient]),
  );
  const selectedReady = vm.selectedRecipientIds
    .map((recipientId) => recipientById.get(recipientId))
    .filter(
      (recipient): recipient is OneLocationRecipient =>
        Boolean(recipient && vm.isRecipientShareReady(recipient)),
    );
  const shareNoteLength = vm.shareMessage.length;
  const shareNoteLimitExceeded =
    shareNoteLength > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH;

  // Review screen (consent check) is driven by the existing shareReviewOpen flag.
  if (vm.shareReviewOpen) {
    const selectedCircle = vm.selectedShareCircleSelection;
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Step 3 of 3 · Consent check"
          title="Before you start"
          description="Confirm exactly who can see you, what they see, and when access ends."
        />
        <SectionCard>
          <div className="space-y-3">
            {selectedCircle ? (
              <ReviewRow
                label="Circle"
                value={`${selectedCircle.circle.name} · ${selectedReady.length} ${
                  selectedReady.length === 1 ? "person" : "people"
                }`}
              />
            ) : null}
            <ReviewRow
              label="Can see"
              value={
                selectedReady.length ? (
                  <ul
                    aria-label="People who can see your location"
                    className="min-w-0 space-y-1 text-right"
                  >
                    {selectedReady.map((recipient) => (
                      <li
                        key={recipient.userId}
                        className="break-words [overflow-wrap:anywhere]"
                      >
                        {vm.recipientLabel(recipient)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "Selected people"
                )
              }
            />
            {/* No "Location type" row. It read back whichever option was
                picked, which made the review step the most convincing part of
                a promise nothing kept — see the note above ShareFlow. */}
            <ReviewRow
              label="Duration"
              value={durationLabel(vm.shareDurationHours)}
            />
            <ReviewRow label="Control" value="You can stop anytime" />
          </div>
        </SectionCard>
        <div className="space-y-2.5">
          <Button
            onClick={vm.onConfirmShare}
            isLoading={vm.busy === "share"}
            data-voice-control-id="one-location-confirm-share"
            className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            Start sharing
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            className="h-11 w-full rounded-2xl text-sm"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step === "details") {
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Step 2 of 3 · Details"
          title="What are you sharing?"
        />
        <SectionCard>
          <div className="space-y-5">
            <DurationSelector
              value={vm.shareDurationHours}
              onChange={vm.setShareDurationHours}
              presentation="select"
            />
            <div className="space-y-2">
              <label
                htmlFor="one-location-share-note"
                className="text-sm font-semibold text-foreground"
              >
                Optional note
              </label>
              <div className="relative">
                <textarea
                  id="one-location-share-note"
                  value={vm.shareMessage}
                  onChange={(event) =>
                    vm.setShareMessage(event.target.value)
                  }
                  rows={2}
                  aria-invalid={shareNoteLimitExceeded}
                  aria-describedby={
                    shareNoteLimitExceeded
                      ? "one-location-share-note-count one-location-share-note-error"
                      : "one-location-share-note-count"
                  }
                  placeholder="On my way to the meeting"
                  className="block w-full rounded-[14px] border border-border/70 bg-background px-3 pb-8 pt-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)] aria-invalid:border-destructive aria-invalid:focus:ring-destructive/30"
                />
                <span
                  id="one-location-share-note-count"
                  className={cn(
                    "pointer-events-none absolute bottom-2.5 right-3 text-xs tabular-nums",
                    shareNoteLimitExceeded
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {shareNoteLength}/{ONE_LOCATION_SHARE_NOTE_MAX_LENGTH}
                </span>
              </div>
              {shareNoteLimitExceeded ? (
                <p
                  id="one-location-share-note-error"
                  role="alert"
                  className="text-right text-xs font-medium text-destructive"
                >
                  character limit exceed
                </p>
              ) : null}
            </div>
          </div>
        </SectionCard>
        <Button
          onClick={vm.onOpenShareReview}
          disabled={!vm.canShare || shareNoteLimitExceeded}
          isLoading={vm.busy === "share"}
          className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:opacity-50"
        >
          Review share
        </Button>
      </div>
    );
  }

  // step === "person"
  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Step 1 of 3 · Choose person"
        title="Who can see you?"
        description="Only trusted and location-ready people can receive private live location."
      />
      {vm.circles.length ? (
        <SectionCard title="Share with a Circle">
          <div className="grid gap-2">
            {vm.circles.map((circle) => {
              const selected =
                vm.selectedShareCircleSelection?.circle.id === circle.id;
              return (
                <button
                  key={circle.id}
                  type="button"
                  disabled={vm.busy === "shareCircle"}
                  onClick={() => void vm.onSelectShareCircle(circle.id)}
                  aria-pressed={selected}
                  className={cn(
                    "flex min-h-14 items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition",
                    selected
                      ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-soft)]"
                      : "border-border/70 bg-background hover:bg-muted/45",
                  )}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                    <UsersRound className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {circle.name}
                    </span>
                    <span className="block text-[13px] leading-[18px] text-[#8E8E93]">
                      {selected
                        ? `${selectedReady.length} ready now`
                        : `${circle.memberCount} ${
                            circle.memberCount === 1 ? "member" : "members"
                          }`}
                    </span>
                  </span>
                  <span className="text-xs font-semibold text-[color:var(--app-accent)]">
                    {vm.busy === "shareCircle"
                      ? "Loading…"
                      : selected
                        ? "Selected"
                        : "Select"}
                  </span>
                </button>
              );
            })}
          </div>
          {vm.selectedShareCircleSelection ? (
            <p className={cn(MUTED_TEXT, "mt-3")}>
              Current ready members only; future members are never added
              automatically.
              {vm.selectedShareCircleSelection.excluded.filter(
                (item) => item.reason !== "self",
              ).length
                ? ` ${
                    vm.selectedShareCircleSelection.excluded.filter(
                      (item) => item.reason !== "self",
                    ).length
                  } member(s) need Location setup and are not included.`
                : ""}
            </p>
          ) : null}
        </SectionCard>
      ) : null}
      <PersonSearchInput
        value={vm.shareRecipientSearch}
        onChange={vm.setShareRecipientSearch}
        voiceControlId="one-location-share-recipient-search"
      />
      {filtered.length ? (
        <div className={PEOPLE_LIST_SCROLL_CLASS}>
          {filtered.map((r) => {
            const selected = vm.selectedRecipientIds.includes(r.userId);
            const ready = vm.isRecipientShareReady(r);
            return (
              <TrustedPersonCard
                key={r.userId}
                name={vm.recipientLabel(r)}
                subtitle={
                  ready
                    ? undefined
                    : "Invite first to enable sharing"
                }
                tone={ready ? "ready" : "pending"}
                actionLabel={
                  ready ? (selected ? "Selected" : "Select") : undefined
                }
                actionAriaLabel={
                  ready
                    ? `${selected ? "Deselect" : "Select"} ${vm.recipientLabel(
                        r,
                      )} for private sharing`
                    : undefined
                }
                onAction={
                  ready
                    ? () => vm.toggleShareRecipient(r.userId, "share_flow")
                    : undefined
                }
                selected={selected}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No trusted people yet"
          description="Invite someone to your Circle to start sharing."
        />
      )}
      <Button
        onClick={() => setStep("details")}
        disabled={!selectedReady.length}
        className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:opacity-50"
      >
        Continue
      </Button>
    </div>
  );
}

function ReviewRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-3 last:border-0 last:pb-0">
      <span className="shrink-0 text-[15px] font-normal leading-[20px] tracking-[-0.006em] text-[#8E8E93]">
        {label}
      </span>
      <div className="min-w-0 max-w-[70%] text-right text-sm font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

function durationLabel(value: string): string {
  const map: Record<string, string> = {
    "0.25": "15 min",
    "0.5": "30 min",
    "1": "1 hour",
    "4": "4 hours",
    "8": "8 hours",
    "24": "24 hours",
  };
  return map[value] ?? `${value} hours`;
}

/* =================================================================== */
/* ASK FLOW                                                             */
/* =================================================================== */

function AskFlow({
  vm,
  reason,
  setReason,
  onClose,
}: {
  vm: LocationHubViewModel;
  reason: ReasonValue | null;
  setReason: (r: ReasonValue) => void;
  onClose: () => void;
}) {
  const filtered = vm.visibleRecipients;
  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Request with context"
        title="Make it comfortable"
        description="Requests should explain why. The other person chooses whether to share."
      />

      <SectionCard title="Person">
        <PersonSearchInput
          value={vm.recipientSearch}
          onChange={vm.setRecipientSearch}
        />
        {filtered.length ? (
          <div className={cn("mt-3", PEOPLE_LIST_SCROLL_CLASS)}>
            {filtered.map((r) => {
              const selected = vm.selectedRequestOwnerIds.includes(r.userId);
              return (
                <TrustedPersonCard
                  key={r.userId}
                  name={vm.recipientLabel(r)}
                  subtitle="Ready for private sharing"
                  tone="ready"
                  actionLabel={selected ? "Selected" : "Select"}
                  actionAriaLabel={`${
                    selected ? "Deselect" : "Select"
                  } ${vm.recipientLabel(r)} for location request`}
                  onAction={() => vm.toggleRequestOwner(r.userId, "ask_flow")}
                  selected={selected}
                />
              );
            })}
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState
              title="No one to request from yet"
              description="Invite someone to your Circle, then ask them to share."
            />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Duration requested">
        <DurationSelector
          value={vm.durationHours}
          onChange={vm.setDurationHours}
          label=""
        />
      </SectionCard>

      <SectionCard title="Reason">
        <ReasonChips value={reason} onChange={setReason} label="" />
      </SectionCard>

      <SectionCard title="Message">
        <textarea
          value={vm.requestMessage}
          onChange={(e) => vm.setRequestMessage(e.target.value)}
          rows={2}
          placeholder="Hey, can you share your location until we meet?"
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
      </SectionCard>

      <TrustNoteCard
        title="No silent tracking"
        description="They approve, decline, or ignore."
      />

      <Button
        onClick={() => {
          vm.onSendRequest(reason);
          onClose();
        }}
        disabled={!vm.selectedRequestOwnerIds.length}
        isLoading={vm.busy === "request"}
        className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:opacity-50"
      >
        Send request
      </Button>
    </div>
  );
}

/* =================================================================== */
/* INVITE FLOW                                                          */
/* =================================================================== */

function InviteFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const created =
    Boolean(vm.circleInviteUrl) || Boolean(vm.latestActiveCircleInvite);

  if (created) {
    const invite = vm.latestActiveCircleInvite;
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Share invite link"
          title="Invite link created"
          description="They must approve before location sharing starts."
        />
        <SectionCard>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
              <UserPlus className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-foreground">
                Circle invite
              </p>
              <p className={MUTED_TEXT}>
                {invite
                  ? vm.expiresLabel(invite.expiresAt)
                  : "Invite expires soon"}
              </p>
            </div>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/12 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
              Pending
            </span>
          </div>
        </SectionCard>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={vm.onShareCircleInvite}
            className="h-11 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            <Send className="mr-1.5 h-4 w-4" />
            Share invite
          </Button>
          <Button
            variant="outline"
            onClick={vm.onCopyCircleInvite}
            className="h-11 rounded-full text-sm"
          >
            Copy link
          </Button>
        </div>
        {invite ? (
          <Button
            variant="ghost"
            onClick={() => vm.onRevokeCircleInvite(invite)}
            isLoading={vm.busy === "circleRevoke"}
            className="h-11 w-full rounded-full text-sm text-red-600 hover:text-red-700 dark:text-red-300"
          >
            Revoke invite
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-11 w-full rounded-2xl text-sm"
        >
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Invite to One / Circle"
        title="Invite to Circle"
        description="Use this when the person is not ready for private location sharing yet."
      />
      <SectionCard title="What happens next?">
        <p className="text-sm text-muted-foreground">
          They sign in, verify phone, and approve before private sharing starts.
          This invite does not share your live location.
        </p>
      </SectionCard>
      <SectionCard title="Invite expires after">
        <DurationSelector
          value={vm.durationHours}
          onChange={vm.setDurationHours}
          label=""
          options={[
            { value: "1", label: "1 hour" },
            { value: "24", label: "24 hours" },
            { value: "168", label: "7 days" },
          ]}
        />
      </SectionCard>
      <TrustNoteCard
        title="No location is shared by creating an invite"
        description="Sharing starts only after they approve."
      />
      <Button
        onClick={vm.onCreateCircleInvite}
        isLoading={vm.busy === "circleInvite"}
        className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
      >
        Create invite
      </Button>
    </div>
  );
}

/* =================================================================== */
/* TEMPORARY LINK FLOW                                                  */
/* =================================================================== */

/** Same precision story as ShareFlow — see the note there. */
function TemporaryLinkFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const created =
    Boolean(vm.publicInviteUrl) || Boolean(vm.latestActivePublicInvite);

  if (created) {
    const invite = vm.latestActivePublicInvite;
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Copy, share or revoke"
          title="Public location link active"
        />
        <WarningCard
          title="Anyone with this link can view your location until it expires."
          description="Public access ends automatically at expiry."
        />
        {invite ? (
          <TemporaryLinkCard
            title="Public location link active"
            statusLine="Anyone with this link can view you"
            expiryLabel={vm.expiresCountdownLabel(invite.expiresAt)}
            onCopy={vm.onCopyPublicInvite}
            onShare={vm.onSharePublicInvite}
            onRevoke={() => vm.onRevokePublicInvite(invite)}
            revokeBusy={vm.busy === "publicRevoke"}
          />
        ) : null}
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-11 w-full rounded-2xl text-sm"
        >
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Share with anyone outside Circle"
        title="Share outside your Circle"
        description="Use only when the person is not in your trusted Circle."
      />
      <WarningCard
        title="Important"
        description="Anyone with this link can view your location until it expires."
      />
      <SectionCard title="Duration">
        <DurationSelector
          value={vm.durationHours}
          onChange={vm.setDurationHours}
          label=""
          options={[
            { value: "0.25", label: "15 min" },
            { value: "0.5", label: "30 min" },
            { value: "1", label: "1 hour" },
          ]}
        />
      </SectionCard>
      {/* The temporary link shares the same precise point as everything else,
          so it offers no precision card either. */}
      <TrustNoteCard
        title="Expires automatically"
        description="Public location links are safer when they expire quickly."
      />
      <Button
        onClick={vm.onCreatePublicInvite}
        isLoading={vm.busy === "publicInvite"}
        className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
      >
        Review public location link
      </Button>
    </div>
  );
}

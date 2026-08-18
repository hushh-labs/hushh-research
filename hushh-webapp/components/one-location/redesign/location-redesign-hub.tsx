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
  Link as LinkIcon,
  Lock,
  Map,
  MapPin,
  MessageCircleQuestionMark,
  Navigation,
  Plus,
  Send,
  Check,
  ChevronRight,
  Shield,
  ShieldCheck,
  UserPlus,
  UsersRound,
} from "lucide-react";

import { requestRecipientStatus } from "@/lib/one-location/request-recipient-status";
import {
  locationApproveActionLabel,
  locationAskPromptLine,
  locationTimestampMs,
} from "@/lib/one-location/duration-copy";
import { formatShareEndsAt } from "@/lib/one-location/share-countdown";
import {
  isSmsTriggeredGrant,
  ONE_LOCATION_GRANT_ID_PARAM,
} from "@/lib/one-location/notifications";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LocationPermissionRecoveryCard } from "@/components/one-location/location-permission-recovery-card";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  RowDescription,
  RowLabel,
  SectionTitle,
} from "@/components/app-ui/typography";
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
import {
  isCircleSelectionFullySelected,
  type CircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";

import {
  Avatar,
  EmptyState,
  SectionCard,
  StatusPill,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "./primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import {
  initialsFrom,
  RequestCard,
  SharedWithMeCard,
  TemporaryLinkCard,
  TrustedPersonCard,
  type GrantViewStatus,
} from "./cards";

export type { GrantViewStatus } from "./cards";
// LocationTypeSelector stays exported from ./selectors, unused for now, so
// PR #4767 can wire it back to a real precision mode without rebuilding it.
import {
  DurationSelector,
  PersonSearchInput,
  ReasonChips,
  type ReasonValue,
} from "./selectors";
import {
  LiveShareStatusCard,
  ShareCountdownText,
  type LiveShareStatus,
} from "@/components/one-location/redesign/live-share-status-card";
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import {
  QuickActionCard,
  QuickActionsSection,
} from "@/components/one-location/redesign/quick-actions";
import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { ROUTES } from "@/lib/navigation/routes";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { usePageEnterAnimation } from "@/lib/morphy-ux/hooks/use-page-enter";
import { resolveSmsContactsBackAction } from "@/lib/navigation/top-shell-breadcrumbs";
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
import { useMediaQuery } from "@/lib/morphy-ux/use-media-query";

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

/**
 * What a settled request says in the "Requests sent" list.
 *
 * Everything that was not live used to read "Pending", including requests that
 * had been declined or taken back -- so a request the person themselves had
 * already withdrawn still sat there claiming to be waiting on somebody.
 */
function requestStatusWord(status: string): string {
  if (status === "denied") return "Declined";
  if (status === "cancelled") return "Taken back";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export type LocationHubViewModel = {
  /* identity / gating */
  userId: string | null;
  canShare: boolean;
  busy: string | null;
  /** Id of the grant currently being revoked (per-grant Stop sharing spinner). */
  revokingGrantId: string | null;
  /** Id of the sent request currently being taken back, or null. */
  withdrawingRequestId: string | null;
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
  /**
   * Approve incoming location requests without being asked each time. Applies
   * only to requests that arrive after it is switched on -- people already
   * waiting stay the person's own decision.
   */
  autoApproveRequestsEnabled: boolean;
  locationPaused: boolean;
  locationAccuracyLimited: boolean;
  /**
   * Location is on and the device has not produced a fix yet. Drives the status
   * text only — never a disabled control, because this is exactly the window in
   * which someone is most likely to want to change their mind.
   */
  locationAcquiring: boolean;
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
  /**
   * Your running shares, restored from the device before the server answers.
   * The Location screen has to keep showing the hour you chose after you leave
   * and come back, so this survives the memory-only state snapshot expiring.
   * `null` when nothing of yours is live.
   */
  liveShare: LiveShareStatus | null;
  /** Called once when the live share's countdown reaches zero. */
  onLiveShareEnded: () => void;
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
  onAutoApproveRequestsChange: (enabled: boolean) => void;
  onRequestPermission: () => void;
  onOpenLocationSettings: () => void;
  onSyncContacts: () => void;
  /** Legacy composer only: pre-flights device permission, then opens review. */
  onOpenShareReview: () => void;
  /**
   * Records that the merged confirm step's consent read-back is on screen.
   * Side-effect free by design — see `announceShareReviewOpened`. Asking the OS
   * for permission here would prompt merely because a screen rendered; the
   * share itself runs that pre-flight when it actually needs the point.
   */
  onEnterShareConfirm: () => void;
  onConfirmShare: () => void;
  /** Resolves true when at least one request actually reached the server. */
  onSendRequest: (reason?: string | null) => Promise<boolean>;
  onAskReshare: (grant: OneLocationGrant) => void;
  onApprove: (request: OneLocationAccessRequest) => void;
  onDeny: (requestId: string) => void;
  /**
   * Take back a request YOU sent. Not `onDeny`, which is the owner refusing an
   * ask made of them -- these are opposite ends of the same request.
   */
  onWithdrawRequest: (requestId: string) => void;
  onViewGrant: (grant: OneLocationGrant) => void;
  onStopGrant: (grantId: string) => void;
  /** Grant currently showing the inline duration editor, or null. */
  editingGrantId: string | null;
  /**
   * Grant whose duration is being saved, or null. Deliberately not
   * `revokingGrantId`: one flag for both made Save and Remove spin together,
   * and left Save stuck spinning on the next Edit of the same person.
   */
  savingGrantId: string | null;
  onEditGrantStart: (grantId: string) => void;
  onEditGrantCancel: () => void;
  editGrantDurationHours: string;
  setEditGrantDurationHours: (v: string) => void;
  onEditGrantSave: (params: {
    ownerUserId: string;
    grantId: string;
    ownerLabel: string;
  }) => void;
  /*
   * The same edit, for the share you are giving rather than the one you are
   * receiving. It is separate state because it is a different consent: the
   * block above asks someone else for more of their location, this one revises
   * your own, so it applies straight away and never turns into a request.
   */
  /** True while the live share card's inline time editor is open. */
  liveShareDurationEditing: boolean;
  /** Wheel value, in decimal hours, or "until_stopped". */
  liveShareDurationHours: string;
  setLiveShareDurationHours: (v: string) => void;
  liveShareDurationSaving: boolean;
  onEditLiveShareDurationStart: () => void;
  onEditLiveShareDurationCancel: () => void;
  onSaveLiveShareDuration: () => void;
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
  /**
   * Bumped by the voice `location.send_check_in` action while this flow is
   * mounted. `CheckInFlow` watches it and submits its own local draft --
   * page.tsx has no reach into that component's selection state otherwise.
   */
  voiceCheckInSendRequestId?: number;

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
  /**
   * The page's ticking clock. Passed down rather than read per component so
   * every "45 more min left" on the screen moves together and agrees; a
   * component reading its own `Date.now()` at render freezes at whatever it
   * said when it mounted.
   */
  nowMs: number;

  /* map preview renderer (reuses page LocalMapPreview to keep crypto/view path) */
  renderMapPreview: (
    point: PlainLocationPoint,
    showNavigation?: boolean,
    viewportResetKey?: string | number,
    staleAction?: ReactNode,
  ) => ReactNode;
  mapLocationHref: (point: PlainLocationPoint) => string;
  decryptedPoints: Record<string, PlainLocationPoint>;
  /**
   * Why a received share has no point on screen, keyed by grant id. Mirrors
   * `decryptedPoints`: a grant appears in exactly one of the two.
   *
   * Optional so an existing view model keeps type-checking, but leaving it out
   * is what produced the bug this exists to fix — the page computed these
   * statuses on every five-second poll and the only component that rendered
   * them was the retired legacy UI, so a recipient waiting on a first point,
   * or blocked by a rotated key, saw a card with a name and nothing else.
   */
  grantViewStatuses?: Record<string, GrantViewStatus>;
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
// Emergency contacts is reachable from Settings AND from SOS, so its back arrow
// cannot be a constant. Recording the opener in the URL keeps the in-content
// arrow agreeing with the chrome and OS back buttons, which follow real history.
const SOS_FLOW_SOURCE = "sos";

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

/**
 * Where the Emergency-contacts back arrow goes.
 *
 * It has two openers -- Settings and SOS -- so a fixed target is wrong for one
 * of them. This used to be hardcoded to Settings on the reasoning that contacts
 * were "only ever opened from Settings"; the SOS entry point was added later and
 * the assumption was never revisited, so anyone editing contacts mid-emergency
 * was dropped out of the SOS flow.
 *
 * Settings stays the default: an unknown or absent source means the person did
 * not arrive from SOS, and Settings is where the rest of the entry points live.
 */
export function resolveSmsContactsBackFlow(
  source: string | null | undefined,
): "sos" | "settings" {
  // Delegates so the rule has ONE implementation: the top bar is what actually
  // performs this navigation now, and it resolves the target the same way.
  return resolveSmsContactsBackAction(source);
}

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

/**
 * The id the header switch points `aria-describedby` at. A constant, not
 * `useId`: `aria-describedby` resolves by id anywhere in the document, and
 * there is exactly one Location header on screen.
 */
const LOCATION_HEADER_STATUS_ID = "one-location-header-status";

/** What the header switch currently means, in words. */
function locationHeaderStatusText(vm: LocationHubViewModel): string {
  if (vm.locationAcquiring) return "Finding you\u2026";
  return locationStatusLabel({
    readiness: vm.locationBlocked
      ? ("blocked" as const)
      : vm.locationEnabled
        ? ("ready" as const)
        : ("askable" as const),
    previewOn: vm.locationEnabled,
    paused: vm.locationPaused,
    accuracyLimited: vm.locationAccuracyLimited,
  });
}

/**
 * The status line for the Location header, rendered directly under the
 * switch it describes, in the same right-aligned column.
 *
 * Two other positions have been tried and rejected. Beside the switch, the
 * full string made the actions column wide enough to wrap the 28px "Location
 * Agent" title at every iPhone width. Under the TITLE (a full-width row below
 * the whole header) it no longer wrapped anything, but its right edge only
 * matched the switch's by coincidence — two independent right-alignments,
 * not a paired control, which read as visually unbalanced (#5404). Grouping
 * it with the switch in one flex column makes the pairing structural: same
 * box, same right edge, one small fixed gap.
 */
function LocationHeaderStatus({ vm }: { vm: LocationHubViewModel }) {
  return (
    <span
      id={LOCATION_HEADER_STATUS_ID}
      data-testid="one-location-header-status"
      className="ui-text-helper-text text-[color:var(--app-secondary-label)]"
    >
      {locationHeaderStatusText(vm)}
    </span>
  );
}

function LocationHeaderActions({ vm }: { vm: LocationHubViewModel }) {
  const locationOn = vm.locationEnabled;
  const acquiring = vm.locationAcquiring;

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
      aria-label="Location"
      // Switch on top, its status directly beneath — one right-aligned
      // column so the two read as a single paired control instead of a
      // switch up here and a caption somewhere else on the screen.
      className="ml-auto flex shrink-0 flex-col items-end gap-1"
      data-testid="one-location-header-actions"
    >
      <Switch
        size="ios"
        checked={locationOn}
        onCheckedChange={handleLocationChange}
        // Deliberately never disabled. What it controls is local state that
        // flips on tap, so a disabled window could only ever swallow the
        // person's NEXT tap — during the very seconds the device spends
        // finding them, which is when they are most likely to change their
        // mind. The status text carries the waiting instead.
        aria-label={locationOn ? "Turn location off" : "Turn location on"}
        // The status text is the switch's description, not decoration. It used
        // to be aria-hidden, so a VoiceOver user got "Turn location on" and no
        // way to hear whether it was blocked, paused, or still finding them.
        aria-describedby={LOCATION_HEADER_STATUS_ID}
        // The same pair of contract actions the Settings toggle carries.
        // Both are the same control in two places, so voice can offer
        // pause/resume from the Now tab without opening Settings first.
        data-voice-control-id="one-location-updates-toggle"
        // No colour override: the shared Switch already carries the iOS
        // system green, so this toggle reads the same as every other one.
        className={cn(acquiring && "animate-pulse")}
      />
      <LocationHeaderStatus vm={vm} />
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
      : ROUTES.ONE_LOCATION_CHECK_IN;
  const [tab, setTabState] = useState<LocationHubTab>(() =>
    resolveLocationHubTab(searchParams.get(LOCATION_HUB_TAB_PARAM)),
  );
  const [flow, setFlow] = useState<FlowKind>("none");
  // Opening a flow (SOS, Share, Ask, ...) mounts a fresh subtree under
  // whatever scroll offset the Now/People/Links tab was left at -- the
  // app-shell scroll-reset instance only keys on tab identity, never on
  // `?action=`, so it never sees this transition. Without this, tapping an
  // action after scrolling down reads as an abrupt jump (#5430).
  useScrollReset(flow, { enabled: flow !== "none", behavior: "auto" });
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  // The bare conditional swap below had no enter transition at all, unlike
  // every route-level surface in the app. Same canonical Morphy page-enter
  // used by pkm-settings-shell.tsx and route navigation generally, keyed on
  // `flow` so swapping between task flows (not just entering/leaving one)
  // re-triggers it (#5430).
  usePageEnterAnimation(flowContainerRef, {
    key: flow,
    enabled: flow !== "none",
  });
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
      // Always name the tab, including the default one. Returning to Now by
      // deleting the parameter can leave the query empty, and the App Router
      // will not perform a navigation whose only change is that the whole
      // query string disappears -- the tab would highlight while the URL, and
      // anything reading it, stayed on the previous tab.
      params.set(LOCATION_HUB_TAB_PARAM, next);
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
      params.delete("section");
      if (detailAction) {
        params.delete(LOCATION_HUB_TAB_PARAM);
        params.set(FLOW_ACTION_PARAM, FLOW_TO_ACTION[detailAction]);
      } else {
        params.delete(FLOW_ACTION_PARAM);
        // Name the tab, default included: a notification that resolves to the
        // plain hub would otherwise leave an empty query, which the App Router
        // declines to navigate to, stranding the person on the notification's
        // own URL.
        params.set(LOCATION_HUB_TAB_PARAM, nextTab ?? "now");
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
    (next: Exclude<FlowKind, "none">, source?: string) => {
      setFlow(next);
      activeFlowRef.current = next;
      pendingFlowRef.current = next;
      const params = new URLSearchParams(searchParams.toString());
      // Carrying no source is the normal case and must clear a stale one,
      // otherwise the previous flow's opener would be inherited by the next.
      if (source) {
        params.set(FLOW_SOURCE_PARAM, source);
      } else {
        params.delete(FLOW_SOURCE_PARAM);
      }
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
      // Name the tab the flow is closing onto, default included. Dropping
      // `?action=` was often the only change left, and the App Router will not
      // perform a navigation whose only change is that the whole query string
      // disappears -- Cancel and Done would clear the flow's local state while
      // the URL kept it open, and re-render it straight back.
      params.set(LOCATION_HUB_TAB_PARAM, nextTab ?? tab);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [flow, pathname, router, searchParams, tab, vm],
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
      // Same reason as everywhere else in this file: dropping `?action=` was
      // often the only change, and that navigation does not happen. The toast
      // said the action was gone while the retired screen stayed on screen.
      params.set(LOCATION_HUB_TAB_PARAM, "now");
      const query = params.toString();
      toast.message("That's no longer there.");
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
      // Straight to the screen that owns the flow. This used to hand off to
      // `/one/location/map?action=check-in`, which mounts Your Map -- a screen
      // that structurally cannot show check-in, since the sheet and the place
      // list are withheld unless `surface="check-in"` -- and lets its own
      // redirect carry on to the same destination. The person saw the wrong
      // map appear and jump away, the Google renderer was built and torn down
      // for nothing, and an extra history entry was left behind. Anyone
      // arriving on `?action=check-in` from outside the app still gets that
      // legacy redirect; nothing inside the app should be using it.
      router.replace(ROUTES.ONE_LOCATION_CHECK_IN, {
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
  // the 2-step share flow and return to the main One Location hub.
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
        ref={flowContainerRef}
        className="space-y-6 pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
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
            onEditContacts={() => openFlow("sms-contacts", SOS_FLOW_SOURCE)}
          />
        ) : flow === "sms-contacts" ? (
          <SmsContactsFlow
            recipients={vm.smsContactCandidates}
            circles={vm.circles}
            selectedUserIds={vm.smsContactUserIds}
            busyKey={vm.busy}
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
            focusGrantId={searchParams.get(ONE_LOCATION_GRANT_ID_PARAM)}
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
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Location Agent"
        icon={MapPin}
        accent="location"
        titleRole="agent"
        // No `description` — the switch and its status render together as
        // one group inside `actions`. See LocationHeaderActions.
        actionsInlineMobile
        actions={<LocationHeaderActions vm={vm} />}
      />

      {/*
        Directly under the header, above the tabs, because a blocked permission
        is not a detail of one tab — it is the reason every Location feature
        below is inert. It used to be announced only by the word "blocked" in
        the header status and a toast that had already gone, which is how
        someone ended up on this screen with nothing to act on.
      */}
      <LocationPermissionRecoveryCard
        blocked={vm.locationBlocked}
        busy={vm.locationAcquiring}
        onRetry={vm.onShowMyLocation}
        onOpenSettings={vm.onOpenLocationSettings}
      />


      <div className="-mx-[var(--page-inline-gutter-standard)]">
        <SwipeViews
          tabSetId={LOCATION_TAB_DEFINITION.id}
          activeValue={tab}
          options={LOCATION_SWIPE_OPTIONS}
          onSelectionChange={(value) => setTab(value as LocationHubTab)}
          viewportMinHeight="0px"
          heightMode="active"
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
                  ? router.push(ROUTES.ONE_LOCATION_CHECK_IN)
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
            />
          </LocationHubPanel>

          <LocationHubPanel>
            <LinksHub
              vm={vm}
              onCreateTempLink={() => openFlow("temp-link")}
              onManageTempLink={() => openFlow("temp-link")}
            />
          </LocationHubPanel>
        </SwipeViews>
      </div>
    </div>
  );
}

/** Quiet text actions used by the reference-style People section headers. */
const PEOPLE_HEADER_ACTION =
  "relative !h-auto !min-h-0 !rounded-none !px-0 !py-0 text-[16px] font-normal leading-5 tracking-[-0.24px] after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] sm:text-[15px]";

/** People-only grouped surface: compact geometry, shared semantic theme. */
const PEOPLE_GROUP_SURFACE =
  "max-h-[50vh] overflow-y-auto overflow-x-hidden rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] shadow-[var(--app-card-shadow-standard)]";

function LocationHubPanel({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4 px-[var(--page-inline-gutter-standard)]">
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
  const groupedShellClassName =
    "[--settings-group-radius:16px] bg-white shadow-none dark:bg-[#1C1C1E]";
  // State beats category on every counted row: colour here means "there is
  // something here", never "this row exists". A zero count is a neutral row.
  // "Needs my review" already worked this way; "Active shares" and "Shared with
  // me" were pinned to action blue, so an empty Location screen showed three
  // saturated blue tiles reporting 0, 0, 0 — colour that carried no information
  // and left nothing for the rows that did.
  const reviewIconTone =
    vm.pendingOwnerRequests.length > 0 ? "orange" : "gray";
  // The device record keeps counting while the server state reloads, so the row
  // no longer drops to 0 for the second or two after you re-enter the screen.
  const activeShareCount = Math.max(
    vm.activeOwnerGrants.length,
    vm.liveShare?.count ?? 0,
  );
  // Green = sharing is live right now (the same meaning the header switch and
  // Check-In carry).
  const activeSharesIconTone = activeShareCount > 0 ? "green" : "gray";
  // Indigo = other people, matching the People tab's circles and trusted
  // contacts, rather than the blue reserved for actions you initiate.
  const sharedWithMeIconTone =
    vm.receivedGrants.length > 0 ? "indigo" : "gray";

  return (
    <div className="space-y-4" data-testid="one-location-now-hub">
      {/* Sharing is the one thing on this screen that keeps running after you
          leave it, so it reports itself first and keeps its own clock. */}
      {vm.liveShare ? (
        <LiveShareStatusCard
          status={vm.liveShare}
          onManage={onOpenActiveShares}
          onStop={
            vm.liveShare.stoppableGrantId
              ? () => vm.onStopGrant(vm.liveShare?.stoppableGrantId ?? "")
              : undefined
          }
          stopBusy={
            Boolean(vm.liveShare.stoppableGrantId) &&
            vm.revokingGrantId === vm.liveShare.stoppableGrantId
          }
          // Same gate as Stop, for the same reason: with several shares
          // running there is no single one for "change time" to mean.
          onChangeDuration={
            vm.liveShare.stoppableGrantId
              ? vm.onEditLiveShareDurationStart
              : undefined
          }
          onEnded={vm.onLiveShareEnded}
        />
      ) : null}
      {vm.liveShare && vm.liveShareDurationEditing ? (
        <LiveShareDurationEditor
          value={vm.liveShareDurationHours}
          onChange={vm.setLiveShareDurationHours}
          onCancel={vm.onEditLiveShareDurationCancel}
          onSave={vm.onSaveLiveShareDuration}
          saving={vm.liveShareDurationSaving}
        />
      ) : null}
      {/* Every row and tile below carries the `control_ids` / `action_id` pair
          it was authored with in the Location voice action contract, so One and
          the search bar can name the individual control a person is asking for
          rather than only the screen it lives on. */}
      {/* The two things a person DOES on this screen, together. Sharing your
          location and asking for someone else's are the same kind of decision
          pointed in opposite directions, and they were two groups apart — one
          alone at the top, the other buried under three status rows. Everything
          below is what is already happening, or where to look at it. */}
      <SettingsGroup
        separatorInset
        testId="one-location-now-share"
        shellClassName={groupedShellClassName}
      >
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
        {/* Asking someone to share was reachable only from the People tab, so
            the Now tab listed every way to give a location out and none to ask
            for one. Same flow and same voice control id as that entry -- this
            is an additional way in, not a second implementation. */}
        {/* Not `Send`: that is the same paper-plane silhouette as `Navigation`
            on "Share location" two rows up, so at row size the two entries read
            as the same icon -- and they are opposites. A speech bubble asking a
            question is distinct at a glance and matches what the flow does:
            "Requests should explain why. The other person chooses whether to
            share." Radar and Crosshair were rejected for implying tracking on a
            surface built around consent. */}
        <SettingsRow
          icon={MessageCircleQuestionMark}
          iconTone="blue"
          title="Request location"
          density="compact"
          chevron
          onClick={onRequestLocation}
          testId="one-location-request-row"
          voiceControlId="one-location-action-ask"
          voiceActionId="location.open_ask"
        />
      </SettingsGroup>
      <SettingsGroup
        separatorInset
        testId="one-location-now-status"
        shellClassName={groupedShellClassName}
      >
        <SettingsRow
          icon={Map}
          iconTone="blue"
          title="Your Map"
          density="compact"
          chevron
          onClick={onOpenMap}
          testId="one-location-map-row"
          voiceControlId="one-location-open-map"
          voiceActionId="location.open_map"
        />
        <SettingsRow
          icon={UsersRound}
          iconTone={activeSharesIconTone}
          title="Active shares"
          density="compact"
          trailing={activeShareCount}
          chevron
          onClick={onOpenActiveShares}
          voiceControlId="one-location-action-active-shares"
          voiceActionId="location.open_active_shares"
        />
        <SettingsRow
          icon={MapPin}
          iconTone={sharedWithMeIconTone}
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
          iconTone={reviewIconTone}
          title="Needs my review"
          density="compact"
          trailing={vm.pendingOwnerRequests.length}
          chevron
          onClick={onOpenNeedsReview}
          voiceControlId="one-location-action-needs-review"
          voiceActionId="location.open_needs_review"
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
        {/* Green, not blue: Check-In is a presence state you enter, the same
            family as the header switch being on — and it is the one tile that
            sits beside the red SMS tile, where "safe / emergency" has to read
            at a glance. Blue here made the two tiles differ only in the second
            colour, not the first. */}
        <QuickActionCard
          tone="green"
          icon={<ShieldCheck />}
          title="Check-In"
          subtitle={checkInSubtitle}
          onClick={onCheckIn}
          controlId="one-location-action-check-in"
        />
        <QuickActionCard
          tone="red"
          icon={<Shield />}
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
  focusGrantId,
  collapsedGrantIds,
  onCollapseGrant,
  onExpandGrant,
}: {
  kind: "active-shares" | "shared-with-me" | "needs-review";
  vm: LocationHubViewModel;
  /** Grant id from a notification deep link (?grantId=...) to scroll to and
   * briefly highlight once its card is on screen. */
  focusGrantId?: string | null;
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
      // The skeleton has exactly one way to stop: this settling the entry. It
      // used to have three ways not to, and all three left it spinning
      // forever under a pin that never resolved.
      const settle = (text: string | null) => {
        setAddressByGrant((current) => {
          const entry = current[grant.id];
          // Still keyed to these coordinates? A newer position owns the row
          // now, and its own lookup will settle it.
          if (!entry || entry.key !== key) return current;
          return { ...current, [grant.id]: { key, status: "done", text } };
        });
      };
      void reverseGeocodePoint(point)
        .then(settle)
        .catch(() => {
          // 1. A rejected lookup never settled anything, so one network
          //    hiccup meant a permanent skeleton. Falling through to `done`
          //    with no text lets the card show the coordinates it already
          //    has, which is worse than a street name and far better than
          //    a grey bar.
          //
          // 2. The retry guard was claimed BEFORE the call, so a failure was
          //    permanent for those coordinates -- the loop skipped them on
          //    every later pass and never tried again. Releasing it here
          //    means the next refresh at this position gets another go.
          if (resolvedAddressKeyRef.current[grant.id] === key) {
            delete resolvedAddressKeyRef.current[grant.id];
          }
          settle(null);
        });
    }
    // 3. No `cancelled` flag. `vm.decryptedPoints` changes on the five-second
    //    live refresh, so this effect re-runs constantly; cancelling on
    //    cleanup abandoned every in-flight lookup, while the guard above
    //    stopped it being retried. That combination -- not a failing geocoder
    //    -- is what left the address loading indefinitely in normal use.
    //    `settle` is keyed by coordinates, so a late resolution either lands
    //    on the row it belongs to or is ignored.
  }, [kind, reverseGeocodePoint, vm.receivedGrants, vm.decryptedPoints]);

  // Deep link from an SOS notification (?grantId=...) scrolls to and briefly
  // rings the matching card once it is on screen. Deliberately NOT keyed on
  // `vm.receivedGrants`: that array gets a new reference on every live poll
  // (LIVE_VIEW_REFRESH_INTERVAL_MS, ~5s), and re-running this per poll tick
  // would re-scroll and re-flash the ring for as long as `grantId` stays in
  // the URL. Instead this fires once per (kind, focusGrantId) and retries
  // briefly on its own if the card isn't in the DOM yet (state still loading).
  const dangerRole = roleClasses("danger");
  useEffect(() => {
    if (kind !== "shared-with-me" || !focusGrantId) return;
    let cancelled = false;
    let attempts = 0;
    const tryHighlight = () => {
      if (cancelled) return;
      const node = document.querySelector(`[data-grant-id="${focusGrantId}"]`);
      if (!node) {
        if (attempts++ < 20) setTimeout(tryHighlight, 250);
        return;
      }
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("ring-2", dangerRole.border, "ring-offset-2");
      setTimeout(() => {
        node.classList.remove("ring-2", dangerRole.border, "ring-offset-2");
      }, 2400);
    };
    tryHighlight();
    return () => {
      cancelled = true;
    };
  }, [kind, focusGrantId, dangerRole.border]);
  const copy = {
    "active-shares": {
      title: "Active shares",
      description: "People who can see your location.",
    },
    "shared-with-me": {
      title: "Shared with me",
      description: "Locations people are sharing with you.",
    },
    "needs-review": {
      title: "Needs my review",
      description: "Approve before sharing.",
    },
  }[kind];

  return (
    <div className="space-y-5" data-testid={`one-location-${kind}`}>
      <TaskFlowHeader
        eyebrow="Location"
        title={copy.title}
        description={copy.description}
      />
      {kind === "active-shares" ? (
        vm.activeOwnerGrants.length ? (
          <SettingsGroup separatorInset>
            {vm.activeOwnerGrants.map((grant) => (
              <SettingsRow
                key={grant.id}
                icon={UsersRound}
                // Green, matching the "Active shares" row that opens this
                // screen. Each row here IS one of those live grants, and
                // "purple" renders byte-identically to blue in the tone map —
                // so tapping a green row reporting 3 landed on three blue rows
                // for the same 3 grants. One object, one colour.
                iconTone="green"
                title={vm.grantRecipientLabel(grant)}
                description={
                  grant.durationMode === "until_stopped" ? (
                    "Until you stop"
                  ) : (
                    // Was a string computed once per render, so it froze the
                    // moment the screen stopped re-rendering.
                    <ShareCountdownText expiresAt={grant.expiresAt} />
                  )
                }
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
          <EmptyState title="No active shares" />
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
                <div key={grant.id} data-grant-id={grant.id}>
                <SharedWithMeCard
                  isSmsTriggered={isSmsTriggeredGrant(grant)}
                  name={vm.grantOwnerLabel(grant)}
                  statusLine={
                    grant.durationMode === "until_stopped"
                      ? "Until stopped"
                      : grant.expiresAt
                        ? `Access until ${vm.formatDateTime(grant.expiresAt)}`
                        : "Active"
                  }
                  previewExpanded={expanded}
                  mapHref={point ? vm.mapLocationHref(point) : undefined}
                  onView={() => onExpandGrant(grant)}
                  onDismiss={() => onCollapseGrant(grant.id)}
                  onRecenter={
                    point ? () => recenterGrantViewport(grant.id) : undefined
                  }
                  onRemove={() => vm.onStopGrant(grant.id)}
                  removeBusy={vm.revokingGrantId === grant.id}
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
                  // Only while there is nothing to look at. Once a point lands
                  // it is the answer, and a leftover "waiting for their first
                  // update" line under a live map would contradict it.
                  viewStatus={
                    point ? null : (vm.grantViewStatuses?.[grant.id] ?? null)
                  }
                  onAskReshare={() => vm.onAskReshare(grant)}
                  askReshareBusy={vm.busy === "request"}
                >
                  {expanded && point
                    ? vm.renderMapPreview(
                        point,
                        false,
                        `${grant.id}:${grantViewportResetKeys[grant.id] ?? 0}`,
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => vm.onAskReshare(grant)}
                          disabled={vm.busy === "request"}
                          className="h-8 rounded-full border-amber-500/30 bg-white/70 px-3 text-[12px] font-semibold text-amber-800 hover:bg-white dark:border-amber-300/25 dark:bg-white/10 dark:text-amber-100 dark:hover:bg-white/15"
                        >
                          {vm.busy === "request" ? (
                            <span
                              className="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                              aria-hidden="true"
                            />
                          ) : (
                            <Send
                              className="mr-1.5 h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                          Ask to refresh
                        </Button>,
                      )
                    : null}
                </SharedWithMeCard>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nothing shared with you"
            description="Ask someone to share."
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
                // The amount, and whether it is extra time on a share already
                // running. Every card used to read "Asks to see your location"
                // whether the person wanted fifteen minutes or another day.
                promptLine={locationAskPromptLine(request, vm.nowMs)}
                reason={request.message ?? undefined}
                approveLabel={locationApproveActionLabel(request, vm.nowMs)}
                onApprove={() => vm.onApprove(request)}
                onDecline={() => vm.onDeny(request.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing to review"
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
        // Same tokens as the shared `Switch size="ios"`, not private literals.
        // This used to be `bg-[#34c759]` / `bg-black/15 dark:bg-white/20`, which
        // held the light-mode green in dark mode (where the system value is
        // #30d158) and used an off-track grey that matched no other switch — so
        // the Settings toggles and the header toggle, the same control in two
        // places, did not read as the same colour. Geometry, thumb, travel and
        // behaviour are unchanged.
        checked
          ? "bg-[color:var(--switch-on)]"
          : "bg-[color:var(--switch-off)]",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[27px] w-[27px] rounded-full bg-[color:var(--switch-thumb)] shadow-[0_1px_3px_rgba(0,0,0,0.15)] transition-[left] duration-200",
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
      {/* No header description. Each row below already says what it does, and
          the line that used to sit here ("Control live sharing") describes
          something this screen's first control no longer does. */}
      <TaskFlowHeader eyebrow="Location" title="Settings" />

      <SettingsGroup title="Location sharing" separatorInset>
        {/* The one caveat that cannot be cut: this does not answer the people
            already waiting, and somebody who switches it on expecting their
            approvals list to clear has to be told that here, not by watching
            it stay full. */}
        <SettingsRow
          title="Auto-approve requests"
          description="New requests only. Anyone already waiting still needs your answer."
          trailing={
            <LocationToggle
              checked={vm.autoApproveRequestsEnabled}
              onChange={vm.onAutoApproveRequestsChange}
              label="Auto-approve requests"
            />
          }
          density="compact"
        />
      </SettingsGroup>

      <div className="flex items-start gap-2.5 px-1">
        <Shield className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[color:var(--app-accent)]" />
        <p className={MUTED_TEXT}>
          Nearby Check-In is separate, and only starts when you agree.
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
  first,
  action,
}: {
  name: string;
  subtitle: string;
  /** True when there's a live connection (you're sharing or they're sharing). */
  active: boolean;
  first: boolean;
  action: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[74px] items-center gap-3.5 px-[18px] py-2 transition-colors hover:bg-[color:var(--app-neutral-fill)] motion-reduce:transition-none sm:min-h-[76px] sm:gap-[18px] sm:px-6",
        !first && "border-t border-[color:var(--app-separator)]",
      )}
    >
      <div className="relative shrink-0">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--app-accent-surface)] text-[14px] font-semibold text-[color:var(--app-accent-deep)]">
          {personInitials(name)}
        </span>
        {active ? (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[color:var(--app-primary-surface)] bg-[color:var(--app-success)]" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
        <p className="truncate text-[17px] font-normal leading-[22px] tracking-[-0.37px] text-foreground">
          {name}
        </p>
        <p className="truncate text-[14px] leading-[18px] tracking-[-0.22px] text-[color:var(--app-tertiary-label)]">
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
}) {
  const hasSearch = vm.recipientSearch.trim().length > 0;
  const filtered = vm.visibleRecipients;
  const isDesktopPeopleLayout = useMediaQuery("(min-width: 640px)");
  const addPeopleAction = (
    <Button
      type="button"
      onClick={onAddConnections}
      data-voice-control-id="one-location-add-connections"
      className={cn(
        "rounded-full font-semibold",
        isDesktopPeopleLayout
          ? "h-10 min-h-10 px-[22px] text-[15px]"
          : "h-[54px] min-h-[54px] w-full px-6 text-[16px]",
      )}
    >
      Add people
    </Button>
  );
  const syncContactsAction = (
    <Button
      type="button"
      variant="link"
      size="sm"
      onClick={vm.onSyncContacts}
      isLoading={vm.busy === "contactSync"}
      className={PEOPLE_HEADER_ACTION}
    >
      Find contacts
    </Button>
  );

  return (
    /* No top padding: the tab strip and PageHeader above already set the gap
       every hub tab opens with, so Menu and Links start their first section
       flush against it. People used to add 24px on top of that, and 52px from
       `sm:` up — enough that "Circles" visibly floated lower here than on
       either neighbouring tab. */
    <div data-testid="one-location-people-hub">
      <div className="space-y-10 sm:space-y-[72px]">
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

        <div className="space-y-10 sm:space-y-12">
          <section
            aria-labelledby="one-location-connections-heading"
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-x-6"
            data-testid="one-location-people-connections"
          >
            <h2
              id="one-location-connections-heading"
              className="col-start-1 row-start-1 text-[13px] font-normal leading-[18px] tracking-[-0.2px] text-[color:var(--app-section-label)]"
            >
              Connections
            </h2>

            {isDesktopPeopleLayout ? (
              <div className="col-start-2 row-start-1 justify-self-end">
                {syncContactsAction}
              </div>
            ) : null}

            {/* The reference omits Invite, but it remains a first-class action.
                Keeping it quiet preserves the callback without recreating the
                old banner-like action stack. */}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={onInvite}
              data-voice-control-id="one-location-action-invite"
              className={cn(
                PEOPLE_HEADER_ACTION,
                "col-start-2 row-start-1 justify-self-end text-[color:var(--app-secondary-label)] hover:text-foreground sm:col-start-3",
              )}
            >
              Invite
            </Button>

            <div className="col-start-3 row-start-1 justify-self-end sm:col-start-4">
              {isDesktopPeopleLayout
                ? addPeopleAction
                : syncContactsAction}
            </div>

            <div
              className={cn(
                "col-span-3 row-start-2 mt-3 sm:col-span-4 sm:mt-3.5",
                "[&_input]:h-[46px] [&_input]:rounded-full [&_input]:border-0 [&_input]:bg-[color:var(--app-primary-surface)] [&_input]:pl-[46px] [&_input]:pr-[18px] [&_input]:text-[17px] [&_input]:leading-[22px] [&_input]:tracking-[-0.3px]",
                "[&_svg]:left-[18px] [&_svg]:text-[color:var(--app-tertiary-label)]",
                "sm:[&_input]:h-12 sm:[&_input]:rounded-[var(--app-radius-md)] sm:[&_input]:pl-12 sm:[&_input]:pr-5 sm:[&_input]:text-base sm:[&_svg]:left-5",
              )}
              data-testid="one-location-people-search"
            >
              <PersonSearchInput
                value={vm.recipientSearch}
                onChange={vm.setRecipientSearch}
              />
            </div>

            <div className="col-span-3 row-start-3 mt-3 sm:col-span-4 sm:mt-3.5">
              {filtered.length ? (
                <div
                  className={PEOPLE_GROUP_SURFACE}
                  data-testid="one-location-people-list"
                >
                  {filtered.map((r, i) => {
                    const grant = vm.activeOwnerGrants.find(
                      (g) => g.recipientUserId === r.userId,
                    );
                    const sharing = Boolean(grant);
                    const receiving = vm.receivedGrants.some(
                      (g) => g.ownerUserId === r.userId,
                    );
                    const ready = vm.isRecipientShareReady(r);
                    const name = vm.recipientLabel(r);
                    return (
                      <PersonRow
                        key={r.userId}
                        name={name}
                        // Someone sharing their location with you right now
                        // used to read "Ready for private location sharing" —
                        // the recommendation line, which describes what COULD
                        // happen and so says the opposite of what is. The row
                        // already knew (`receiving`), and spent it on an accent
                        // colour. Two people with the same name, one sharing
                        // and one not, were then indistinguishable except by a
                        // tint, which is the whole reason "is this the same
                        // person or a different one" is hard to answer here.
                        subtitle={
                          receiving ? "Sharing with you" : vm.recipientSubtitle(r)
                        }
                        active={sharing || receiving}
                        first={i === 0}
                        action={
                          sharing && grant ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => vm.onStopGrant(grant.id)}
                              isLoading={vm.revokingGrantId === grant.id}
                              aria-label={`Stop sharing with ${name}`}
                              className="relative h-9 min-h-9 rounded-full px-4 text-[15px] font-semibold after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] sm:px-5"
                            >
                              Stop
                            </Button>
                          ) : ready ? (
                            <Button
                              size="sm"
                              onClick={() => onStartShare(r.userId)}
                              aria-label={`Share with ${name}`}
                              className="relative h-9 min-h-9 rounded-full bg-[color:var(--app-accent)] px-4 text-[15px] font-semibold text-[color:var(--app-accent-fg)] after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] hover:bg-[color:var(--app-accent-hover)] sm:px-5"
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
                <div className="[&>[data-ui-role=grouped-card]]:rounded-[var(--app-radius-md)] [&>[data-ui-role=grouped-card]]:!bg-[color:var(--app-primary-surface)] [&>[data-ui-role=grouped-card]]:shadow-[var(--app-card-shadow-standard)]">
                  <EmptyState
                    title={
                      hasSearch ? "No matching people" : "No connections yet"
                    }
                    description={
                      hasSearch
                        ? "Try a different name."
                        : "Invite someone to start sharing."
                    }
                  />
                </div>
              )}
            </div>

            {!isDesktopPeopleLayout ? (
              <div className="col-span-3 col-start-1 row-start-4 mt-6 w-full">
                {addPeopleAction}
              </div>
            ) : null}
          </section>

          {vm.requestedByMe.length ? (
            <SettingsGroup
              title="Requests sent"
              separatorInset
              shellClassName="[--settings-group-radius:var(--app-radius-md)] !rounded-[var(--app-radius-md)] !bg-[color:var(--app-primary-surface)] !shadow-[var(--app-card-shadow-standard)]"
            >
              {vm.requestedByMe.map((request) => {
                const isLive = /active|approved|shared|granted/i.test(
                  request.status,
                );
                const grantId = request.approvedGrantId;
                const canEdit = isLive && Boolean(grantId);
                const isEditing =
                  Boolean(grantId) && vm.editingGrantId === grantId;
                const ownerLabel = vm.requestOwnerLabel(request);
                return (
                  <div key={request.id}>
                    <SettingsRow
                      icon={Send}
                      iconTone="blue"
                      title={ownerLabel}
                      description={vm.formatDateTime(request.requestedAt)}
                      trailing={
                        canEdit && grantId ? (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9"
                              onClick={() =>
                                isEditing
                                  ? vm.onEditGrantCancel()
                                  : vm.onEditGrantStart(grantId)
                              }
                            >
                              {isEditing ? "Cancel" : "Edit"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 text-destructive"
                              onClick={() => vm.onStopGrant(grantId)}
                              disabled={vm.revokingGrantId === grantId}
                            >
                              {/* Same handler as the two "Stop" buttons above
                                  (vm.onStopGrant). One revocation must not be
                                  described with two verbs — and "Delete" also
                                  overstates it: this ends someone's access, it
                                  does not erase anything. */}
                              Stop
                            </Button>
                          </div>
                        ) : isLive ? (
                          "Active"
                        ) : request.status === "pending" ? (
                          // "Pending" as bare text was the whole trailing slot:
                          // the state was reported and there was nothing to do
                          // about it. The button replaces the word rather than
                          // joining it -- a row you can still take back IS the
                          // waiting one, and every settled row names itself.
                          //
                          // Measured, not assumed: word plus button came to
                          // 161px in this fixed-width slot against the shipped
                          // Edit/Stop pair's 115px, which wrapped the person's
                          // name onto a second line at 320px. The button alone
                          // is 99px. See the layout contract in e2e/.
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 text-destructive"
                            onClick={() => vm.onWithdrawRequest(request.id)}
                            disabled={vm.withdrawingRequestId === request.id}
                            aria-label={`Take back your request to ${ownerLabel}`}
                          >
                            Take back
                          </Button>
                        ) : (
                          requestStatusWord(request.status)
                        )
                      }
                      density="compact"
                    />
                    {isEditing && grantId ? (
                      <div className="space-y-3 px-1 pb-3">
                        <DurationSelector
                          value={vm.editGrantDurationHours}
                          onChange={vm.setEditGrantDurationHours}
                          label="New duration"
                          presentation="select"
                        />
                        {/* Framed as "new duration", not "shorten"/"extend":
                            the person picks a duration like any other
                            duration picker in this app. Whether it applies
                            immediately or turns into a fresh request the
                            owner has to approve is decided server-side by
                            whether it's shorter or longer than what's left --
                            and either outcome is confirmed by the toast that
                            follows. */}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="h-9 flex-1 rounded-full bg-[color:var(--app-accent)] text-sm text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
                            onClick={() =>
                              vm.onEditGrantSave({
                                ownerUserId: request.ownerUserId,
                                grantId,
                                ownerLabel,
                              })
                            }
                            isLoading={vm.savingGrantId === grantId}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </SettingsGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* =================================================================== */
/* LINKS HUB                                                            */
/* =================================================================== */

/** One active-link row: interactive selectable card with live status pill & quick copy. */
function ActiveLinkRow({
  icon,
  tileClass,
  title,
  subtitle,
  onCopy,
  onClick,
  first,
}: {
  icon: ReactNode;
  tileClass: string;
  title: string;
  subtitle: string;
  onCopy: () => void;
  onClick?: () => void;
  first: boolean;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex min-h-[64px] items-center gap-3.5 py-3.5 transition-colors",
        onClick && "cursor-pointer hover:bg-muted/40 active:bg-muted/60",
        !first && "border-t border-[color:var(--app-separator)]",
      )}
    >
      <span
        className={cn(
          "flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]",
          tileClass,
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <RowLabel as="p" className="truncate font-semibold">
            {title}
          </RowLabel>
          <StatusPill tone="live" className="shrink-0 text-[11px] px-2 py-0">
            Live
          </StatusPill>
        </div>
        <RowDescription as="p" className="mt-0.5 truncate">
          {subtitle}
        </RowDescription>
      </div>
      {/* Same geometry as the Copy button inside TemporaryLinkCard, so the one
          action a person meets twice on this surface is the same control both
          times: `sm` owns height and horizontal padding (this used to force
          `px-3.5` against the card's `px-3`), and the pill radius matches every
          other compact action in the feature. Only the accent tint is local —
          it is this row's own affordance, distinct from the row-wide tap. */}
      <Button
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
        size="sm"
        className="shrink-0 rounded-full border-[color:var(--app-accent)] text-[color:var(--app-accent)]"
      >
        Copy
      </Button>
      {onClick ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </div>
  );
}

export function LinksHub({
  vm,
  onCreateTempLink,
  onManageTempLink,
}: {
  vm: LocationHubViewModel;
  onCreateTempLink: () => void;
  onManageTempLink?: () => void;
}) {
  const temp = vm.latestActivePublicInvite;
  const invite = vm.latestActiveCircleInvite;
  const hasLinks = Boolean(temp) || Boolean(invite);

  return (
    <div className="space-y-4">
      <div className="px-[6px]">
        <SectionTitle as="h2">Active links</SectionTitle>
        <RowDescription as="p" className="mt-1">
          Links you can send to anyone — to show where you are, or to invite
          them to a Circle.
        </RowDescription>
      </div>

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
              onClick={onManageTempLink ?? onCreateTempLink}
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
              onClick={onCreateTempLink}
            />
          ) : null}
        </div>
      ) : (
        /* Empty State: ZERO empty white box / div container.
           Show clear description and prominent Create Public Link CTA button directly. */
        <div className="space-y-1 px-1 py-1">
          <p className={MUTED_TEXT}>
            Generate a temporary link to share your live location with anyone outside your Circle.
          </p>
        </div>
      )}

      {/* Conditionally show "Create Public Link" CTA ONLY when NO active public link exists */}
      {!temp ? (
        <Button
          onClick={onCreateTempLink}
          data-voice-control-id="one-location-action-temp-link"
          className="h-11 w-full rounded-full font-semibold"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Public Link
        </Button>
      ) : null}

      <div className="flex items-start gap-2 px-1">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className={MUTED_TEXT}>
          You choose how long — up to 1 hour for a location link, 24 hours for
          an invite.
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
    <>
      {/*
        SOS is the surface where a blocked permission costs the most and was
        explained the least. The recovery card lived only on the hub, so
        someone who opened Save my Soul with location blocked got a toast that
        vanished, two console warnings, and a button that refuses to send —
        with nothing on screen saying why or what to do. The card belongs
        wherever location can fail, not only where it was first added.
      */}
      {vm.locationBlocked ? (
        <div className="mb-4">
          <LocationPermissionRecoveryCard
            blocked
            busy={vm.sosBusy}
            onRetry={onResolveSosLocation}
            onOpenSettings={vm.onOpenLocationSettings}
          />
        </div>
      ) : null}
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
    </>
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
  // Ticks the "access ends" line so a screen left open for a while does not
  // quote a time that has already slipped past.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (step !== "details") return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [step]);

  const setShareReviewOpen = vm.setShareReviewOpen;
  const backToPeople = useCallback(() => {
    // Leaving the confirm step means the person is no longer looking at what
    // they would be agreeing to, so the review flag must not stay latched.
    setShareReviewOpen(false);
    setStep("person");
  }, [setShareReviewOpen, setStep]);

  // The consent read-back is now part of the confirm step rather than a screen
  // of its own, so entering that step is what "the review was shown" means.
  // Fired once per entry: the callback identity changes with the duration, and
  // re-announcing on every duration tweak would be a different claim.
  const onEnterShareConfirm = vm.onEnterShareConfirm;
  const announcedStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "details") {
      announcedStepRef.current = null;
      return;
    }
    if (announcedStepRef.current === "details") return;
    announcedStepRef.current = "details";
    onEnterShareConfirm();
  }, [onEnterShareConfirm, step]);

  const filtered = vm.visibleShareRecipients;
  /**
   * Who can already see you, by recipient — the same `activeOwnerGrants` the
   * Active shares screen lists, read here for the first time.
   *
   * This list used to render every trusted person as an identical row with an
   * identical Select control, so a screen you reached straight after sharing
   * with three people looked exactly like one where you had shared with
   * nobody. Two things went wrong with that. The obvious one is that there was
   * no way to tell, and no way at all on a long list. The one that costs
   * something is underneath: picking someone who already has an active grant
   * does not extend it — the backend revokes the old grant and inserts a new
   * one (`_create_enforced_grant_row`), so a re-pick silently restarts a timer
   * that was already running. Showing the remaining time on the row is what
   * makes that consequence visible before it is chosen.
   */
  const activeGrantByRecipientId = new globalThis.Map(
    vm.activeOwnerGrants.map((grant) => [grant.recipientUserId, grant]),
  );
  const alreadySharing = filtered.filter((recipient) =>
    activeGrantByRecipientId.has(recipient.userId),
  );
  const notSharing = filtered.filter(
    (recipient) => !activeGrantByRecipientId.has(recipient.userId),
  );
  /**
   * One row shape for both groups. Two copies of this JSX would be two places
   * for the select behaviour, the disabled rule and the accessible name to
   * drift apart, on a control whose whole job is to be unambiguous.
   */
  const renderShareRecipientRow = (
    r: OneLocationRecipient,
    activeGrant: OneLocationGrant | undefined,
  ) => {
    const selected = vm.selectedRecipientIds.includes(r.userId);
    const ready = vm.isRecipientShareReady(r);
    const label = vm.recipientLabel(r);
    return (
      <SettingsRow
        key={r.userId}
        density="compact"
        disabled={!ready}
        onClick={
          ready ? () => vm.toggleShareRecipient(r.userId, "share_flow") : undefined
        }
        ariaPressed={ready ? selected : undefined}
        ariaLabel={
          ready
            ? `${selected ? "Deselect" : "Select"} ${label} for private sharing`
            : undefined
        }
        leading={<Avatar initials={initialsFrom(label)} />}
        title={label}
        // Only says something when there is something to say. A row that is
        // ready needs no sentence explaining that it is ready — but a row whose
        // share is already running has a number worth reading, and it is the
        // SAME number, from the same object, that the Active shares screen
        // shows. Two screens describing one grant must not disagree about how
        // long is left on it.
        description={
          activeGrant ? (
            activeGrant.durationMode === "until_stopped" ? (
              "Until you stop"
            ) : (
              <ShareCountdownText expiresAt={activeGrant.expiresAt} />
            )
          ) : ready ? undefined : (
            "Invite them first"
          )
        }
        trailing={ready ? <SelectionDot selected={selected} /> : undefined}
      />
    );
  };
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
  // Picking a Circle selects its ready members in the list below, and those
  // rows remain individually deselectable. Once one is turned off the recipients
  // are no longer that Circle, so the Circle row stops reading as selected.
  const shareCircleFullySelected = isCircleSelectionFullySelected(
    vm.selectedShareCircleSelection,
    vm.selectedRecipientIds,
  );

  // Step 2 of 2 — "Details" and the old separate "Consent check" merged.
  //
  // They were split as set-then-confirm, which put a screen transition between
  // choosing a duration and reading back what that duration meant. Merged, the
  // consent summary is LIVE: the recipient list and the "access ends" time sit
  // directly above the controls that set them, so the answer to "what am I
  // agreeing to" is on screen at the instant the button is pressed rather than
  // one navigation earlier. Nothing was dropped to achieve it — who can see
  // you, for how long, when it ends and that you can stop are all still stated
  // before the share starts, which is the property the consent step existed for.
  if (step === "details") {
    // Only claim the Circle while it is still whole. A partially deselected
    // roster is a hand-picked list of people, and this is the last surface that
    // may overstate who is included.
    const selectedCircle = shareCircleFullySelected
      ? vm.selectedShareCircleSelection
      : null;
    const peopleNoun = selectedReady.length === 1 ? "person" : "people";
    return (
      // A single-column consent form does not get wider just because the window
      // does. Measured at 1440 this step rendered an 824px card holding a 420px
      // control and a 792px note field — three widths in one card, and 372px of
      // empty card to the right of the duration ladder.
      //
      // 560px is this feature's own column measure (the Location onboarding
      // flow uses it at two places), so this adds no new number. Scoped to the
      // Share confirm step rather than the shared flow root on purpose: that
      // root also carries SmsContactsFlow, whose 680/720 desktop widths are
      // deliberate and documented, plus two map previews.
      <div className="mx-auto w-full max-w-[560px] space-y-5">
        {/* No description: the summary card directly below states who can see
            you, for how long and when it ends. Repeating that in prose above it
            is the design explaining itself. */}
        <TaskFlowHeader eyebrow="Step 2 of 2 · Confirm" title="Ready to share?" />

        <section className="space-y-3">
          {/* Label and its Edit action on one line, group beneath. The card
              this replaced carried the action inside its own header; a group
              owns its title, so the affordance sits beside the label it edits
              rather than inside the surface it edits. */}
          <div className="flex items-end justify-between gap-3 px-1">
            <div className="min-w-0">
              <AppSectionLabel as="h2">Can see you</AppSectionLabel>
              <p className={MUTED_TEXT}>
                {selectedCircle
                  ? `${selectedCircle.circle.name} · ${selectedReady.length} ${peopleNoun}`
                  : `${selectedReady.length} ${peopleNoun}`}
              </p>
            </div>
            {/* Raw <button>, not the morphy Button: that component's
                `size.default` carries `min-h-[50px]`, which lives in a
                different tailwind-merge group from `h-*` and therefore
                survives `h-9`. The control rendered 36px tall against a
                50px min-height — under Apple's 44pt tap target on one axis
                and over the row's own height on the other. */}
            <button
              type="button"
              onClick={backToPeople}
              aria-label="Change who can see you"
              className="flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-[color:var(--app-accent)]"
            >
              Edit
            </button>
          </div>
          {selectedReady.length ? (
            /* A real <ul>, not a stack of divs: this is the read-back of who is
               about to see you, and "list, 3 items" is exactly what a screen
               reader should say here. Painted with the same surface, radius and
               inset hairlines SettingsGroup uses, so it is the group shape with
               the list semantics kept. */
            <ul
              aria-label="People who can see your location"
              className="divide-y divide-border/60 overflow-hidden rounded-[var(--app-card-radius-standard,24px)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]"
            >
              {selectedReady.map((recipient) => (
                <li
                  key={recipient.userId}
                  className="flex min-h-[56px] items-center gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]"
                >
                  <Avatar
                    initials={initialsFrom(vm.recipientLabel(recipient))}
                  />
                  <RowLabel as="span" className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                    {vm.recipientLabel(recipient)}
                  </RowLabel>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Nobody chosen yet"
              description="Tap Edit to choose people."
            />
          )}
        </section>

        <SectionCard>
          <div className="space-y-5">
            {/* The absolute end time is the part people actually reason
                about; "4 hours" makes them do the arithmetic themselves. It
                rides on the label's own line rather than a line of its own
                under the control — together they read as one statement. */}
            <DurationSelector
              value={vm.shareDurationHours}
              onChange={vm.setShareDurationHours}
              // The column above is already measured, so the control fills the
              // card instead of stopping 108px short of the note field beside it.
              maxWidthClassName={null}
              label="How long"
              hint={shareEndsAtLabel(vm.shareDurationHours, nowMs)}
              presentation="ladder"
              untilStopValue="until_stopped"
            />
            {/* space-y-2.5 matches DurationSelector's own label→control gap
                above. The two label/field pairs sit in the same card, so an
                8px gap under one and 10px under the other reads as a
                mistake. */}
            <div className="space-y-2.5">
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
                  className="block w-full rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-compact)] px-3 pb-8 pt-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)] aria-invalid:border-destructive aria-invalid:focus:ring-destructive/30"
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
                  Note is too long
                </p>
              ) : null}
            </div>
          </div>
        </SectionCard>

        {/* No "Location type" row. It read back whichever option was picked,
            which made the consent step the most convincing part of a promise
            nothing kept — see the note above ShareFlow. */}
        <TrustNoteCard
          description={
            vm.shareDurationHours === "until_stopped"
              ? "Encrypted. Stop anytime."
              : "Encrypted. Ends automatically."
          }
        />

        <div className="space-y-2.5">
          <Button
            onClick={vm.onConfirmShare}
            disabled={!vm.canShare || shareNoteLimitExceeded}
            isLoading={vm.busy === "share"}
            data-voice-control-id="one-location-confirm-share"
            className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
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

  // step === "person"
  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Step 1 of 2 · Choose people"
        title="Who can see you?"
        description="Only people set up to receive it."
      />
      {vm.circles.length ? (
        <SettingsGroup title="Circles" separatorInset>
          {vm.circles.map((circle) => {
            const selected =
              vm.selectedShareCircleSelection?.circle.id === circle.id &&
              shareCircleFullySelected;
            const circleRole = roleClasses("people");
            return (
              <SettingsRow
                key={circle.id}
                density="compact"
                disabled={vm.busy === `shareCircle:${circle.id}`}
                onClick={() => void vm.onSelectShareCircle(circle.id)}
                ariaPressed={selected}
                ariaLabel={`${selected ? "Deselect" : "Select"} the ${circle.name} Circle`}
                leading={
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                      circleRole.tile,
                      circleRole.glyph,
                    )}
                  >
                    <UsersRound className="h-[18px] w-[18px]" />
                  </span>
                }
                title={circle.name}
                description={
                  vm.busy === `shareCircle:${circle.id}`
                    ? "Loading…"
                    : selected
                      ? `${selectedReady.length} ready now`
                      : `${circle.memberCount} ${
                          circle.memberCount === 1 ? "member" : "members"
                        }`
                }
                trailing={<SelectionDot selected={selected} />}
              />
            );
          })}
          {vm.selectedShareCircleSelection && shareCircleFullySelected ? (
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
        </SettingsGroup>
      ) : null}
      <PersonSearchInput
        value={vm.shareRecipientSearch}
        onChange={vm.setShareRecipientSearch}
        voiceControlId="one-location-share-recipient-search"
      />
      {filtered.length ? (
        // ONE scroll region around BOTH groups, not one per group. The list had
        // a 340px budget and a single scrolling surface; two capped groups
        // would have stacked into 680px of nested scrollers and pushed
        // "Continue" off a small iPhone. Same budget, same one surface, and the
        // headings scroll with the rows they head.
        <div className={PEOPLE_LIST_SCROLL_CLASS}>
          {/* People who can already see you come FIRST and in their own group.
              Sorting them to the top of one list would have been enough to find
              them; it would not have said why they were at the top. The heading
              is the sentence, so each row needs only its remaining time. */}
          {alreadySharing.length ? (
            <SettingsGroup
              title={`Already sharing (${alreadySharing.length})`}
              testId="one-location-share-already-sharing"
              separatorInset
            >
              {alreadySharing.map((r) =>
                renderShareRecipientRow(r, activeGrantByRecipientId.get(r.userId)),
              )}
            </SettingsGroup>
          ) : null}
          {notSharing.length ? (
            <SettingsGroup
              title="People"
              testId="one-location-share-people"
              separatorInset
            >
              {notSharing.map((r) => renderShareRecipientRow(r, undefined))}
            </SettingsGroup>
          ) : null}
        </div>
      ) : vm.shareRecipientSearch.trim() ? (
        // A typo used to be reported as "you have no contacts", which sends a
        // person with twenty of them off to invite people they already have.
        // The list being empty and the QUERY being empty are different facts.
        <EmptyState title="No matching people" description="Try a different name." />
      ) : (
        <EmptyState
          title="No trusted people yet"
          description="Invite someone first."
        />
      )}
      {/* A plain step change. Advancing must not depend on device permission:
          the confirm step stays reachable when sharing is blocked so the reason
          is visible on a disabled "Start sharing" rather than a button that
          silently does nothing here. */}
      <Button
        onClick={() => setStep("details")}
        disabled={!selectedReady.length}
        className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
      >
        Continue
      </Button>
    </div>
  );
}

/**
 * The new-end-time editor that opens under the live share card.
 *
 * Inline rather than a sheet: the card it edits stays on screen above it, so
 * "27:03 left" and the time being picked are readable together, and there is
 * no overlay to trap focus in or size against a fresh set of widths.
 *
 * The wheel, not the four-option select the received-shares editor uses. This
 * one opens on what the share actually has left, and 32 minutes snapped to
 * "1 hour" would silently offer to double a share the person meant to trim.
 */
function LiveShareDurationEditor({
  value,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  // Same 30-second tick as the share confirm step: an editor left open must
  // not keep quoting an end time that has already gone past.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div
      className={cn(SUBCARD_SURFACE, "space-y-4 p-4")}
      data-testid="one-location-live-share-duration-editor"
      data-ui-contract="control-group"
      data-ui-id="location-live-share-duration-editor"
    >
      <DurationSelector
        value={value}
        onChange={onChange}
        presentation="wheel"
        untilStopValue="until_stopped"
        label="New time"
      />
      <p className={MUTED_TEXT} aria-live="polite">
        {shareEndsAtLabel(value, nowMs)}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          className="h-11 rounded-full"
          onClick={onCancel}
          data-testid="one-location-live-share-duration-cancel"
        >
          Cancel
        </Button>
        <Button
          className="h-11 rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          onClick={onSave}
          isLoading={saving}
          data-testid="one-location-live-share-duration-save"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
/**
 * "Ends 4:35 PM" — the read-back under a duration picker.
 *
 * A duration is a promise about a moment, and "4 hours" makes the reader do the
 * arithmetic. Stating the clock time is what lets someone notice that a share
 * they meant to end before a meeting actually runs past it. Over 12 hours the
 * weekday is included, because "8:00 AM" alone is ambiguous by then.
 *
 * It shares a line with the "How long" label now, so it is a fragment rather
 * than a sentence: "Sharing ends at 4:35 PM." repeated the word already in the
 * label and would not fit beside it at 320px.
 *
 * There is no "today" branch. `Number("today")` is NaN, so the picker resolves
 * that token to 15 minutes and writes "0.25" back over it the moment it
 * renders — the branch was unreachable, and the token is gone from every list.
 */
function shareEndsAtLabel(durationHours: string, nowMs: number): string {
  if (durationHours === "until_stopped") {
    return "Until you stop";
  }
  const hours = Number(durationHours);
  // Not defensive filler: a token that is neither a number nor the open-ended
  // sentinel has no honest end time, and inventing one is worse than saying
  // nothing. Add a branch here in the same commit as any new sentinel.
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const endsAt = new Date(nowMs + Math.round(hours * 60) * 60_000);
  const time = endsAt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (hours >= 12) {
    const day = endsAt.toLocaleDateString(undefined, { weekday: "short" });
    return `Ends ${time} ${day}`;
  }
  return `Ends ${time}`;
}

/**
 * The trailing selector on a choose-people row.
 *
 * The rows used to end in the word "Select" / "Selected", which is a button
 * label doing a checkbox's job: it states the action on an unselected row and
 * the state on a selected one, so the column never means one thing. A dot is
 * the same affordance the rest of the app uses for a multi-select list, and it
 * reads down the column at a glance.
 *
 * Not colour-only: the ring thickens and fills, and the row still carries
 * aria-pressed for anything that cannot see either.
 */
function SelectionDot({ selected }: { selected: boolean }) {
  const role = roleClasses(selected ? "action" : "neutral");
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected
          ? cn(role.border, "bg-[color:var(--app-accent)]")
          : "border-border/70",
      )}
    >
      {selected ? (
        <Check className="h-3 w-3 text-[color:var(--app-accent-fg)]" strokeWidth={3} />
      ) : null}
    </span>
  );
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
  // Keep the person on this screen after sending so the confirmation is tied to
  // the specific request they just made, rather than popping straight back to
  // the hub.
  //
  // `justSent` is a confirmation, NOT a one-shot lock. It used to latch true
  // forever the moment the button was tapped, which meant (a) a failed send
  // still said "Request sent." and (b) after one round the button stayed
  // disabled, so somebody who asked three people could not then ask the rest
  // without leaving the screen and coming back. Now it is set from the resolved
  // result, and choosing the next person clears it and re-arms Send.
  const [justSent, setJustSent] = useState(false);
  // Who the last send was for. Anyone selected who is NOT in it is a person
  // being lined up for a new ask, which is what retires the confirmation and
  // re-arms Send.
  //
  // Compared as a set rather than counted: sending subtracts only the people it
  // actually asked, so a person tapped mid-send survives into a non-empty
  // selection, and a count would read that leftover as "nothing new here".
  const sentSelectionRef = useRef<readonly string[]>([]);
  const selectedRequestOwnerIds = vm.selectedRequestOwnerIds;
  useEffect(() => {
    const hasNewPick = selectedRequestOwnerIds.some(
      (id) => !sentSelectionRef.current.includes(id),
    );
    if (hasNewPick) setJustSent(false);
  }, [selectedRequestOwnerIds]);
  // Guards a double-tap inside the same frame, where `vm.busy` has not yet
  // re-rendered the button as disabled.
  const sendInFlightRef = useRef(false);
  // "Asked 6m ago" is only true at the moment it renders. Without a clock the
  // list freezes at whatever it said when the screen opened, which is how a
  // request sent half an hour ago still reads as just now.
  //
  // Coarse on purpose: these labels move in minutes, so a 30s tick keeps them
  // honest without re-rendering a list of people every second.
  const [statusNowMs, setStatusNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setStatusNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // A grant accepted between ticks would otherwise be measured against a
  // `statusNowMs` from before it existed, inflating "Sharing with you, X
  // more" by up to a tick's worth of staleness -- enough to round a whole
  // hour up to "1h 1m more". Resyncing the instant new data lands keeps the
  // remaining-time math honest from the very first render of a fresh grant.
  useEffect(() => {
    setStatusNowMs(Date.now());
  }, [vm.receivedGrants, vm.requestedByMe]);
  return (
    <div className="space-y-5">
      <TaskFlowHeader
        eyebrow="Location"
        title="Request location"
        description="Ask someone to share their location with you."
      />

      {justSent ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-2xl border border-[color:var(--app-success)]/30 bg-[color:var(--app-success)]/10 px-3.5 py-3"
        >
          <ShieldCheck className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[color:var(--app-success)]" />
          <p className="text-sm font-medium text-foreground">
            Request sent.
          </p>
        </div>
      ) : null}


      <section className="space-y-3">
        <AppSectionLabel as="h2">People</AppSectionLabel>
        <PersonSearchInput
          value={vm.recipientSearch}
          onChange={vm.setRecipientSearch}
        />
        {filtered.length ? (
          <div className={cn("mt-3", PEOPLE_LIST_SCROLL_CLASS)}>
            {filtered.map((r) => {
              const selected = vm.selectedRequestOwnerIds.includes(r.userId);
              // Every row used to read "Ready for private sharing" with Select
              // as the only affordance, whoever the person was and whatever had
              // already happened with them -- so there was no active status to
              // read, and somebody who had just asked came back to a row
              // offering to ask again.
              const status = requestRecipientStatus({
                recipientUserId: r.userId,
                requestedByMe: vm.requestedByMe,
                receivedGrants: vm.receivedGrants,
                nowMs: statusNowMs,
              });
              // A row already Live is the one place this list had no way off
              // it: the person keeps showing up "already sharing" with
              // nothing to do about that but wait it out or leave the screen
              // entirely to find the Shared with me / Requests sent list
              // that could end or shorten it.
              const activeGrant = vm.receivedGrants.find(
                (grant) =>
                  grant.ownerUserId === r.userId && grant.status === "active",
              );
              const isEditingThis =
                Boolean(activeGrant) && vm.editingGrantId === activeGrant?.id;
              // The unanswered ask this row is reporting, if any. The row used
              // to be a dead end when it had one: nothing to press, and no way
              // to take the ask back.
              const pendingRequestId = status.pendingRequestId;
              const recipientLabel = vm.recipientLabel(r);
              // The wall-clock moment a live share ends, next to the name --
              // "29 more min" says how long is left but not when that runs
              // out, so leaving the screen for a while loses the one number
              // that would have told them.
              const activeGrantExpiresAtMs = activeGrant
                ? locationTimestampMs(activeGrant.expiresAt)
                : null;
              const nameSuffix =
                activeGrant &&
                activeGrantExpiresAtMs !== null &&
                activeGrantExpiresAtMs > statusNowMs
                  ? `till ${formatShareEndsAt(activeGrantExpiresAtMs)}`
                  : undefined;
              return (
                <TrustedPersonCard
                  key={r.userId}
                  name={recipientLabel}
                  nameSuffix={nameSuffix}
                  subtitle={status.subtitle}
                  tone={status.tone}
                  statusLabel={status.statusLabel}
                  actionLabel={
                    status.selectable
                      ? selected
                        ? "Selected"
                        : "Select"
                      : undefined
                  }
                  actionAriaLabel={`${
                    selected ? "Deselect" : "Select"
                  } ${recipientLabel} for location request`}
                  onAction={
                    status.selectable
                      ? () => vm.toggleRequestOwner(r.userId, "ask_flow")
                      : undefined
                  }
                  selected={selected && status.selectable}
                  onEdit={
                    activeGrant
                      ? () =>
                          isEditingThis
                            ? vm.onEditGrantCancel()
                            : vm.onEditGrantStart(activeGrant.id)
                      : undefined
                  }
                  editActive={isEditingThis}
                  // Two different acts share this one control, because the row
                  // is only ever in one of the two states: a live share ends
                  // access, an unanswered ask ends the ask. A row that is
                  // neither keeps no X at all.
                  onRemove={
                    activeGrant
                      ? () => vm.onStopGrant(activeGrant.id)
                      : pendingRequestId
                        ? () => vm.onWithdrawRequest(pendingRequestId)
                        : undefined
                  }
                  removeAriaLabel={
                    !activeGrant && pendingRequestId
                      ? `Take back your request to ${recipientLabel}`
                      : undefined
                  }
                  removeBusy={
                    activeGrant
                      ? vm.revokingGrantId === activeGrant.id
                      : vm.withdrawingRequestId === pendingRequestId
                  }
                  expandedContent={
                    isEditingThis && activeGrant ? (
                      <>
                        <DurationSelector
                          value={vm.editGrantDurationHours}
                          onChange={vm.setEditGrantDurationHours}
                          label="New duration"
                          presentation="select"
                        />
                        <Button
                          size="sm"
                          className="h-9 w-full rounded-full bg-[color:var(--app-accent)] text-sm text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
                          onClick={() =>
                            vm.onEditGrantSave({
                              ownerUserId: r.userId,
                              grantId: activeGrant.id,
                              ownerLabel: recipientLabel,
                            })
                          }
                          isLoading={vm.savingGrantId === activeGrant.id}
                        >
                          Save
                        </Button>
                      </>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className="mt-3">
            {vm.recipientSearch.trim() ? (
              <EmptyState
                title="No matching people"
                description="Try a different name."
              />
            ) : (
              <EmptyState
                title="No one to request from yet"
                description="Invite someone first."
              />
            )}
          </div>
        )}
      </section>

      {/* Ask and Share are the same decision pointed in opposite directions,
          so they are now the same card: one surface, "How long" over the
          ladder, then the next field. Ask used to put its duration in a
          SettingsRow trailing slot as a two-column scroll wheel — a control
          that needs 260px pinned to the right edge of a row, overlapping the
          row it sat in and looking nothing like the screen people reach it
          from.

          Message keeps its own labelled block below: a two-row textarea is not
          a row control. */}
      <SectionCard>
        <div className="space-y-5">
          <DurationSelector
            value={vm.durationHours}
            onChange={vm.setDurationHours}
            // The column is already measured by the card, so the ladder fills
            // it instead of stopping short.
            maxWidthClassName={null}
            label="How long"
            presentation="ladder"
            /* No open-ended option on this lane. There is no such thing as
               asking to see someone else's location until THEY stop — the
               backend has no open-ended mode on a request — and this screen
               writes the same `durationHours` string the circle-invite and
               public-link lanes later run Number() over, so a non-numeric
               sentinel here posts NaN to a `gt=0` field. */
            allowUntilStop={false}
          />
          <ReasonChips
            value={reason}
            onChange={setReason}
            label="Reason"
            presentation="select"
          />
        </div>
      </SectionCard>

      <section className="space-y-3">
        <AppSectionLabel as="h2">Message</AppSectionLabel>
        <textarea
          value={vm.requestMessage}
          onChange={(e) => vm.setRequestMessage(e.target.value)}
          rows={2}
          placeholder="Hey, can you share your location until we meet?"
          /* bg-background is the light canvas colour, so on this screen the
             field disappeared into the page exactly as the search input did.
             Same surface as the group above it, in both themes. */
          className="w-full rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
        />
      </section>

      {/* Send is enabled once at least one recipient is chosen. Duration and
          reason default to sensible values, so gating Send on them too (added
          in #5108) blocked submitting even when the request was already valid;
          that extra gating is intentionally removed here.

          The button keeps the action accent in every state. Success is a status,
          and it is already said twice — by the banner above and by each person's
          row turning to "Asked" — so recolouring the primary action green said it
          a third time and cost the screen its one action colour. */}
      {(() => {
        const isFormValid = vm.selectedRequestOwnerIds.length > 0;
        const sending = vm.busy === "request";
        return (
          <Button
            onClick={() => {
              // Never submit an incomplete form even if the click somehow
              // reaches the handler (e.g. keyboard/AT), and never double-fire.
              if (!isFormValid || sending || sendInFlightRef.current) return;
              sendInFlightRef.current = true;
              sentSelectionRef.current = vm.selectedRequestOwnerIds;
              void (async () => {
                try {
                  // Confirm only what actually happened: the banner appears on a
                  // resolved success, and a failure leaves the composer intact
                  // with its own error toast.
                  setJustSent(await vm.onSendRequest(reason));
                } finally {
                  sendInFlightRef.current = false;
                }
              })();
            }}
            disabled={!isFormValid || sending}
            aria-disabled={!isFormValid || sending}
            isLoading={sending}
            className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:pointer-events-none disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
          >
            Send request
          </Button>
        );
      })()}

      {justSent ? (
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-11 w-full rounded-2xl text-sm"
        >
          Done
        </Button>
      ) : null}
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
          description="They approve first."
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
        description="Invite before sharing."
      />
      <SettingsGroup
        title="Invite"
        description="They sign in, verify phone, and approve."
        separatorInset
      >
        <SettingsRow
          title="Expires after"
          description="How long the link stays usable."
          stackTrailingOnMobile
          trailing={
            <DurationSelector
          value={vm.durationHours}
          onChange={vm.setDurationHours}
          label=""
          // 24 hours is the ceiling, not a preference. The API rejects
          // anything above it (`duration_hours … le=24` on
          // CreateCircleInviteRequest) and `normalize_duration_hours` raises
          // "between 15 minutes and 24 hours", so the "7 days" option that
          // used to sit here could only ever return HTTP 422 — an invite the
          // owner watched fail with no idea why.
          options={[
                { value: "1", label: "1 hour" },
                { value: "24", label: "24 hours" },
              ]}
            />
          }
        />
      </SettingsGroup>
      <TrustNoteCard
        title="No location shared"
        description="They approve first."
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
          title="Anyone with the link can view you."
          description="The link stops on its own."
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
      {/* The eyebrow, title and description all used to say "outside your
          Circle", then the warning said "until it expires" and the trust note
          said it a third time. The consent point is load-bearing here, so it is
          stated ONCE, in the warning, where it carries the most weight. */}
      <TaskFlowHeader title="Share outside your Circle" />
      <WarningCard
        title="Anyone with this link can see you"
        description="The link stops on its own."
      />
      <SettingsGroup title="Duration" separatorInset>
        <SettingsRow
          title="Link stays live for"
          description="Anyone holding it can watch until then."
          stackTrailingOnMobile
          trailing={
            <DurationSelector
              value={vm.durationHours}
              onChange={vm.setDurationHours}
              label=""
              // Deliberately shorter than the trusted-share durations: anyone
              // holding this link can watch, so the public ceiling stays at
              // 1 hour.
              options={[
                { value: "0.5", label: "30 min" },
                { value: "1", label: "1 hour" },
              ]}
            />
          }
        />
      </SettingsGroup>
      {/* The temporary link shares the same precise point as everything else,
          so it offers no precision card either. The "expires automatically"
          note that sat here was the third statement of the same fact — the
          warning above and the duration control already carry it. */}
      {/* The label changes while it works. This press waits on a device fix
          before it can post anything, so on a cold start it can sit for
          several seconds — and it used to sit as a bare spinner with the label
          hidden, which is why it read as "taking longer than expected" rather
          than as "still finding you". Naming the wait is the fix available
          here; the wait itself is a GPS acquisition. */}
      <Button
        onClick={vm.onCreatePublicInvite}
        isLoading={vm.busy === "publicInvite"}
        className="h-12 min-h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-base font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
      >
        {vm.busy === "publicInvite" ? "Creating link…" : "Create link"}
      </Button>
    </div>
  );
}

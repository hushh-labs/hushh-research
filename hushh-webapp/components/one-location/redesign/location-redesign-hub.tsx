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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Send,
  Check,
  ShieldCheck,
  UserRoundPlus,
  UsersRound,
  ChevronRight,
  X,
} from "lucide-react";

import {
  requestRecipientStatus,
  shortAgo,
  type RequestRecipientStatus,
} from "@/lib/one-location/request-recipient-status";
import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import {
  formatLocationDurationLabel,
  locationApproveActionLabel,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import {
  grantLaneLabel,
  groupGrantsByCounterpart,
  type OneLocationGrantLaneGroup,
} from "@/lib/one-location/grant-lanes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";

import {
  Avatar,
  EmptyState,
  SectionCard,
  StatusPill,
  TaskFlowHeader,
  TrustNoteCard,
} from "./primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import {
  initialsFrom,
  RequestCard,
  SharedWithMeCard,
  TemporaryLinkCard,
  type GrantViewStatus,
} from "./cards";

export type { GrantViewStatus } from "./cards";
import {
  PersonShareLanes,
  ShareLanesDisclosure,
  useExpandedShareLanes,
} from "./share-lanes";
// LocationTypeSelector stays exported from ./selectors, unused for now, so
// PR #4767 can wire it back to a real precision mode without rebuilding it.
import {
  DurationSelector,
  PersonSearchInput,
  ReasonChips,
  type ReasonValue,
} from "./selectors";
import { REQUEST_DURATION_LADDER } from "./duration-presets";
import {
  LiveShareStatusCard,
  ShareCountdownText,
  type LiveShareStatus,
} from "@/components/one-location/redesign/live-share-status-card";
import { SosPanel } from "@/components/one-location/redesign/sos-panel";
import { SmsContactsFlow } from "@/components/one-location/redesign/sms-contacts-flow";
import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { SavedLocationsSection } from "@/components/one-location/saved-locations-section";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import { ContactAvatar } from "@/components/one-location/redesign/contact-picker/atoms";
import {
  flattenRecipientSections,
  lastInteractionByUserId,
  sectionRecipients,
} from "@/lib/one-location/recipient-sections";
import { ROUTES } from "@/lib/navigation/routes";
import { circleMemberCountLabel } from "@/lib/one-location/circle-member-count";
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

type ReadinessTone = "ready" | "warning" | "blocked" | "checking";

export const ONE_LOCATION_SHARE_DEFAULT_DURATION_HOURS = "0.25";
const ONE_LOCATION_REQUEST_REASON_MAX_LENGTH = 80;

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
  autoApproveScope: AutoApproveScope | null;
  /**
   * Whether this person appears as a pin on the maps of people they already
   * share with. Opt-in, and separate from sharing itself: sharing sends a
   * position to one person, this decides whether it becomes a pin they can
   * watch move. Null while the preference is still loading.
   */
  mapPresenceEnabled: boolean | null;
  onMapPresenceChange: (next: boolean) => void;
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
  /**
   * The public link's own duration, kept apart from `durationHours`.
   *
   * That one string is written by the Ask composer and the Circle invite screen
   * and read by all three lanes. The public-link control now sits permanently
   * on the Links tab rather than behind a button, so sharing the string would
   * mean anyone browsing past the tab rewrites what the other two screens
   * offer.
   */
  publicLinkDurationHours: string;
  setPublicLinkDurationHours: (value: string) => void;
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
  onAutoApproveRequestsChange: (input: {
    enabled: boolean;
    scope?: AutoApproveScope | null;
  }) => void;
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
  onCopyPublicInvite: () => boolean | Promise<boolean>;
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

  /**
   * Sends a connection request to a co-member of a Circle.
   *
   * Being in the same Circle is not being connected, so this is the explicit
   * ask the roster offers -- answered by the other person, never assumed.
   */
  onConnectCircleMember: (
    circleId: string,
    memberUserId: string,
  ) => Promise<void>;
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
  prepareNamedCircleShare: (
    circleId: string,
    recipientUserId: string,
  ) => Promise<boolean>;
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
  /**
   * Adds a Circle's SMS-ready members. The picker passes the subset it
   * resolved; omitting it keeps the whole-Circle behaviour for callers that
   * still want it.
   */
  onAddSmsCircle: (
    circleId: string,
    memberUserIds?: readonly string[],
  ) => Promise<void>;
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

/**
 * Actions whose screen was folded into a hub tab rather than removed.
 *
 * Different from `RETIRED_ACTIONS` below, and the difference is what the
 * person is told. A retired action is gone and says so. A relocated one still
 * exists -- it is just no longer its own screen -- so it lands on the tab that
 * absorbed it, quietly. "That's no longer there." would be a lie for these,
 * and a confusing one, since the thing they asked for is on the screen they
 * are now looking at.
 *
 * `temp-link` was the create-a-live-location-link screen. Its duration
 * question and its create button are now on the Links tab itself, so every
 * bookmark, history entry and Kai deep link pointing at it resolves there.
 */
const RELOCATED_ACTION_TABS: Readonly<Record<string, LocationHubTab>> = {
  "temp-link": "links",
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

/**
 * The id the header switch points `aria-describedby` at. A constant, not
 * `useId`: the status text now renders under the title while the switch stays
 * in the actions column, and `aria-describedby` resolves by id anywhere in the
 * document. There is exactly one Location header on screen.
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

/** The header switch status sits under the switch without becoming a page subtitle. */
function LocationHeaderStatus({ vm }: { vm: LocationHubViewModel }) {
  return (
    <span
      id={LOCATION_HEADER_STATUS_ID}
      data-testid="one-location-header-status"
      className="mt-1 block w-full whitespace-nowrap text-center font-[family-name:var(--font-app-body)] text-[12px] font-normal leading-4 tracking-[-0.01em] text-[color:var(--app-secondary-label)]"
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
      className="ml-auto flex h-[58px] w-[72px] shrink-0 flex-col items-center justify-center overflow-visible"
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
        className={cn("shrink-0", acquiring && "animate-pulse")}
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
  "space-y-5 overflow-visible md:max-h-[420px] md:space-y-3 md:overflow-y-auto md:overscroll-contain md:pr-1 md:[scrollbar-width:thin] md:[&::-webkit-scrollbar]:w-1.5 md:[&::-webkit-scrollbar-track]:bg-transparent md:[&::-webkit-scrollbar-thumb]:rounded-full md:[&::-webkit-scrollbar-thumb]:bg-black/15 dark:md:[&::-webkit-scrollbar-thumb]:bg-white/20";

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
      // Leaving a tab closes whatever flow was open on it.
      //
      // `?action=` and `?circleId=` used to survive a tab change, and the
      // effect that reads them opens the flow again -- so going Circle detail
      // -> another tab -> back put the person inside the same Circle instead
      // of at the list they were reaching for. `closeFlow` has always cleared
      // these; the tab strip did not.
      // `setFlow` only; the refs are the URL-sync effect's to move, and
      // reaching into them from here makes every other assignment to them a
      // lint error about a value that cannot be modified.
      setFlow("none");
      const params = new URLSearchParams(searchParams.toString());
      params.delete(FLOW_ACTION_PARAM);
      params.delete("circleId");
      params.delete(FLOW_SOURCE_PARAM);
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

  /**
   * `?action=sms-contacts` now opens the SMS Circle, not a screen of its own.
   *
   * Issue #5426 unifies contact management under Circles, and this is the
   * legacy entry point: the hub's own "SMS contacts" tile, the SOS flow's
   * "Edit contacts", voice actions, notifications and anything already shared.
   * Redirecting rather than 404-ing is the difference between "we moved this"
   * and "this is gone".
   *
   * `replace`, so Back leaves Location instead of bouncing off the old param
   * and redirecting again. And it waits for the Circle to exist -- provisioning
   * is a network call, and until it answers the old screen is still a working
   * answer to the same question rather than a dead end.
   */
  const smsSystemCircleId = useMemo(
    () => vm.circles.find((circle) => circle.isSystem)?.id ?? null,
    [vm.circles],
  );
  useEffect(() => {
    if (flow !== "sms-contacts" || !smsSystemCircleId) return;
    openCircleDetail(smsSystemCircleId, "replace");
  }, [flow, openCircleDetail, smsSystemCircleId]);

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
    const relocatedTab = RELOCATED_ACTION_TABS[action];
    if (relocatedTab) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(FLOW_ACTION_PARAM);
      params.set(LOCATION_HUB_TAB_PARAM, relocatedTab);
      // No toast: the screen did not go away, it became this tab, and the
      // person is looking at it.
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      return;
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
    if (
      pendingFlowRef.current !== "none" &&
      desired !== pendingFlowRef.current
    ) {
      return;
    }
    const wasPendingProgrammaticOpen = pendingFlowRef.current === desired;
    pendingFlowRef.current = "none";
    const previousFlow = activeFlowRef.current;
    if (previousFlow === "share" && desired !== "share") {
      resetShareDraft();
    } else if (
      previousFlow !== "share" &&
      desired === "share" &&
      !wasPendingProgrammaticOpen
    ) {
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
        className="space-y-6 pb-6"
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
            onAddCircleMembers={(circleId, userIds) =>
              vm.onAddSmsCircle(circleId, userIds)
            }
            onLoadCircleMembers={(circleId) =>
              vm.onResolveNamedCircleRecipients(circleId, "sms")
            }
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
            onConnectMember={(circleId, memberUserId) =>
              vm.onConnectCircleMember(circleId, memberUserId)
            }
            onShareWithMember={(circleId, recipientUserId) => {
              void (async () => {
                const prepared = await vm.prepareNamedCircleShare(
                  circleId,
                  recipientUserId,
                );
                if (!prepared) return;
                setShareStep("details");
                openFlow("share");
              })();
            }}
            onRemoveMember={vm.onRemoveNamedCircleMember}
            onLoadEligibleConnections={vm.onLoadNamedCircleEligibleConnections}
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
            onRequestLocation={() => openFlow("ask")}
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
        ) : // Every FlowKind above is matched, and `none` never reaches here.
        // This used to fall through to the temporary-link screen, so any
        // flow slug nobody had wired up quietly rendered "Share outside your
        // Circle" instead of failing visibly.
        null}
      </div>
    );
  }

  /* ----------------------------------------------------------------- */
  /* Hub (Now | People | Links)                                        */
  /* ----------------------------------------------------------------- */
  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title={
          <span className="font-[family-name:var(--font-app-display)] text-[34px] font-bold leading-[41px] tracking-[-0.02em]">
            Location
          </span>
        }
        leading={<LocationHeaderIconTile />}
        accent="location"
        titleRole="agent"
        actionsInlineMobile
        actions={<LocationHeaderActions vm={vm} />}
        className="[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center"
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
              onSos={() => openFlow("sos")}
              onOpenActiveShares={() => openFlow("active-shares")}
              onOpenSharedWithMe={() => openFlow("shared-with-me")}
              onOpenNeedsReview={() => openFlow("needs-review")}
              onRequestLocation={() => openFlow("ask")}
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
            <LinksHub vm={vm} />
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
  "overflow-hidden rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] shadow-[var(--app-card-shadow-standard)]";

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
  onSos,
  onOpenActiveShares,
  onOpenSharedWithMe,
  onOpenNeedsReview,
  onRequestLocation,
}: {
  vm: LocationHubViewModel;
  onStartShare: () => void;
  onCheckIn: () => void;
  onSos: () => void;
  onOpenActiveShares: () => void;
  onOpenSharedWithMe: () => void;
  onOpenNeedsReview: () => void;
  onRequestLocation: () => void;
}) {
  const activityRows = [
    {
      leading: <LocationMenuListIcon name="pin" />,
      title: "Sharing with you",
      value: vm.receivedGrants.length,
      ariaLabel: "Sharing with you",
      onClick: onOpenSharedWithMe,
      voiceControlId: "one-location-action-shared-with-me",
      voiceActionId: "location.open_shared_with_me",
    },
    {
      leading: <LocationMenuListIcon name="review" />,
      title: "Needs review",
      value: vm.pendingOwnerRequests.length,
      ariaLabel: "Needs review",
      onClick: onOpenNeedsReview,
      voiceControlId: "one-location-action-needs-review",
      voiceActionId: "location.open_needs_review",
    },
  ].filter((row) => row.value > 0);

  return (
    <div className="space-y-3" data-testid="one-location-now-hub">
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
          onShareMore={onStartShare}
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
      {/* Every row and cell below carries the `control_ids` / `action_id` pair
          it was authored with in the Location voice action contract, so One and
          the search bar can name the individual control a person is asking for
          rather than only the screen it lives on. */}
      {!vm.liveShare ? (
        <LocationPrimaryShareCard onClick={onStartShare} />
      ) : null}
      <LocationActionGrid
        items={[
          {
            title: "Ask for location",
            ariaLabel: "Request location",
            icon: <LocationMenuGlyph name="ask" size={34} />,
            tone: "blue",
            onClick: onRequestLocation,
            controlId: "one-location-action-ask",
            actionId: "location.open_ask",
            testId: "one-location-request-row",
          },
          {
            title: "Check in",
            ariaLabel: "Check in",
            icon: <LocationMenuGlyph name="checkIn" size={34} />,
            tone: "blue",
            onClick: onCheckIn,
            controlId: "one-location-action-check-in",
            actionId: "location.open_check_in",
          },
          {
            title: "Save My Soul",
            subtitle: "Emergency alert",
            ariaLabel: "Save My Soul emergency alert",
            icon: (
              <span className="text-[10px] font-semibold leading-none">
                SMS
              </span>
            ),
            tone: "red",
            onClick: onSos,
            controlId: "one-location-action-sos",
            actionId: "location.open_sos",
          },
        ]}
      />

      {activityRows.length ? (
        <div className="pt-1">
          <LocationMenuListGroup testId="one-location-now-activity">
            {activityRows.map((row) => (
              <LocationMenuListRow
                key={row.voiceControlId}
                leading={row.leading}
                title={row.title}
                trailingValue={row.value}
                ariaLabel={row.ariaLabel}
                onClick={row.onClick}
                voiceControlId={row.voiceControlId}
                voiceActionId={row.voiceActionId}
              />
            ))}
          </LocationMenuListGroup>
        </div>
      ) : null}
    </div>
  );
}

function LocationMenuListGroup({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      data-ui-role="grouped-card"
      data-testid={testId}
      className="overflow-hidden rounded-[16px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.045),0_6px_16px_rgba(0,0,0,0.035)] ring-1 ring-inset ring-black/[0.035] dark:bg-[#1c1c1e] dark:ring-white/10"
    >
      {children}
    </div>
  );
}

function LocationMenuListRow({
  leading,
  title,
  trailingValue,
  ariaLabel,
  onClick,
  testId,
  voiceControlId,
  voiceActionId,
}: {
  leading: ReactNode;
  title: string;
  trailingValue?: number;
  ariaLabel: string;
  onClick: () => void;
  testId?: string;
  voiceControlId: string;
  voiceActionId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-voice-control-id={voiceControlId}
      data-voice-action-id={voiceActionId}
      data-voice-label={ariaLabel}
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex min-h-14 w-full cursor-pointer items-center justify-between border-b border-[#e5e5ea]/80 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)] dark:border-white/10 dark:hover:bg-white/5"
    >
      <span className="flex min-w-0 items-center gap-3">
        {leading}
        <span className="min-w-0 text-[17px] font-normal leading-[22px] tracking-[-0.01em] text-[#1a1b1f] dark:text-[#f5f5f7]">
          {title}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {typeof trailingValue === "number" ? (
          <span className="min-w-4 text-right text-[16px] font-normal leading-[21px] tracking-[-0.01em] text-[#8e8e93]">
            {trailingValue}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-[#c7c7cc] transition-transform group-active:translate-x-0.5"
        />
      </span>
    </button>
  );
}

function LocationPrimaryShareCard({ onClick }: { onClick: () => void }) {
  return (
    <section aria-label="Share location" data-testid="one-location-now-primary">
      <div
        data-testid="one-location-share-row"
        className="grid w-full gap-4 rounded-[20px] bg-white px-5 py-5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.02),0_5px_16px_rgba(0,0,0,0.025)] ring-1 ring-inset ring-black/[0.025] dark:bg-[#1c1c1e] dark:ring-white/10 sm:grid-cols-[auto_minmax(0,1fr)_216px] sm:items-center sm:gap-6 sm:px-6 sm:py-6"
      >
        <div className="flex min-w-0 items-center gap-4">
          <LocationSharePulseIcon />
          <span className="min-w-0 space-y-1">
            <span className="block text-[20px] font-semibold leading-[25px] tracking-[-0.015em] text-[#1a1b1f] dark:text-[#f5f5f7]">
              You&apos;re not sharing
            </span>
            <span className="block text-[15px] font-normal leading-5 tracking-[-0.01em] text-[#8e8e93]">
              Choose a Circle or contact.
            </span>
          </span>
        </div>
        <button
          type="button"
          data-voice-control-id="one-location-action-share"
          data-voice-action-id="location.open_share"
          data-voice-label="Share location"
          aria-label="Share location"
          onClick={onClick}
          className="inline-flex min-h-[52px] w-full items-center justify-center rounded-[16px] bg-[color:var(--app-accent)] px-5 font-[family-name:var(--font-app-body)] text-[17px] font-semibold leading-[22px] tracking-[-0.02em] text-white transition-[background-color,transform] [-webkit-tap-highlight-color:transparent] hover:bg-[color:var(--app-accent)]/90 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:col-start-3"
        >
          Share location
        </button>
      </div>
    </section>
  );
}

function LocationHeaderIconTile() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
      data-testid="one-location-header-icon"
    >
      <MapPin className="h-6 w-6" strokeWidth={2} />
    </span>
  );
}

function LocationSharePulseIcon() {
  return (
    <span
      aria-hidden="true"
      data-location-share-pulse-icon=""
      className="relative inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#eff6ff] shadow-[inset_0_0_0_1px_rgba(0,122,255,0.025)] sm:h-16 sm:w-16"
    >
      <span className="absolute inset-[13%] rounded-full bg-[#dcecff]" />
      <span className="absolute inset-[28%] rounded-full bg-[#b9d7ff]" />
      <span className="relative h-[25%] w-[25%] rounded-full bg-[color:var(--app-accent)] shadow-[0_0_0_4px_#ffffff,0_8px_16px_rgba(0,122,255,0.22)] dark:shadow-[0_0_0_4px_#1c1c1e,0_8px_16px_rgba(0,122,255,0.28)]" />
    </span>
  );
}

type LocationActionGridItem = {
  title: string;
  subtitle?: string;
  ariaLabel: string;
  icon: ReactNode;
  tone: "blue" | "red";
  onClick: () => void;
  controlId: string;
  actionId: string;
  testId?: string;
};

function LocationActionGrid({ items }: { items: LocationActionGridItem[] }) {
  const regularItems = items.filter((item) => item.tone !== "red");
  const emergencyItem = items.find((item) => item.tone === "red");

  return (
    <section
      aria-label="Actions"
      className="pt-1"
      data-testid="one-location-now-actions"
    >
      <div
        data-one-location-action-grid=""
        className="grid w-full grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4"
      >
        {regularItems.map((item) => (
          <button
            key={item.controlId}
            type="button"
            data-testid={item.testId}
            data-one-location-action-cell=""
            data-voice-control-id={item.controlId}
            data-voice-action-id={item.actionId}
            data-voice-label={item.ariaLabel}
            aria-label={item.ariaLabel}
            onClick={item.onClick}
            className={cn(
              "group flex min-h-[100px] min-w-0 flex-col items-center justify-center gap-3 rounded-[16px] bg-white px-5 py-4 text-center shadow-[0_1px_2px_rgba(0,0,0,0.018),0_2px_7px_rgba(0,0,0,0.018)] ring-1 ring-inset ring-black/[0.025] transition-[background-color,transform] [-webkit-tap-highlight-color:transparent] hover:bg-gray-50 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)] dark:bg-[#1c1c1e] dark:hover:bg-white/5 dark:ring-white/10",
            )}
          >
            <span
              aria-hidden
              data-one-location-action-icon=""
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[color:var(--app-accent)] transition-transform group-active:scale-95 [&>svg]:h-8 [&>svg]:w-8"
            >
              {item.icon}
            </span>
            <span className="min-w-0">
              <span className="block min-w-0 text-[17px] font-semibold leading-[22px] tracking-[-0.015em] text-[#1a1b1f] dark:text-[#f5f5f7]">
                {item.title}
              </span>
            </span>
          </button>
        ))}
      </div>
      {emergencyItem ? (
        <button
          key={emergencyItem.controlId}
          type="button"
          data-testid={emergencyItem.testId}
          data-one-location-sms-row=""
          data-one-location-emergency-cell=""
          data-voice-control-id={emergencyItem.controlId}
          data-voice-action-id={emergencyItem.actionId}
          data-voice-label={emergencyItem.ariaLabel}
          aria-label={emergencyItem.ariaLabel}
          onClick={emergencyItem.onClick}
          className="group mt-3 flex min-h-[68px] w-full items-center justify-between gap-4 rounded-[16px] bg-[#fff7f7] px-5 py-3 text-left ring-1 ring-inset ring-[#ff3b30]/16 transition-[background-color,transform] [-webkit-tap-highlight-color:transparent] hover:bg-[#fff3f3] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff3b30]/40 dark:bg-[#2a1f1f] dark:ring-[#ff3b30]/20 dark:hover:bg-[#302121]"
        >
          <span className="flex min-w-0 items-center gap-4">
            <span
              aria-hidden
              data-one-location-action-icon=""
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ff3b30] text-white transition-transform group-active:scale-95"
            >
              {emergencyItem.icon}
            </span>
            <span className="min-w-0">
              <span className="block min-w-0 text-[17px] font-semibold leading-[22px] tracking-[-0.015em] text-[#1a1b1f] dark:text-[#f5f5f7]">
                {emergencyItem.title}
              </span>
              <span className="mt-0.5 block min-w-0 text-[13px] font-normal leading-[18px] tracking-[-0.01em] text-[#ff3b30]">
                {emergencyItem.subtitle}
              </span>
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-[#ff3b30]/40"
          />
        </button>
      ) : null}
    </section>
  );
}

type LocationMenuGlyphName =
  | "share"
  | "ask"
  | "checkIn"
  | "active"
  | "pin"
  | "review"
  | "map"
  | "settings";

function LocationMenuGlyph({
  name,
  size,
}: {
  name: LocationMenuGlyphName;
  size: number;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      data-location-menu-icon={name}
      className="block"
    >
      {name === "share" ? (
        <path
          d="M20.7 3.3 3.9 10.4c-.8.3-.8 1.4.1 1.6l6.4 1.6 1.6 6.4c.2.9 1.3.9 1.6.1l7.1-16.8Z"
          fill="currentColor"
        />
      ) : null}
      {name === "ask" ? (
        <>
          <path
            d="M9.4 11.6a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8Zm0 2C6.1 13.6 2 15.2 2 18.4V20h10.7a8.1 8.1 0 0 1-.7-3.2c0-1 .2-2 .6-2.9-1.1-.2-2.2-.3-3.2-.3Z"
            fill="currentColor"
          />
          <path
            d="M17.7 11.1c-2.9 0-5.2 2.3-5.2 5.1 0 3.8 5.2 7.8 5.2 7.8s5.2-4 5.2-7.8c0-2.8-2.3-5.1-5.2-5.1Zm0 6.9a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"
            fill="currentColor"
          />
        </>
      ) : null}
      {name === "checkIn" ? (
        <>
          <path
            d="M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7Z"
            fill="currentColor"
          />
          <path
            d="m8.8 9.3 2.1 2.1 4.5-4.7"
            stroke="white"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {name === "active" ? (
        <>
          <path
            d="M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3Zm-8 0c1.7 0 3-1.3 3-3S9.7 5 8 5 5 6.3 5 8s1.3 3 3 3Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Z"
            fill="currentColor"
          />
          <path
            d="M16 13c-.3 0-.7 0-1.1.1 1.2.9 2.1 2 2.1 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z"
            fill="currentColor"
            opacity=".72"
          />
        </>
      ) : null}
      {name === "pin" ? (
        <path
          d="M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5Z"
          fill="currentColor"
        />
      ) : null}
      {name === "review" ? (
        <>
          <path
            d="M12 1 4 4.6v5.4c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V4.6L12 1Z"
            fill="currentColor"
          />
          <path
            d="m8.8 10.7 2.2 2.1 4.3-4.5"
            stroke="white"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {name === "map" ? (
        <path
          d="m20.5 3-.2.1L15 5.2 9 3 3.4 4.9c-.8.3-1.4 1-1.4 1.9V21l7-2.8 6 2.1 5.6-1.9c.8-.3 1.4-1 1.4-1.9V3.9c0-.7-.7-1.1-1.5-.9ZM15 18.3l-6-2.1V5.1l6 2.1v11.1Z"
          fill="currentColor"
        />
      ) : null}
      {name === "settings" ? (
        <path
          d="m19.4 13.5.1-1.5-.1-1.5 2.1-1.6-2-3.5-2.5 1a7.2 7.2 0 0 0-2.6-1.5L14 2h-4l-.4 2.9A7.2 7.2 0 0 0 7 6.4l-2.5-1-2 3.5 2.1 1.6-.1 1.5.1 1.5-2.1 1.6 2 3.5 2.5-1a7.2 7.2 0 0 0 2.6 1.5L10 22h4l.4-2.9a7.2 7.2 0 0 0 2.6-1.5l2.5 1 2-3.5-2.1-1.6ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
}

function LocationMenuListIcon({ name }: { name: LocationMenuGlyphName }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f2f2f7] text-[#6e6e73] dark:bg-white/10 dark:text-[#aeaeb2]"
      data-location-menu-list-icon=""
    >
      <span className="inline-flex h-[18px] w-[18px] items-center justify-center">
        <LocationMenuGlyph name={name} size={18} />
      </span>
    </span>
  );
}

/** Focused detail surfaces replace the former mixed inbox tab. */
function LocationDetailFlow({
  kind,
  vm,
  focusGrantId,
  collapsedGrantIds,
  onRequestLocation,
  onCollapseGrant,
  onExpandGrant,
}: {
  kind: "active-shares" | "shared-with-me" | "needs-review";
  vm: LocationHubViewModel;
  /** Grant id from a notification deep link (?grantId=...) to scroll to and
   * briefly highlight once its card is on screen. */
  focusGrantId?: string | null;
  collapsedGrantIds: Set<string>;
  onRequestLocation?: () => void;
  onCollapseGrant: (grantId: string) => void;
  onExpandGrant: (grant: OneLocationGrant) => void;
}) {
  // One row/card per PERSON, not per grant. A pair can now hold two live
  // grants -- an ordinary share and an SMS (SOS) one -- and rendering a grant
  // list rendered the same person twice, each row offering a Stop that left the
  // other share running.
  const ownerGrantGroups = useMemo(
    () => groupGrantsByCounterpart(vm.activeOwnerGrants, "owner"),
    [vm.activeOwnerGrants],
  );
  const receivedGrantGroups = useMemo(
    () => groupGrantsByCounterpart(vm.receivedGrants, "recipient"),
    [vm.receivedGrants],
  );
  const { expandedLaneUserIds, toggleLaneExpansion } = useExpandedShareLanes();

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
    Record<
      string,
      { key: string; status: "loading" | "done"; text: string | null }
    >
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

  // Deep links from Location notifications (?grantId=... or ?requestId=...)
  // scroll to and briefly ring the matching card once it is on screen.
  // Deliberately NOT keyed on
  // `vm.receivedGrants`: that array gets a new reference on every live poll
  // (LIVE_VIEW_REFRESH_INTERVAL_MS, ~5s), and re-running this per poll tick
  // would re-scroll and re-flash the ring for as long as `grantId` stays in
  // the URL. Instead this fires once per (kind, focusGrantId) and retries
  // briefly on its own if the card isn't in the DOM yet (state still loading).
  useEffect(() => {
    if (
      (kind !== "shared-with-me" && kind !== "needs-review") ||
      !focusGrantId
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const tryHighlight = () => {
      if (cancelled) return;
      const focusAttribute =
        kind === "needs-review" ? "data-request-id" : "data-grant-id";
      const node = document.querySelector(
        `[${focusAttribute}="${focusGrantId}"]`,
      );
      if (!node) {
        if (attempts++ < 20) setTimeout(tryHighlight, 250);
        return;
      }
      const prefersReducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
      node.classList.add(
        "ring-2",
        "ring-[color:var(--app-accent)]",
        "ring-offset-2",
      );
      setTimeout(() => {
        node.classList.remove(
          "ring-2",
          "ring-[color:var(--app-accent)]",
          "ring-offset-2",
        );
      }, 2400);
    };
    tryHighlight();
    return () => {
      cancelled = true;
    };
  }, [kind, focusGrantId]);
  const copy = {
    "active-shares": {
      title: "Active shares",
      description: "People who can see your location.",
    },
    "shared-with-me": {
      title: "Shared with me",
      description: "People sharing their location with you.",
    },
    "needs-review": {
      title: "Needs review",
      description: "Nothing is shared until you approve.",
    },
  }[kind];

  return (
    <div className="space-y-5" data-testid={`one-location-${kind}`}>
      <TaskFlowHeader
        eyebrow={kind === "needs-review" ? undefined : "Location"}
        title={copy.title}
        description={copy.description}
      />
      {kind === "active-shares" ? (
        ownerGrantGroups.length ? (
          <SettingsGroup separatorInset>
            {ownerGrantGroups.map((group) => {
              const name = vm.grantRecipientLabel(group.primaryGrant);
              const expanded = expandedLaneUserIds.has(group.counterpartUserId);
              const lanesId = `one-location-share-lanes-${group.counterpartUserId}`;
              // One share is still one tap. The chevron only appears for a
              // person who genuinely has two, so nothing about the common case
              // grew a step.
              const single =
                group.grants.length === 1 ? group.primaryGrant : null;
              return (
                <SettingsRow
                  key={group.counterpartUserId}
                  leading={<ActiveShareAvatar name={name} />}
                  title={name}
                  description={
                    single ? (
                      <ActiveShareMetadata grant={single} />
                    ) : (
                      <>
                        <span>{`${group.grants.length} active shares`}</span>
                        <div id={lanesId} hidden={!expanded} className="pt-1.5">
                          <PersonShareLanes
                            group={group}
                            counterpartName={name}
                            onStopGrant={vm.onStopGrant}
                            revokingGrantId={vm.revokingGrantId}
                          />
                        </div>
                      </>
                    )
                  }
                  trailing={
                    single ? (
                      <StopGrantTextButton
                        grantId={single.id}
                        revokingGrantId={vm.revokingGrantId}
                        onStopGrant={vm.onStopGrant}
                      />
                    ) : (
                      <ShareLanesDisclosure
                        expanded={expanded}
                        onToggle={() =>
                          toggleLaneExpansion(group.counterpartUserId)
                        }
                        controlsId={lanesId}
                        label={`Manage your shares with ${name}`}
                      />
                    )
                  }
                />
              );
            })}
          </SettingsGroup>
        ) : (
          <EmptyState
            title="No active shares"
            description="No one can see your location."
            action={
              <Button
                type="button"
                size="sm"
                className="rounded-full"
                onClick={() => vm.startShareComposer()}
              >
                Share location
              </Button>
            }
          />
        )
      ) : null}
      {kind === "shared-with-me" ? (
        receivedGrantGroups.length ? (
          <div className="space-y-3">
            {receivedGrantGroups.map((group) => {
              // ONE card per OWNER, never one per grant. That person can now
              // be sharing with you twice at once -- an ordinary share and an
              // SMS (SOS) one -- and rendering the grant list rendered the
              // same name twice, two cards deep, each with its own map and its
              // own countdown and no way to tell which was which.
              //
              // `receivedGrants` is already sorted SMS-first, so the leading
              // grant of a group is the SMS one whenever there is one: the
              // card's map, its "view" affordance and its badge all follow the
              // share that matters most.
              const grant = group.primaryGrant;
              const multiLane = group.grants.length > 1;
              const lanesExpanded = expandedLaneUserIds.has(
                group.counterpartUserId,
              );
              const lanesId = `one-location-received-lanes-${group.counterpartUserId}`;
              const ownerName = vm.grantOwnerLabel(grant);
              const point = vm.decryptedPoints[grant.id];
              const addressEntry = addressByGrant[grant.id];
              const expanded =
                Boolean(point) && !collapsedGrantIds.has(grant.id);
              return (
                <div key={group.counterpartUserId} data-grant-id={grant.id}>
                  <SharedWithMeCard
                    isSmsTriggered={Boolean(group.smsGrant)}
                    name={ownerName}
                    statusLine={
                      multiLane
                        ? `${group.grants.length} live shares`
                        : (
                          <ActiveShareMetadata
                            grant={grant}
                            formatEndsAt={vm.formatDateTime}
                            untilStoppedLabel="Until stopped"
                          />
                        )
                    }
                    shareLanes={
                      multiLane ? (
                        // One control per SHARE. The card's own Remove is a
                        // single button, and with two shares behind one card it
                        // could only ever drop one of them -- silently, since
                        // nothing on screen would say which. `revoke_grant`
                        // accepts the recipient as well as the owner (it records
                        // the difference as `recipient_revoke`), so these are
                        // real controls, not decoration.
                        <div data-testid="one-location-received-share-lanes">
                          <ShareLanesDisclosure
                            expanded={lanesExpanded}
                            onToggle={() =>
                              toggleLaneExpansion(group.counterpartUserId)
                            }
                            controlsId={lanesId}
                            label={`Show the shares ${ownerName} has with you`}
                          />
                          <div id={lanesId} hidden={!lanesExpanded}>
                            <PersonShareLanes
                              group={group}
                              counterpartName={ownerName}
                              formatEndsAt={vm.formatDateTime}
                              action="remove"
                              onStopGrant={vm.onStopGrant}
                              revokingGrantId={vm.revokingGrantId}
                            />
                          </div>
                        </div>
                      ) : null
                    }
                    previewExpanded={expanded}
                    mapHref={point ? vm.mapLocationHref(point) : undefined}
                    onView={() => onExpandGrant(grant)}
                    onDismiss={() => onCollapseGrant(grant.id)}
                    onRecenter={
                      point ? () => recenterGrantViewport(grant.id) : undefined
                    }
                    // Suppressed for a person holding two shares: the card's
                    // single Remove would silently act on only one of them, and
                    // the breakdown above already carries one per share.
                    onRemove={
                      multiLane ? undefined : () => vm.onStopGrant(grant.id)
                    }
                    removeBusy={vm.revokingGrantId === grant.id}
                    viewBusy={vm.busy === "view"}
                    message={
                      point?.checkIn?.message ?? grant.shareMessage ?? undefined
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
                            className="h-8 rounded-full border-[color:var(--app-warning-border)] bg-[color:var(--app-card-surface-default-solid)]/85 px-3 text-[12px] font-semibold text-[color:var(--app-warning)] hover:bg-[color:var(--app-card-surface-default-solid)]"
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
            title="No one is sharing with you"
            description="Ask someone to share their location."
            action={
              onRequestLocation ? (
                <Button
                  type="button"
                  size="sm"
                  className="rounded-full"
                  onClick={onRequestLocation}
                >
                  Ask for location
                </Button>
              ) : null
            }
          />
        )
      ) : null}
      {kind === "needs-review" ? (
        vm.pendingOwnerRequests.length ? (
          <div className="space-y-3">
            {vm.pendingOwnerRequests.map((request) => (
              <div key={request.id} data-request-id={request.id}>
                <RequestCard
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
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No requests to review"
            description="New requests will appear here."
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
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
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

function ownedUserCircleScopeOptions(
  circles: readonly OneLocationCircleSummary[],
): OneLocationCircleSummary[] {
  return circles.filter(
    (circle) => circle.role === "owner" && circle.systemKind == null,
  );
}

function autoApproveScopeKey(scope: AutoApproveScope | null): string {
  if (!scope) return "";
  return scope.kind === "circle" ? `circle:${scope.circleId}` : "all_contacts";
}

function autoApproveScopeEqual(
  left: AutoApproveScope | null,
  right: AutoApproveScope | null,
): boolean {
  return autoApproveScopeKey(left) === autoApproveScopeKey(right);
}

function scopeMemberCountLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
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
  const [scopeSheetOpen, setScopeSheetOpen] = useState(false);
  const [draftScope, setDraftScope] = useState<AutoApproveScope | null>(null);
  const ownedCircles = useMemo(
    () => ownedUserCircleScopeOptions(vm.circles),
    [vm.circles],
  );
  const autoApproveScope = vm.autoApproveScope;
  const selectedCircle =
    autoApproveScope?.kind === "circle"
      ? ownedCircles.find((circle) => circle.id === autoApproveScope.circleId)
      : null;
  const activeScope =
    autoApproveScope?.kind === "all_contacts"
      ? autoApproveScope
      : selectedCircle && autoApproveScope?.kind === "circle"
        ? autoApproveScope
        : null;
  const activeScopeLabel = !vm.autoApproveRequestsEnabled
    ? "Choose a Circle or all contacts."
    : activeScope?.kind === "all_contacts"
      ? "All contacts"
      : selectedCircle
        ? selectedCircle.name
        : "Choose another scope.";
  const primaryScopeAction = vm.autoApproveRequestsEnabled ? "Save" : "Turn on";
  const allContactsScope = useMemo<AutoApproveScope>(
    () => ({ kind: "all_contacts" }),
    [],
  );

  const openScopeSheet = useCallback(() => {
    setDraftScope(vm.autoApproveRequestsEnabled ? activeScope : null);
    setScopeSheetOpen(true);
  }, [activeScope, vm.autoApproveRequestsEnabled]);

  const handleAutoApproveToggle = useCallback(
    (next: boolean) => {
      if (!next) {
        vm.onAutoApproveRequestsChange({ enabled: false, scope: null });
        return;
      }
      // Turning this on grants standing permission. Keep it off until the
      // person explicitly chooses who that permission covers.
      setDraftScope(activeScope);
      setScopeSheetOpen(true);
    },
    [activeScope, vm],
  );

  const commitAutoApproveScope = useCallback(() => {
    if (!draftScope) return;
    vm.onAutoApproveRequestsChange({ enabled: true, scope: draftScope });
    setScopeSheetOpen(false);
  }, [draftScope, vm]);

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-7 pb-[max(16px,env(safe-area-inset-bottom))]">
      {/* No header description. Each row below already says what it does, and
          the line that used to sit here ("Control live sharing") describes
          something this screen's first control no longer does. */}
      <TaskFlowHeader eyebrow="Location" title="Settings" />

      <SettingsGroup title="Automatic approval" separatorInset>
        <SettingsRow
          title="Auto-approve requests"
          description={activeScopeLabel}
          trailing={
            <LocationToggle
              checked={vm.autoApproveRequestsEnabled}
              onChange={handleAutoApproveToggle}
              label="Auto-approve requests"
            />
          }
          trailingInteractive
          onClick={openScopeSheet}
          chevron
          className="[--settings-row-py:14px]"
          testId="one-location-auto-approve-row"
        />
      </SettingsGroup>

      <SettingsGroup title="Safety" separatorInset>
        <SettingsRow
          title="Emergency contacts"
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

      <Dialog open={scopeSheetOpen} onOpenChange={setScopeSheetOpen}>
        <DialogContent
          className="max-w-[min(420px,calc(100vw-32px))] gap-5 rounded-[24px] p-5 sm:p-6"
          showCloseButton={false}
        >
          <DialogHeader className="gap-1 text-left">
            <DialogTitle className="text-[22px] font-semibold leading-[27px] tracking-[-0.01em] text-[color:var(--app-primary-label)]">
              Auto-approve for
            </DialogTitle>
            <DialogDescription className="text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
              Choose one.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <AutoApproveScopeOption
              title="All contacts"
              selected={autoApproveScopeEqual(draftScope, allContactsScope)}
              onSelect={() => setDraftScope(allContactsScope)}
            />

            {ownedCircles.length ? (
              <div className="space-y-2">
                <p className="px-1 text-[15px] font-medium leading-5 text-[color:var(--app-secondary-label)]">
                  Circles
                </p>
                <div className="overflow-hidden rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] ring-1 ring-[color:var(--app-separator)]">
                  {ownedCircles.map((circle) => {
                    const scope: AutoApproveScope = {
                      kind: "circle",
                      circleId: circle.id,
                    };
                    return (
                      <AutoApproveScopeOption
                        key={circle.id}
                        title={circle.name}
                        description={scopeMemberCountLabel(circle.memberCount)}
                        selected={autoApproveScopeEqual(draftScope, scope)}
                        onSelect={() => setDraftScope(scope)}
                        inset
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {draftScope ? (
            <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
              {draftScope.kind === "all_contacts"
                ? "New requests from current and future contacts will be approved automatically."
                : `New requests from current and future members of ${
                    ownedCircles.find(
                      (circle) => circle.id === draftScope.circleId,
                    )?.name ?? "this Circle"
                  } will be approved automatically.`}{" "}
              Requests already waiting still need your answer.
            </p>
          ) : (
            <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
              Requests already waiting still need your answer.
            </p>
          )}

          <DialogFooter className="gap-2 sm:flex-col sm:justify-start">
            <Button
              type="button"
              className="h-12 rounded-full text-[17px] font-semibold"
              disabled={!draftScope}
              onClick={commitAutoApproveScope}
            >
              {primaryScopeAction}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 rounded-full text-[17px] font-semibold"
              onClick={() => setScopeSheetOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AutoApproveScopeOption({
  title,
  description,
  selected,
  onSelect,
  inset = false,
}: {
  title: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  inset?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-[54px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors",
        inset
          ? "border-b border-[color:var(--app-separator)] last:border-b-0"
          : "rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] ring-1 ring-[color:var(--app-separator)]",
        selected && "bg-[color:var(--app-accent-surface)]",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-[17px] font-medium leading-[22px] text-[color:var(--app-primary-label)]">
          {title}
        </span>
        {description ? (
          <span className="block truncate text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
            {description}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected
            ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-white"
            : "border-[color:var(--app-separator)] bg-transparent text-transparent",
        )}
      >
        <Check className="h-4 w-4" />
      </span>
    </button>
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

function ActiveShareAvatar({ name }: { name: string }) {
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center">
      <Avatar initials={personInitials(name)} size={40} />
      <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[#34C759]" />
    </span>
  );
}

function ActiveShareMetadata({
  grant,
  formatEndsAt,
  untilStoppedLabel = "Until you stop",
}: {
  grant: OneLocationGrant;
  formatEndsAt?: (value?: string | null) => string;
  untilStoppedLabel?: string;
}) {
  const sms = isSmsTriggeredGrant(grant);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span>Active</span>
      <span aria-hidden="true">·</span>
      {sms ? (
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-[rgba(255,59,48,0.12)] px-1.5 text-[10px] font-semibold leading-none text-[#FF3B30]">
          SMS
        </span>
      ) : null}
      <span className="truncate">{grantLaneLabel(grant)}</span>
      <span aria-hidden="true">·</span>
      {grant.durationMode === "until_stopped" ? (
        <span className="truncate">{untilStoppedLabel}</span>
      ) : formatEndsAt ? (
        <span className="truncate">{`Access until ${formatEndsAt(grant.expiresAt)}`}</span>
      ) : (
        <ShareCountdownText
          expiresAt={grant.expiresAt}
          className="truncate"
        />
      )}
    </span>
  );
}

function StopGrantTextButton({
  grantId,
  revokingGrantId,
  onStopGrant,
}: {
  grantId: string;
  revokingGrantId: string | null;
  onStopGrant: (grantId: string) => void;
}) {
  const stopping = revokingGrantId === grantId;
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center justify-center rounded-full px-2 text-[15px] font-medium leading-[20px] text-[#FF3B30] transition-colors hover:text-[#D70015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
      onClick={() => onStopGrant(grantId)}
      disabled={stopping}
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}

/** One person in the People list: avatar (+ live dot) · name · status · action. */
function PersonRow({
  name,
  subtitle,
  active,
  first,
  action,
  expansion,
}: {
  name: string;
  subtitle: string;
  /** True when there's a live connection (you're sharing or they're sharing). */
  active: boolean;
  first: boolean;
  action: ReactNode;
  /**
   * The row's per-share breakdown, when this person holds more than one live
   * share. Rendered UNDER the row rather than beside it: it is a list with its
   * own controls, and the row's own line has one name, one status and one
   * action's worth of room.
   */
  expansion?: ReactNode;
}) {
  return (
    // The separator and the hover wash belong to the whole row INCLUDING its
    // breakdown: a person's two shares are one row, and a hairline cutting
    // between the name and the shares underneath it would read as two people.
    <div
      className={cn(
        "transition-colors hover:bg-[color:var(--app-neutral-fill)] motion-reduce:transition-none",
        !first && "border-t border-[color:var(--app-separator)]",
      )}
    >
      <div className="flex min-h-[62px] items-center gap-3 px-4 py-2 sm:min-h-16 sm:gap-3.5 sm:px-5">
        <div className="relative shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E5E5EA] text-[13px] font-semibold text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#D1D1D6]">
            {personInitials(name)}
          </span>
          {active ? (
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-[color:var(--app-primary-surface)] bg-[color:var(--app-success)]" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-normal leading-[22px] tracking-[-0.3px] text-foreground">
            {name}
          </p>
          <p className="truncate text-[14px] leading-[18px] tracking-[-0.2px] text-[color:var(--app-secondary-label)]">
            {subtitle}
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {expansion ? (
        <div className="px-[18px] pb-2 sm:px-6">{expansion}</div>
      ) : null}
    </div>
  );
}

function countdownAsLeft(label: string | null | undefined): string | null {
  if (!label) return null;
  if (/^Stops in\s+/i.test(label)) {
    return `${label.replace(/^Stops in\s+/i, "")} left`;
  }
  if (/^Stops\s+/i.test(label)) {
    return label.replace(/^Stops\s+/i, "Until ");
  }
  return label;
}

function peopleShareStatus(
  group: OneLocationGrantLaneGroup | null,
  receiving: boolean,
  countdownLabel: (value?: string | null) => string,
  fallback: string,
): string {
  if (group && receiving) return "Sharing both ways";
  if (!group) {
    return receiving
      ? "Sharing with you"
      : fallback === "Ready for private location sharing"
        ? "Connected"
        : fallback;
  }
  if (group.grants.length > 1) {
    return `${group.grants.length} active shares`;
  }
  const grant = group.primaryGrant;
  const left =
    grant.durationMode === "until_stopped"
      ? "Until you stop"
      : countdownAsLeft(countdownLabel(grant.expiresAt));
  const prefix = isSmsTriggeredGrant(grant) ? "Save My Soul" : "You’re sharing";
  return left ? `${prefix} · ${left}` : prefix;
}

function requestDurationLabel(request: OneLocationAccessRequest): string {
  if (request.requestedDurationMode === "until_stopped") {
    return "Until stopped";
  }
  return formatLocationDurationLabel(request.requestedDurationHours);
}

function sentRequestStatusLine(
  request: OneLocationAccessRequest,
  nowMs: number,
): string {
  if (/active|approved|shared|granted/i.test(request.status)) {
    return "Sharing with you";
  }
  const requestedAt = request.requestedAt
    ? Date.parse(request.requestedAt)
    : Number.NaN;
  const when = Number.isFinite(requestedAt)
    ? `Requested ${shortAgo(requestedAt, nowMs)}`
    : "Requested";
  const duration = requestDurationLabel(request);
  if (request.status === "pending") {
    return duration ? `${when} · ${duration}` : when;
  }
  return requestStatusWord(request.status);
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
  // Your live shares, by the person they point at -- ALL of them, not the
  // first one found. This list used to read `activeOwnerGrants.find(...)`,
  // which was correct only while a pair could hold one grant. Once an ordinary
  // share and an SMS (SOS) share can both be live with the same person, `find`
  // bound the row's single Stop to whichever happened to come first and left
  // the other share running with no way to see it, let alone end it.
  const ownerGroupsByUserId = useMemo(() => {
    const byUserId = new globalThis.Map<string, OneLocationGrantLaneGroup>();
    for (const group of groupGrantsByCounterpart(
      vm.activeOwnerGrants,
      "owner",
    )) {
      byUserId.set(group.counterpartUserId, group);
    }
    return byUserId;
  }, [vm.activeOwnerGrants]);
  const { expandedLaneUserIds, toggleLaneExpansion } = useExpandedShareLanes();
  const addPeopleEmptyAction = (
    <Button
      type="button"
      onClick={onAddConnections}
      data-voice-control-id="one-location-add-connections"
      className="h-11 min-h-11 rounded-full bg-[color:var(--app-accent)] px-6 text-[16px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
    >
      Add people
    </Button>
  );
  const addConnectionsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Add people"
          className="h-11 w-11 rounded-full text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]"
        >
          <Plus className="h-[21px] w-[21px]" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        forceMount
        className="min-w-52 rounded-2xl border border-[color:var(--app-border,rgba(255,255,255,0.1))] bg-[color:var(--app-primary-surface)] p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1c1c1e]"
      >
        <DropdownMenuItem
          data-voice-control-id="one-location-find-contacts"
          aria-busy={vm.busy === "contactSync" || undefined}
          disabled={vm.busy === "contactSync"}
          onSelect={(event) => {
            if (vm.busy === "contactSync") {
              event.preventDefault();
              return;
            }
            vm.onSyncContacts();
          }}
          className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px] font-medium text-[color:var(--app-primary-label)] focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-white/10"
        >
          {vm.busy === "contactSync" ? "Finding contacts…" : "Find contacts"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onInvite()}
          data-voice-control-id="one-location-action-invite"
          className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px] font-medium text-[color:var(--app-primary-label)] focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-white/10"
        >
          Invite to One
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onAddConnections()}
          data-voice-control-id="one-location-add-connections"
          className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px] font-medium text-[color:var(--app-primary-label)] focus:bg-[color:var(--app-neutral-fill)] dark:focus:bg-white/10"
        >
          Manage connections
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="pt-5 sm:pt-9" data-testid="one-location-people-hub">
      <div className="space-y-7 sm:space-y-10">
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

        <div className="space-y-7 sm:space-y-9">
          <section
            aria-labelledby="one-location-connections-heading"
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-x-6"
            data-testid="one-location-people-connections"
          >
            <h2
              id="one-location-connections-heading"
              className="col-start-1 row-start-1 text-[15px] font-medium leading-5 tracking-[-0.01em] text-[color:var(--app-section-label)]"
            >
              Connections
            </h2>

            <div className="col-start-3 row-start-1 justify-self-end sm:col-start-4">
              {addConnectionsMenu}
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
                placeholder="Search people"
              />
            </div>

            <div className="col-span-3 row-start-3 mt-3 sm:col-span-4 sm:mt-3.5">
              {filtered.length ? (
                <div
                  className={PEOPLE_GROUP_SURFACE}
                  data-testid="one-location-people-list"
                >
                  {filtered.map((r, i) => {
                    const shareGroup =
                      ownerGroupsByUserId.get(r.userId) ?? null;
                    const sharing = Boolean(shareGroup);
                    // One share is still one tap: the row keeps its single
                    // Stop and grows nothing. The breakdown appears only for a
                    // person who genuinely has two.
                    const singleGrant =
                      shareGroup && shareGroup.grants.length === 1
                        ? shareGroup.primaryGrant
                        : null;
                    const lanesExpanded = expandedLaneUserIds.has(r.userId);
                    const lanesId = `one-location-people-lanes-${r.userId}`;
                    const receiving = vm.receivedGrants.some(
                      (g) => g.ownerUserId === r.userId,
                    );
                    const ready = vm.isRecipientShareReady(r);
                    const name = vm.recipientLabel(r);
                    return (
                      <PersonRow
                        key={r.userId}
                        name={name}
                        expansion={
                          shareGroup && !singleGrant ? (
                            <div id={lanesId} hidden={!lanesExpanded}>
                              {/* Stopping the SMS share here is exactly the
                                  same act as stopping it from the Emergency
                                  help screen: the same grant id through the
                                  same `revokeGrant`. The normal share keeps
                                  its original countdown, and stopping the
                                  normal share never touches the SMS one --
                                  that is the whole of #5506, made visible. */}
                              <PersonShareLanes
                                group={shareGroup}
                                counterpartName={name}
                                onStopGrant={vm.onStopGrant}
                                revokingGrantId={vm.revokingGrantId}
                              />
                            </div>
                          ) : null
                        }
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
                          peopleShareStatus(
                            shareGroup,
                            receiving,
                            vm.expiresCountdownLabel,
                            vm.recipientSubtitle(r),
                          )
                        }
                        active={sharing || receiving}
                        first={i === 0}
                        action={
                          singleGrant ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => vm.onStopGrant(singleGrant.id)}
                              isLoading={vm.revokingGrantId === singleGrant.id}
                              aria-label={`Stop sharing with ${name}`}
                              className="relative h-9 min-h-9 rounded-full px-2 text-[15px] font-medium text-[#FF3B30] after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] hover:bg-transparent hover:text-[#D70015]"
                            >
                              Stop
                            </Button>
                          ) : shareGroup ? (
                            <ShareLanesDisclosure
                              expanded={lanesExpanded}
                              onToggle={() => toggleLaneExpansion(r.userId)}
                              controlsId={lanesId}
                              label={`Manage your shares with ${name}`}
                            />
                          ) : ready ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onStartShare(r.userId)}
                              aria-label={`Share with ${name}`}
                              className="relative h-9 min-h-9 rounded-full px-2 text-[15px] font-medium text-[color:var(--app-accent)] after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] hover:bg-transparent hover:text-[color:var(--app-accent-hover)]"
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
                        ? "Try another name."
                        : "Add people to share location privately."
                    }
                    // The first link in a chain that already had its other
                    // two. A name matching nobody here usually belongs to
                    // someone not connected yet, so this hands over to
                    // Connect -- where a search that also finds nobody offers
                    // "Invite them to One". Without it the person had to guess
                    // that Connect was the next place to look.
                    //
                    // The header actions sit above the list and are out of
                    // view once results have scrolled, so the way out belongs
                    // here, where the dead end is.
                    action={
                      hasSearch ? (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          onClick={onAddConnections}
                          data-voice-control-id="one-location-empty-connect-bridge"
                          className={PEOPLE_HEADER_ACTION}
                        >
                          Manage connections
                        </Button>
                      ) : (
                        addPeopleEmptyAction
                      )
                    }
                  />
                </div>
              )}
            </div>
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
                      title={ownerLabel}
                      description={sentRequestStatusLine(request, vm.nowMs)}
                      trailing={
                        canEdit && grantId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 px-2 text-[15px] font-medium text-[color:var(--app-accent)] hover:bg-transparent hover:text-[color:var(--app-accent-hover)]"
                            onClick={() =>
                              isEditing
                                ? vm.onEditGrantCancel()
                                : vm.onEditGrantStart(grantId)
                            }
                          >
                            {isEditing ? "Done" : "Manage"}
                          </Button>
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
                            className="h-9 px-2 text-[15px] font-medium text-[#FF3B30] hover:bg-transparent hover:text-[#D70015]"
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
                      <div className="space-y-3 px-4 pb-4 pt-1 sm:px-5">
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
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 rounded-full px-4 text-sm font-semibold text-[#FF3B30] hover:bg-[#FF3B30]/10 hover:text-[#D70015]"
                            onClick={() => vm.onStopGrant(grantId)}
                            disabled={vm.revokingGrantId === grantId}
                          >
                            Stop
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

const PUBLIC_LINK_DURATION_OPTIONS = [
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
] as const;

function publicLinkStatusLabel(label?: string | null): string {
  if (!label) return "Active";
  return label.replace(/^Stops in\b/i, "Expires in");
}

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
        <RowLabel as="p" className="truncate">
          {title}
        </RowLabel>
        <RowDescription as="p" className="mt-0.5 truncate">
          {subtitle}
        </RowDescription>
      </div>
      <Button
        variant="outline"
        onClick={onCopy}
        size="sm"
        className="shrink-0 border-[color:var(--app-accent)] px-4 text-[color:var(--app-accent)]"
      >
        Copy
      </Button>
    </div>
  );
}

/**
 * The Links tab, which is now the whole of the live-location-link flow.
 *
 * Making one used to take three screens: this tab, with a "Create link" button
 * that created nothing and only navigated; a separate `?action=temp-link`
 * screen carrying a warning, one duration question and the button that
 * actually created; and then that same screen again, showing the result with a
 * "Done" that returned here -- where the link appeared a third time, as a row,
 * with only a Copy button. Two of those three screens existed to ask one
 * question and to acknowledge its answer.
 *
 * The question is now asked here, and the answer replaces it in place.
 *
 * One live link at a time. While one is active there is no create control at
 * all: not disabled, absent. A second link is not a thing the product wants to
 * be able to make -- both stay independently resolvable, revoking the one on
 * screen leaves the other watching, and the tab can only ever show the newest.
 * The way to a different link is to end this one, which is a button already on
 * the card. The server refuses the second as well (`create_public_invite`
 * hands back the live one), because a rule that lives only in a component is
 * defeated by a stale tab.
 */
function LinksHub({ vm }: { vm: LocationHubViewModel }) {
  const temp = vm.latestActivePublicInvite;
  const invite = vm.latestActiveCircleInvite;
  // Two separate questions, and both have to be asked.
  //
  //   is a link live?      `temp` -- the server's row
  //   can we hand it over? `vm.publicInviteUrl` -- the URL itself
  //
  // Neither implies the other. An invite minted before its token could be
  // re-derived from its row is live with no recoverable URL, so Copy would
  // hand over nothing. And for one round trip after creating, the URL is known
  // while the row is not: `onCreatePublicInvite` fires its refresh without
  // awaiting it. Keying the whole tab on `temp` alone put the create form back
  // on screen during that window, which reads as "nothing happened" and
  // invites a second press.
  const hasLiveLink = Boolean(temp) || Boolean(vm.publicInviteUrl);
  const hasShareableLink = Boolean(vm.publicInviteUrl);

  return (
    <div className="space-y-4">
      <div className="px-[6px]">
        <SectionTitle as="h2">Temporary link</SectionTitle>
      </div>

      {hasLiveLink ? (
        hasShareableLink ? (
          <TemporaryLinkCard
            statusLine={
              temp
                ? publicLinkStatusLabel(
                    vm.expiresCountdownLabel(temp.expiresAt),
                  )
                : "Active"
            }
            description="Anyone with this link can see your location."
            // No countdown until the row lands: inventing one from the
            // duration that was picked would drift from the expiry the server
            // actually stamped.
            onCopy={vm.onCopyPublicInvite}
            onShare={vm.onSharePublicInvite}
            // Revoking needs the invite's id, which arrives with the row. In
            // the moment before it does, the control shows itself as busy
            // rather than pretending to work -- which is honest, because a
            // refresh really is in flight. Copy and Share are unaffected: the
            // URL is already in hand.
            onRevoke={() => {
              if (temp) vm.onRevokePublicInvite(temp);
            }}
            revokeBusy={vm.busy === "publicRevoke" || !temp}
          />
        ) : (
          // Live, and its URL is gone: an invite from before the token could be
          // re-derived from its row. Copy and Share would be dead controls, so
          // they are not offered -- but the link is still out there watching,
          // so ending it has to stay reachable. Saying why keeps this from
          // reading as a bug the person should retry.
          <div className={cn(SUBCARD_SURFACE, "space-y-4 p-5 sm:p-6")}>
            <p className="text-[15px] leading-5 text-muted-foreground">
              Active, but the link is unavailable on this device.
            </p>
            <button
              type="button"
              onClick={() => {
                if (temp) vm.onRevokePublicInvite(temp);
              }}
              disabled={vm.busy === "publicRevoke" || !temp}
              className="min-h-11 w-full text-left text-[15px] font-semibold leading-5 text-[color:var(--app-destructive)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
            >
              {vm.busy === "publicRevoke" || !temp ? "Stopping…" : "Stop link"}
            </button>
          </div>
        )
      ) : (
        // No warning banner above the picker. It said two things the screen
        // already says better: the duration control underneath states exactly
        // how long the link lives, and the card that replaces this whole block
        // once a link exists carries the concise visibility line on
        // the object it is actually about. An amber panel repeating both, on
        // the one screen whose entire purpose is to create the link, read as a
        // reason not to press the button rather than as information.
        <div className={cn(SUBCARD_SURFACE, "space-y-5 p-5 sm:p-6")}>
          <p className="text-[15px] leading-5 text-muted-foreground">
            Anyone with this link can see your location until it expires.
          </p>
          <div className="space-y-2.5">
            <p className="text-[15px] font-semibold leading-5 text-foreground">
              Duration
            </p>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="Temporary link duration"
            >
              {PUBLIC_LINK_DURATION_OPTIONS.map((option) => {
                const selected = vm.publicLinkDurationHours === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => vm.setPublicLinkDurationHours(option.value)}
                    className={cn(
                      "h-11 rounded-[14px] border text-[15px] font-semibold leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2",
                      selected
                        ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                        : "border-border bg-[color:var(--app-card-surface-compact)] text-foreground hover:bg-[color:var(--app-card-surface-compact)]/80",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* The label changes while it works. This press waits on a device fix
              before it can post anything, so on a cold start it can sit for
              several seconds -- and it used to sit as a bare spinner with the
              label hidden, which is why it read as "taking longer than
              expected" rather than as "still finding you". Naming the wait is
              the fix available here; the wait itself is a GPS acquisition. */}
          <Button
            onClick={vm.onCreatePublicInvite}
            isLoading={vm.busy === "publicInvite"}
            data-voice-control-id="one-location-action-temp-link"
            className="h-12 min-h-12 w-full rounded-[15px] bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            {vm.busy === "publicInvite" ? "Creating link…" : "Create link"}
          </Button>
        </div>
      )}

      {/* A Circle invite is a different object on a different table with a
          different ceiling, and it is not subject to the one-at-a-time rule
          above: it admits one named person to a Circle rather than showing the
          owner to anyone holding a URL. It keeps its row. */}
      {invite ? (
        <div className={cn("overflow-hidden px-3.5", SUBCARD_SURFACE)}>
          <ActiveLinkRow
            first
            tileClass="bg-[color:var(--app-success)]/12 dark:bg-[color:var(--app-success)]/15"
            icon={
              <ShieldCheck className="h-[17px] w-[17px] text-[color:var(--app-success)]" />
            }
            title="Invite link"
            subtitle={`${vm.expiresCountdownLabel(invite.expiresAt)} · one person`}
            onCopy={vm.onCopyCircleInvite}
          />
        </div>
      ) : null}
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
        emergencyStatus={lookupStartedForMount ? vm.sosEmergencyStatus : "idle"}
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
  //
  // The grant a row reports is the ORDINARY one when the person holds both.
  // Building this straight from the grant list made it a last-one-wins map, so
  // while an SMS (SOS) share was live with somebody, their row quoted the SOS
  // grant's hours -- time that re-picking them would not have restarted, since
  // replacement is lane-scoped and a plain share only ever supersedes a plain
  // share. The number on the row has to be the one the tap would reset.
  const activeGrantByRecipientId = new globalThis.Map(
    groupGrantsByCounterpart(vm.activeOwnerGrants, "owner").map((group) => [
      group.counterpartUserId,
      group.ordinaryGrant ?? group.primaryGrant,
    ]),
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
          ready
            ? () => vm.toggleShareRecipient(r.userId, "share_flow")
            : undefined
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
    .filter((recipient): recipient is OneLocationRecipient =>
      Boolean(recipient && vm.isRecipientShareReady(recipient)),
    );
  const shareNoteLength = vm.shareMessage.length;
  const shareNoteLimitExceeded =
    shareNoteLength > ONE_LOCATION_SHARE_NOTE_MAX_LENGTH;
  const [shareNoteFocused, setShareNoteFocused] = useState(false);
  const showShareNoteCount =
    shareNoteFocused ||
    shareNoteLength > 0 ||
    shareNoteLength >= ONE_LOCATION_SHARE_NOTE_MAX_LENGTH - 20 ||
    shareNoteLimitExceeded;
  // Picking a Circle selects its ready members in the list below, and those
  // rows remain individually deselectable. Once one is turned off the recipients
  // are no longer that Circle, so the Circle row stops reading as selected.
  const shareableCircles = useMemo(
    () => vm.circles.filter((circle) => circle.systemKind !== "trusted"),
    [vm.circles],
  );
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
      <div className="mx-auto w-full max-w-[560px] space-y-6 pb-[calc(var(--app-bottom-content-clearance,7rem)+2rem)]">
        {/* No description: the summary card directly below states who can see
            you, for how long and when it ends. Repeating that in prose above it
            is the design explaining itself. */}
        <TaskFlowHeader eyebrow="Step 2 of 2" title="Ready to share?" />

        <SectionCard className="p-5 sm:p-6">
          <div className="space-y-6">
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
                  onChange={(event) => vm.setShareMessage(event.target.value)}
                  onFocus={() => setShareNoteFocused(true)}
                  onBlur={() => setShareNoteFocused(false)}
                  rows={2}
                  aria-invalid={shareNoteLimitExceeded}
                  aria-describedby={
                    shareNoteLimitExceeded
                      ? "one-location-share-note-count one-location-share-note-error"
                      : showShareNoteCount
                        ? "one-location-share-note-count"
                        : undefined
                  }
                  placeholder="On my way to the meeting"
                  className="block min-h-[92px] w-full resize-none rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-compact)] px-4 pb-8 pt-3.5 text-[17px] leading-[22px] text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)] aria-invalid:border-destructive aria-invalid:focus:ring-destructive/30"
                />
                {showShareNoteCount ? (
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
                ) : null}
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

        <SelectedRecipientsRail
          title="Can see you"
          ariaLabel="People who can see your location"
          recipients={selectedReady}
          recipientLabel={vm.recipientLabel}
          trailing={
            <button
              type="button"
              onClick={backToPeople}
              aria-label="Change who can see you"
              className="flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-[color:var(--app-accent)]"
            >
              Edit
            </button>
          }
        />

        <div className="space-y-2.5">
          <Button
            onClick={vm.onConfirmShare}
            disabled={!vm.canShare || shareNoteLimitExceeded}
            isLoading={vm.busy === "share"}
            data-voice-control-id="one-location-confirm-share"
            className="h-[52px] w-full rounded-2xl bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
          >
            Start sharing
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            className="h-11 w-full rounded-2xl bg-transparent text-[17px] font-medium leading-[22px] text-[color:var(--app-accent)] hover:bg-transparent"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // step === "person"
  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 pb-[calc(var(--app-bottom-content-clearance,7rem)+9rem)]">
      <TaskFlowHeader
        eyebrow="Step 1 of 2"
        title="Who can see you?"
        description="Choose a Circle or contact."
      />
      {/* Trusted is not a group you share with.
       *
       * It listed here with the same glyph and count as a Circle somebody
       * made, and one tap pre-selected every location-ready person in it --
       * which, for a Circle whose roster IS the connection graph, is
       * "everyone you know" behind a single press. The share then succeeded,
       * because those people satisfy the connection arm anyway, so nothing
       * refused it: this is the only place that says no.
       *
       * The eligibility SQL puts it plainly -- "Trusted records who you are
       * connected to; it never decides who can see you" -- and the onboarding
       * invite step already filters the same way. Only this picker is
       * narrowed: the People tab, SOS contacts and the SMS flow still list
       * every Circle. */}
      {shareableCircles.length ? (
        <SettingsGroup
          title="Circles"
          separatorInset
          className="[&>div:first-child]:mt-0"
        >
          {[...shareableCircles]
            .sort((a, b) => (a.name === "SMS Circle" ? 1 : b.name === "SMS Circle" ? -1 : 0))
            .map((circle) => {
            const selected =
              vm.selectedShareCircleSelection?.circle.id === circle.id &&
              shareCircleFullySelected;
            const circleRole = roleClasses("people");
            return (
              <SettingsRow
                key={circle.id}
                density="compact"
                disabled={vm.busy === "shareCircle"}
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
                  vm.busy === "shareCircle"
                    ? "Loading…"
                    : selected
                      ? `${selectedReady.length} selected`
                      : circleMemberCountLabel(circle.memberCount)
                }
                trailing={<SelectionDot selected={selected} />}
              />
            );
          })}
        </SettingsGroup>
      ) : null}
      <PersonSearchInput
        value={vm.shareRecipientSearch}
        onChange={vm.setShareRecipientSearch}
        placeholder="Search people"
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
              title={
                <span className="flex w-full items-center justify-between gap-4">
                  <span>Already sharing</span>
                  <span className="font-normal text-muted-foreground">
                    {alreadySharing.length}
                  </span>
                </span>
              }
              testId="one-location-share-already-sharing"
              separatorInset
              className="[&>div:first-child]:mt-0"
            >
              {alreadySharing.map((r) =>
                renderShareRecipientRow(
                  r,
                  activeGrantByRecipientId.get(r.userId),
                ),
              )}
            </SettingsGroup>
          ) : null}
          {notSharing.length ? (
            <SettingsGroup
              title="People"
              testId="one-location-share-people"
              separatorInset
              className="[&>div:first-child]:mt-0"
            >
              {notSharing.map((r) => renderShareRecipientRow(r, undefined))}
            </SettingsGroup>
          ) : null}
        </div>
      ) : vm.shareRecipientSearch.trim() ? (
        // A typo used to be reported as "you have no contacts", which sends a
        // person with twenty of them off to invite people they already have.
        // The list being empty and the QUERY being empty are different facts.
        <EmptyState
          title="No matching people"
          description="Try a different name."
        />
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
      <div className="mt-6 rounded-[22px] border border-white/65 bg-white/80 p-2 shadow-[0_10px_28px_rgba(15,23,42,0.09)] backdrop-blur-xl supports-[not(backdrop-filter:blur(1px))]:bg-white dark:border-white/10 dark:bg-black/55">
        <div className="mb-2 flex min-h-5 items-center justify-between px-1 text-[13px] leading-[18px] text-muted-foreground">
          {selectedReady.length ? (
            <span>{selectedReady.length} selected</span>
          ) : (
            <span>Choose who can see you.</span>
          )}
        </div>
        <Button
          onClick={() => setStep("details")}
          disabled={!selectedReady.length}
          className="h-[52px] w-full rounded-2xl bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
        >
          Continue
        </Button>
      </div>
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
        <Check
          className="h-3 w-3 text-[color:var(--app-accent-fg)]"
          strokeWidth={3}
        />
      ) : null}
    </span>
  );
}

function RequestRecipientListRow({
  name,
  subtitle,
  tone,
  statusLabel,
  selectable,
  selected,
  actionAriaLabel,
  onSelect,
  onEdit,
  editActive,
  onRemove,
  removeAriaLabel,
  removeBusy,
  expandedContent,
}: {
  name: string;
  subtitle?: string;
  tone: "ready" | "pending" | "neutral";
  statusLabel?: string;
  selectable: boolean;
  selected: boolean;
  actionAriaLabel: string;
  onSelect?: () => void;
  onEdit?: () => void;
  editActive?: boolean;
  onRemove?: () => void;
  removeAriaLabel?: string;
  removeBusy?: boolean;
  expandedContent?: ReactNode;
}) {
  const pillTone =
    statusLabel === "Live"
      ? "live"
      : tone === "pending"
        ? "pending"
        : "neutral";

  return (
    <div
      className={cn(
        "min-w-0 bg-transparent",
        selected && selectable && "bg-[color:var(--app-accent)]/[0.045]",
      )}
    >
      <div className="flex min-h-[58px] items-center gap-3 px-3.5 py-2">
        <ContactAvatar label={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
            {name}
          </span>
          {subtitle ? (
            <span className="mt-0.5 block truncate text-[13px] leading-4 text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {statusLabel ? (
            <StatusPill tone={pillTone} className="px-2 py-0 text-[12px]">
              {statusLabel}
            </StatusPill>
          ) : null}
          {onEdit ? (
            <ShellActionSurface
              variant="icon"
              className="h-8 w-8 shrink-0"
              aria-label={`${editActive ? "Cancel editing" : "Edit"} access for ${name}`}
              aria-pressed={editActive}
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </ShellActionSurface>
          ) : null}
          {onRemove ? (
            <ShellActionSurface
              variant="icon"
              className="h-8 w-8 shrink-0 text-destructive"
              aria-label={removeAriaLabel ?? `Remove ${name}'s access`}
              onClick={onRemove}
              disabled={removeBusy}
            >
              {removeBusy ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </ShellActionSurface>
          ) : null}
          {selectable && onSelect ? (
            <button
              type="button"
              onClick={onSelect}
              aria-label={actionAriaLabel}
              aria-pressed={selected}
              className={cn(
                "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors touch-manipulation",
                "hover:bg-[color:var(--app-secondary-system-fill)] focus:outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)]",
              )}
            >
              <SelectionDot selected={selected} />
            </button>
          ) : null}
        </span>
      </div>
      {expandedContent ? (
        <div className="border-t border-[color:var(--app-separator)] px-3.5 py-3">
          {expandedContent}
        </div>
      ) : null}
    </div>
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
  const [step, setStep] = useState<"person" | "details">("person");
  /**
   * The field is local; the FILTER is debounced.
   *
   * `setRecipientSearch` drives `visibleRecipients`, which re-runs
   * `filterPeopleByQuery` over the whole roster and re-renders every row. Wired
   * straight to `onChange` that happened once per keystroke, which is what a
   * hundred connections cannot afford. Typing stays instant because the input
   * reads local state; only the query that does the work is delayed.
   *
   * 250ms, close to Connect's 300: long enough to swallow a burst of typing,
   * short enough that the list feels answerable rather than laggy.
   */
  const [searchDraft, setSearchDraft] = useState(vm.recipientSearch);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);
  useEffect(() => {
    if (debouncedSearch !== vm.recipientSearch) {
      vm.setRecipientSearch(debouncedSearch);
    }
    // `vm` is rebuilt every render; depending on it would re-fire this on every
    // render and defeat the debounce entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

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
  const selectedRequestRecipients = useMemo(() => {
    const byId = new globalThis.Map(
      vm.recipients.map((recipient) => [recipient.userId, recipient]),
    );
    return selectedRequestOwnerIds
      .map((recipientId) => byId.get(recipientId))
      .filter((recipient): recipient is OneLocationRecipient =>
        Boolean(recipient),
      );
  }, [selectedRequestOwnerIds, vm.recipients]);
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

  /**
   * Every live grant with each owner, indexed once.
   *
   * The row used to run `receivedGrants.find(...)` for itself, so a roster of R
   * people scanned the grant list R times per render. Worse, `find` was written
   * when a person and a grant were the same thing: an owner can now hold an
   * ordinary share and an SMS (SOS) one at the same time, and `find` bound the
   * row to whichever happened to come first.
   *
   * `groupGrantsByCounterpart` is the shared answer the People directory and
   * Shared-with-me already use, and its `primaryGrant` is `grants[0]` in the
   * caller's order -- the same grant `find` returned. So this indexes the work
   * without moving the answer, and the other lane is now reachable rather than
   * silently dropped.
   */
  /**
   * The roster, arranged.
   *
   * Recency comes from what this screen already holds -- a request you sent, a
   * share they gave you, a share you gave them -- so no new storage and no
   * invented "frequently contacted", which nothing in this product counts.
   *
   * While a query is active the arrangement is dropped: a search result is
   * ordered by how well each person matches, and headings over that would name
   * an order the list does not have.
   */
  const lastInteraction = useMemo(
    () =>
      lastInteractionByUserId({
        requestedByMe: vm.requestedByMe,
        receivedGrants: vm.receivedGrants,
        ownerGrants: vm.activeOwnerGrants,
      }),
    [vm.requestedByMe, vm.receivedGrants, vm.activeOwnerGrants],
  );
  const rosterRows = useMemo(
    () =>
      flattenRecipientSections(
        sectionRecipients({
          recipients: filtered,
          lastInteraction,
          label: vm.recipientLabel,
          querying: vm.recipientSearch.trim().length > 0,
        }),
      ),
    [filtered, lastInteraction, vm.recipientLabel, vm.recipientSearch],
  );
  const rosterRecipientRows = useMemo(
    () => rosterRows.filter((row) => row.kind === "recipient"),
    [rosterRows],
  );

  const receivedGroupsByOwner = useMemo(() => {
    const byOwner = new globalThis.Map<string, OneLocationGrantLaneGroup>();
    // `"recipient"` -- the side argument names WHICH SIDE I AM, so for grants
    // shared WITH me the counterpart to key on is the owner. Passing "owner"
    // here keys every group by my own id and the lookup finds nothing; the
    // Shared-with-me list a few hundred lines up passes "recipient" for the
    // same array, for the same reason.
    for (const group of groupGrantsByCounterpart(
      vm.receivedGrants,
      "recipient",
    )) {
      byOwner.set(group.counterpartUserId, group);
    }
    return byOwner;
  }, [vm.receivedGrants]);

  /**
   * What each visible row says, computed once per data change.
   *
   * `requestRecipientStatus` filters AND sorts `requestedByMe` on every call,
   * so calling it inside the render loop cost R x O(G log G) per render -- and
   * a 30-second tick paid it again whether or not anything had happened. The
   * inputs are the same for every row; only the recipient id differs.
   */
  const statusByRecipient = useMemo(() => {
    const byRecipient = new globalThis.Map<string, RequestRecipientStatus>();
    for (const recipient of filtered) {
      byRecipient.set(
        recipient.userId,
        requestRecipientStatus({
          recipientUserId: recipient.userId,
          requestedByMe: vm.requestedByMe,
          receivedGrants: vm.receivedGrants,
          nowMs: statusNowMs,
        }),
      );
    }
    return byRecipient;
  }, [filtered, vm.requestedByMe, vm.receivedGrants, statusNowMs]);

  /**
   * Whether anything on screen is actually measured against the clock.
   *
   * "Asked 6m ago" and "Sharing with you, 29 more min" go stale; "Ready for
   * private sharing" does not. A roster of people you have never asked and who
   * are not sharing has nothing that ages, and re-rendering it every 30 seconds
   * is CPU spent to redraw identical text -- battery, on a phone.
   */
  const hasTimeRelativeRow = useMemo(
    () =>
      [...statusByRecipient.values()].some(
        (status) =>
          status.statusLabel !== undefined ||
          status.pendingRequestId !== undefined ||
          status.tone !== "ready",
      ),
    [statusByRecipient],
  );

  useEffect(() => {
    if (!hasTimeRelativeRow) return;
    const timer = window.setInterval(() => setStatusNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasTimeRelativeRow]);

  const isRequestFormValid = vm.selectedRequestOwnerIds.length > 0;
  const sendingRequest = vm.busy === "request";
  const sendRequest = () => {
    // Never submit an incomplete form even if the click somehow reaches the
    // handler (e.g. keyboard/AT), and never double-fire.
    if (!isRequestFormValid || sendingRequest || sendInFlightRef.current)
      return;
    sendInFlightRef.current = true;
    sentSelectionRef.current = vm.selectedRequestOwnerIds;
    void (async () => {
      try {
        // Confirm only what actually happened: the banner appears on a
        // resolved success, and a failure leaves the composer intact with its
        // own error toast.
        const sent = await vm.onSendRequest(reason);
        setJustSent(sent);
        if (sent) setStep("person");
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  };

  if (step === "details") {
    return (
      <div className="mx-auto w-full max-w-[560px] space-y-6 pb-[calc(var(--app-bottom-content-clearance,7rem)+5rem)]">
        <TaskFlowHeader eyebrow="Step 2 of 2" title="Ready to ask?" />

        <SectionCard className="p-5 sm:p-6">
          <div className="space-y-6">
            <DurationSelector
              value={vm.durationHours}
              onChange={vm.setDurationHours}
              maxWidthClassName={null}
              label="How long"
              presentation="ladder"
              allowUntilStop={false}
              rungs={REQUEST_DURATION_LADDER}
            />
            <ReasonChips
              value={reason}
              onChange={(next) => {
                setReason(next);
                if (next !== "Other") vm.setRequestMessage("");
              }}
              label="Reason"
              presentation="buttons"
            />
            {reason === "Other" ? (
              <div className="space-y-2.5">
                <label
                  htmlFor="one-location-ask-other-reason"
                  className="text-sm font-semibold text-foreground"
                >
                  Add reason
                </label>
                <textarea
                  id="one-location-ask-other-reason"
                  value={vm.requestMessage}
                  onChange={(e) =>
                    vm.setRequestMessage(
                      e.target.value.slice(
                        0,
                        ONE_LOCATION_REQUEST_REASON_MAX_LENGTH,
                      ),
                    )
                  }
                  rows={2}
                  maxLength={ONE_LOCATION_REQUEST_REASON_MAX_LENGTH}
                  placeholder="What should they know?"
                  className="block min-h-[88px] w-full resize-none rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-compact)] px-4 pb-8 pt-3.5 text-[17px] leading-[22px] text-foreground outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
                />
              </div>
            ) : null}
          </div>
        </SectionCard>

        <SelectedRecipientsRail
          title="Asking"
          ariaLabel="People you are asking for location"
          recipients={selectedRequestRecipients}
          recipientLabel={vm.recipientLabel}
          trailing={
            <button
              type="button"
              onClick={() => setStep("person")}
              aria-label="Change who you are asking"
              className="flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-[color:var(--app-accent)]"
            >
              Edit
            </button>
          }
        />

        <div data-testid="one-location-ask-send-bar" className="space-y-2.5">
          {isRequestFormValid ? (
            <p
              aria-live="polite"
              data-testid="one-location-ask-selection-summary"
              className={cn(MUTED_TEXT, "px-1")}
            >
              {vm.selectedRequestOwnerIds.length === 1
                ? "1 person selected"
                : `${vm.selectedRequestOwnerIds.length} people selected`}
            </p>
          ) : null}
          <Button
            onClick={sendRequest}
            disabled={!isRequestFormValid || sendingRequest}
            aria-disabled={!isRequestFormValid || sendingRequest}
            isLoading={sendingRequest}
            className="h-[52px] w-full rounded-2xl bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:pointer-events-none disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
          >
            Send request
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            className="h-11 w-full rounded-2xl bg-transparent text-[17px] font-medium leading-[22px] text-[color:var(--app-accent)] hover:bg-transparent"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 pb-[calc(var(--app-bottom-content-clearance,7rem)+9rem)]">
      <TaskFlowHeader
        eyebrow="Step 1 of 2"
        title="Request location"
        description="Choose who to ask."
      />

      {justSent ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-[20px] border border-[color:var(--app-success)]/25 bg-white px-4 py-4 shadow-[0_14px_34px_rgba(15,23,42,0.08)]"
        >
          <ShieldCheck className="mt-0.5 h-[19px] w-[19px] shrink-0 text-[color:var(--app-success)]" />
          <p className="text-[17px] font-medium leading-[22px] text-foreground">
            Request sent.
          </p>
        </div>
      ) : null}

      <section className="space-y-3">
        <AppSectionLabel as="h2">People</AppSectionLabel>
        <PersonSearchInput value={searchDraft} onChange={setSearchDraft} />
        {filtered.length ? (
          <VirtualContactList
            items={rosterRecipientRows}
            getKey={(row) => row.key}
            testId="one-location-ask-recipients"
            ariaLabel="People you can ask"
            maxHeightClassName="max-h-[48vh]"
            renderItem={(row) => {
              const r = row.recipient;
              const selected = vm.selectedRequestOwnerIds.includes(r.userId);
              const status =
                statusByRecipient.get(r.userId) ??
                requestRecipientStatus({
                  recipientUserId: r.userId,
                  requestedByMe: vm.requestedByMe,
                  receivedGrants: vm.receivedGrants,
                  nowMs: statusNowMs,
                });
              const activeGrant = receivedGroupsByOwner.get(
                r.userId,
              )?.primaryGrant;
              const isEditingThis =
                Boolean(activeGrant) && vm.editingGrantId === activeGrant?.id;
              const pendingRequestId = status.pendingRequestId;
              const recipientLabel = vm.recipientLabel(r);
              return (
                <RequestRecipientListRow
                  key={r.userId}
                  name={recipientLabel}
                  subtitle={
                    status.selectable && status.tone === "ready"
                      ? undefined
                      : status.subtitle
                  }
                  tone={status.tone}
                  statusLabel={status.statusLabel}
                  selectable={status.selectable}
                  actionAriaLabel={`${
                    selected ? "Deselect" : "Select"
                  } ${recipientLabel} for location request`}
                  onSelect={
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
                      <div className="space-y-3">
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
                      </div>
                    ) : undefined
                  }
                />
              );
            }}
          />
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
        <Link
          href={ROUTES.CONNECT}
          data-testid="one-location-ask-manage-connections"
          className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-full px-1 text-[15px] font-medium text-[color:var(--app-accent)]"
        >
          Don&apos;t see someone? Manage connections
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      </section>

      <div className="rounded-[22px] border border-white/65 bg-white/80 p-2 shadow-[0_10px_28px_rgba(15,23,42,0.09)] backdrop-blur-xl supports-[not(backdrop-filter:blur(1px))]:bg-white dark:border-white/10 dark:bg-black/55">
        <div className="mb-2 flex min-h-5 items-center justify-between px-1 text-[13px] leading-[18px] text-muted-foreground">
          {selectedRequestRecipients.length ? (
            <span>
              {selectedRequestRecipients.length === 1
                ? "1 selected"
                : `${selectedRequestRecipients.length} selected`}
            </span>
          ) : (
            <span>Choose who to ask.</span>
          )}
        </div>
        <Button
          onClick={() => setStep("details")}
          disabled={!selectedRequestRecipients.length}
          className="h-[52px] w-full rounded-2xl bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function SelectedRecipientsRail({
  title,
  ariaLabel,
  recipients,
  recipientLabel,
  trailing,
}: {
  title: string;
  ariaLabel?: string;
  recipients: OneLocationRecipient[];
  recipientLabel: (recipient: OneLocationRecipient) => string;
  trailing?: ReactNode;
}) {
  if (!recipients.length) return null;

  const compact = recipients.length > 3;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-[13px] font-normal leading-[18px] text-muted-foreground">
          {title}
        </p>
        {trailing}
      </div>
      {compact ? (
        <div
          aria-label={ariaLabel ?? title}
          aria-roledescription="recipient summary"
          role="list"
          className="flex min-h-14 items-center gap-3 rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 shadow-[var(--app-card-shadow-standard)]"
        >
          <div className="flex shrink-0 -space-x-2" aria-hidden="true">
            {recipients.slice(0, 3).map((recipient) => {
              const label = recipientLabel(recipient);
              return (
                <span
                  key={recipient.userId}
                  className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-system-fill)] text-[13px] font-semibold text-muted-foreground"
                >
                  {initialsFrom(label)}
                </span>
              );
            })}
            <span className="flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-system-fill)] px-2 text-[13px] font-semibold text-muted-foreground">
              +{recipients.length - 3}
            </span>
          </div>
          <div className="min-w-0 flex-1 text-[17px] leading-[22px] text-foreground">
            {recipients.map((recipient) => (
              <span key={recipient.userId} className="sr-only">
                {recipientLabel(recipient)}
              </span>
            ))}
            <span aria-hidden="true">{recipients.length} people</span>
          </div>
        </div>
      ) : (
        <div
          aria-label={ariaLabel ?? title}
          aria-roledescription="recipient summary"
          role="list"
          className="divide-y divide-[color:var(--app-separator)] overflow-hidden rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]"
        >
          {recipients.map((recipient) => {
            const label = recipientLabel(recipient);
            return (
              <div
                key={recipient.userId}
                role="listitem"
                className="flex min-h-14 items-center gap-3 px-4 py-2.5"
              >
                <ContactAvatar label={label} className="h-8 w-8 text-[13px]" />
                <span className="min-w-0 flex-1 text-[17px] font-normal leading-[22px] text-foreground">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}
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
              <UserRoundPlus className="h-5 w-5" />
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

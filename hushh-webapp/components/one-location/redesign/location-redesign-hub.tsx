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
 * - The Location hub owns the visible tab strip directly under its module
 *   header. It still consumes the central registry so labels, destinations,
 *   selection, swipes, and deep links cannot drift from the shared top shell.
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
  Copy,
  Link2,
  MapPin,
  Pencil,
  Plus,
  Send,
  Share2,
  Check,
  ShieldCheck,
  Settings,
  UserRoundPlus,
  UsersRound,
  ChevronRight,
  X,
} from "lucide-react";

import {
  requestRecipientStatus,
  type RequestRecipientStatus,
} from "@/lib/one-location/request-recipient-status";
import { SmsTextIcon } from "@/components/one-location/redesign/sms-text-icon";
import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import {
  formatLocationDurationLabel,
  formatLocationRemaining,
  locationApproveActionLabel,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import {
  grantLaneLabel,
  groupGrantsByCounterpart,
  type OneLocationGrantLaneGroup,
} from "@/lib/one-location/grant-lanes";
import { parseTimestamp } from "@/lib/one-location/share-countdown";
import {
  resolveShareDurationHours,
  shareReplacementsLosingTime,
} from "@/lib/one-location/share-replacement";
import { ActionMenu } from "@/components/app-ui/action-menu";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TopShellTabs } from "@/components/app-ui/top-shell-tabs";
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
  ButtonLabel,
  FormLabel,
  MediumRowLabel,
  PageTitle,
  RowDescription,
  RowLabel,
  SectionLabel,
  TrailingValue,
} from "@/components/app-ui/typography";
import type {
  OneLocationAccessRequest,
  OneLocationCircleInvite,
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleEligibleConnectionsPage,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleMemberPage,
  OneLocationCircleOverview,
  OneLocationCircleKind,
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationRecipient,
  OneLocationShareDurationMode,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { locationStatusLabel } from "@/lib/one-location/location-readiness";
import {
  countSelectedCircleRecipients,
  isCircleSelectionFullySelected,
  type CircleRecipientSelection,
} from "@/lib/one-location/circle-recipient-selection";
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";
import { resolveOwnSmsSystemCircleId } from "@/lib/one-location/system-circles";

import {
  Avatar,
  EmptyState,
  SectionCard,
  StatusPill,
  TaskFlowHeader,
  TrustNoteCard,
} from "./primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";
import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { RequestCard, SharedWithMeCard, type GrantViewStatus } from "./cards";

export type { GrantViewStatus } from "./cards";
import {
  PersonShareLanes,
  ShareLanesDisclosure,
  useExpandedShareLanes,
} from "./share-lanes";
import {
  ShareReplacementConfirmDialog,
  ShareReplacementNotice,
  type ShareReplacementRow,
} from "./share-replacement-notice";
// LocationTypeSelector stays exported from ./selectors, unused for now, so
// PR #4767 can wire it back to a real precision mode without rebuilding it.
import {
  DurationSelector,
  PersonSearchInput,
  ReasonChips,
  type ReasonValue,
} from "./selectors";
import {
  CHANGE_TIME_DURATION_LADDER,
  REQUEST_DURATION_LADDER,
} from "./duration-presets";
import { approveShorterDurationOptions } from "@/lib/one-location/approve-duration-options";
import { AskForMoreTime, type RequestMoreTimeHours } from "./request-more-time";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import { ContactAvatar } from "@/components/one-location/redesign/contact-picker/atoms";
import {
  flattenRecipientSections,
  lastInteractionByUserId,
  sectionRecipients,
} from "@/lib/one-location/recipient-sections";
import { ROUTES, buildPersonProfileRoute } from "@/lib/navigation/routes";
import { circleMemberCountLabel } from "@/lib/one-location/circle-member-count";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { usePageEnterAnimation } from "@/lib/morphy-ux/hooks/use-page-enter";
import { resolveSmsContactsBackAction } from "@/lib/navigation/top-shell-breadcrumbs";
import {
  CircleDetailFlow,
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
const ASK_FLOW_DRAFT_STORAGE_KEY = "hushh:one-location:ask-draft";
const CONNECT_SEARCH_QUERY_PARAM = "q";
const CONNECT_RETURN_PARAM = "return_to";

export type LocationRequestSendResult = {
  sent: boolean;
  completed: boolean;
};

type AskFlowDraft = {
  search: string;
  selectedOwnerIds: string[];
  durationHours: string;
  requestMessage: string;
  reason: ReasonValue | null;
};

function readStoredAskFlowDraft(): AskFlowDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ASK_FLOW_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AskFlowDraft>;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      selectedOwnerIds: Array.isArray(parsed.selectedOwnerIds)
        ? parsed.selectedOwnerIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
      durationHours:
        typeof parsed.durationHours === "string" && parsed.durationHours
          ? parsed.durationHours
          : "1",
      requestMessage:
        typeof parsed.requestMessage === "string" ? parsed.requestMessage : "",
      reason:
        parsed.reason === "Safety check-in" ||
        parsed.reason === "Meeting nearby" ||
        parsed.reason === "Pick-up" ||
        parsed.reason === "Other"
          ? parsed.reason
          : null,
    };
  } catch {
    return null;
  }
}

function writeStoredAskFlowDraft(draft: AskFlowDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      ASK_FLOW_DRAFT_STORAGE_KEY,
      JSON.stringify(draft),
    );
  } catch {
    // Best effort: losing a draft is better than blocking the Ask flow.
  }
}

function clearStoredAskFlowDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ASK_FLOW_DRAFT_STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}

function askFlowConnectRecoveryHref(query: string): string {
  const params = new URLSearchParams();
  params.set("tab", "all");
  const trimmed = query.trim();
  if (trimmed) params.set(CONNECT_SEARCH_QUERY_PARAM, trimmed);
  params.set(
    CONNECT_RETURN_PARAM,
    `${ROUTES.ONE_LOCATION}?view=now&action=ask`,
  );
  return `${ROUTES.CONNECT}?${params.toString()}`;
}

function peopleConnectRecoveryHref(query: string): string {
  const params = new URLSearchParams();
  params.set("tab", "all");
  const trimmed = query.trim();
  if (trimmed) params.set(CONNECT_SEARCH_QUERY_PARAM, trimmed);
  params.set(CONNECT_RETURN_PARAM, `${ROUTES.ONE_LOCATION}?view=people`);
  return `${ROUTES.CONNECT}?${params.toString()}`;
}

function connectCirclesHref(): string {
  const params = new URLSearchParams();
  params.set("tab", "circles");
  params.set(CONNECT_RETURN_PARAM, `${ROUTES.ONE_LOCATION}?view=people`);
  return `${ROUTES.CONNECT}?${params.toString()}`;
}
function waitingResponsesLabel(count: number): string {
  return `Waiting for ${count} ${count === 1 ? "response" : "responses"}`;
}

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
   * and must not be told location is blocked.
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
   * General map visibility -- Ghost Mode, inverted. `false` is Ghost.
   *
   * This used to be documented as "whether this person appears as a pin on the
   * maps of people they already share with", and the server enforced exactly
   * that, which was the bug. It made an opt-in preference that defaults to
   * Ghost the last word over a share its owner had explicitly created for one
   * named person -- so private sharing did nothing at all until the sharer
   * found a switch nothing had told them about, and the recipient saw
   * "sharing with you" beside an empty map.
   *
   * It now governs the GENERAL audience only: people who have not been handed
   * a share of their own. A private grant is delivered to the person it names
   * in either state, because creating it was already the decision to be seen
   * by them. See `list_map_state` in the backend service and the Ghost row on
   * the immersive map sheet, which states the rule where it is switched.
   *
   * Null while the preference is still loading.
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
  recipientPageHasMore: boolean;
  recipientPageTotalCount: number;
  recipientPageLoading: boolean;
  onLoadMoreRecipients: () => void | Promise<void>;
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
  setSelectedRequestOwnerIds: (ids: string[]) => void;

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
  contactSyncSummary?: {
    matchedCount: number;
    connectedCount: number;
    unknownCount: number;
    partial: boolean;
  } | null;
  onViewContactSyncResults?: () => void;
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
  /** Reports whether any request reached the server, and whether all did. */
  onSendRequest: (
    reason?: string | null,
  ) => Promise<LocationRequestSendResult>;  onAskReshare: (grant: OneLocationGrant) => void;
  onApprove: (
    request: OneLocationAccessRequest,
    options?: {
      durationHoursOverride?: number;
      durationModeOverride?: OneLocationShareDurationMode;
    },
  ) => void | boolean | Promise<void | boolean>;
  onDeny: (requestId: string) => void | boolean | Promise<void | boolean>;
  /**
   * Take back a request YOU sent. Not `onDeny`, which is the owner refusing an
   * ask made of them -- these are opposite ends of the same request.
   */
  onWithdrawRequest: (requestId: string) => void;
  onViewGrant: (grant: OneLocationGrant) => void;
  onStopGrant: (grantId: string) => void;
  /** Grant currently showing the duration editor, or null. */
  editingGrantId: string | null;
  /**
   * Which amount is in flight, as `grantId:hours`.
   *
   * The pair, not the grant: a row shows four amounts and only the tapped one
   * spins. It replaced a `savingGrantId` that the retired absolute-duration
   * editor owned -- and that flag was deliberately never `revokingGrantId`,
   * because one flag for both made Save and Remove spin together and left Save
   * stuck spinning on the next Edit of the same person. The same rule holds
   * here: asking for more time must not disable the control that stops it.
   */
  requestingMoreTimeKey: string | null;
  onEditGrantStart: (grantId: string) => void;
  onEditGrantCancel: () => void;
  /**
   * Ask the owner for more of a share that is already live.
   *
   * Additive: `additionalHours` goes on TOP of what is left, which is what
   * `extendsGrantId` means to the server. See `redesign/request-more-time`,
   * which owns the amounts and is the only thing that calls this.
   */
  onRequestMoreTime: (params: {
    ownerUserId: string;
    grantId: string;
    ownerLabel: string;
    additionalHours: RequestMoreTimeHours;
  }) => Promise<void>;
  /*
   * The same edit, for the share you are giving rather than the one you are
   * receiving. It is separate state because it is a different consent: the
   * block above asks someone else for more of location, this one revises
   * your own, so it applies straight away and never turns into a request.
   */
  /** True while the live share card's inline time editor is open. */
  liveShareDurationEditing: boolean;
  /** Grant currently being edited in the owner's duration editor. */
  liveShareDurationGrantId: string | null;
  /** Wheel value, in decimal hours, or "until_stopped". */
  liveShareDurationHours: string;
  setLiveShareDurationHours: (v: string) => void;
  liveShareDurationSaving: boolean;
  onEditLiveShareDurationStart: (grantId?: string) => void;
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
  onLoadNamedCircleOverview: (
    circleId: string,
  ) => Promise<OneLocationCircleOverview>;
  onLoadNamedCircleMembersPage: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleMemberPage>;
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
    circle: OneLocationCircleOverview,
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
  onLoadNamedCircleEligibleConnectionsPage: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleEligibleConnectionsPage>;
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
    /** True when the caller already draws the card around the preview. */
    nested?: boolean,
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
      className="mt-1 block w-full whitespace-nowrap text-right font-[family-name:var(--font-app-body)] text-[13px] font-normal leading-[18px] tracking-[-0.01em] text-[color:var(--app-secondary-label)]"
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
      className="ml-auto flex min-h-[58px] w-[92px] shrink-0 flex-col items-end justify-center overflow-visible"
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
const FLOW_STEP_ONE_CLASSNAME =
  "mx-auto w-full max-w-[640px] space-y-5 pb-[calc(env(safe-area-inset-bottom)+1rem)]";
// The Send button on this step is pinned and carries its own chrome
// clearance, so this column reserves a reading gap and nothing more. A second
// reserve here is the empty band under the last card.
const FLOW_STEP_CONFIRM_CLASSNAME =
  "mx-auto w-full max-w-[560px] space-y-5 pb-[var(--app-page-content-bottom-gap,24px)]";
/**
 * The pinned action bar for a flow step.
 *
 * Measured, not reasoned about. `[data-app-scroll-root]` already carries
 * `padding-bottom: var(--app-scroll-bottom-pad)`, and a scroll container's
 * bottom padding lifts a `sticky bottom-0` child by that much -- so the bar
 * clears the tab bar and the "Talk to One" bar for free. Its own reserve is
 * only ever for what the scroll root has NOT accounted for.
 *
 * The on-screen keyboard is exactly that. `html.kb-open` hides the whole bottom
 * shell (globals.css) but does not shrink the reserve it left, so a keyboard
 * taller than that reserve eats the difference -- and on a step carrying a
 * message field, the button a person just reached for went under the keyboard
 * they were typing on. Subtracting the reserve rather than adding to it is what
 * keeps the bar from floating a tab bar's height too high the rest of the time.
 *
 * The floor is `--app-safe-area-bottom-effective`, for the routes where the
 * scroll root reserves nothing at all and the home indicator is the only thing
 * underneath.
 *
 * Held by e2e/one-location-flow-action-footer.layout.spec.ts. Keyboard
 * clearance here has been written twice and lost twice (#5698, then
 * `9d67a4f20`), because nothing failed when it went.
 */
const STICKY_FLOW_ACTION_CLASSNAME =
  "sticky bottom-0 z-20 -mx-1 bg-[linear-gradient(to_bottom,transparent,rgba(242,242,247,0.92)_24%,rgba(242,242,247,0.98))] px-1 pb-[calc(max(var(--kb-height,0px)-var(--app-scroll-bottom-pad,0px),var(--app-safe-area-bottom-effective,0px))+0.75rem)] pt-3 dark:bg-[linear-gradient(to_bottom,transparent,color-mix(in_srgb,var(--background)_92%,transparent)_24%,var(--background))]";

function selectedCountCopy(count: number, emptyCopy: string) {
  if (count <= 0) return emptyCopy;
  return `${count} selected`;
}

export function LocationRedesignHub({ vm }: { vm: LocationHubViewModel }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nearbyCheckInAvailable = isOneLocationNearbyCheckInAvailable();
  const nearbyPrivateCheckIn =
    searchParams.get(FLOW_ACTION_PARAM) === PRIVATE_CHECK_IN_ACTION &&
    searchParams.get(FLOW_SOURCE_PARAM) === NEARBY_CHECK_IN_SOURCE;
  // Editing emergency contacts from SOS is a detour, not a destination.
  //
  // "Edit contacts" opens ?action=sms-contacts&source=sos, which then
  // redirects to the SMS Circle -- and openCircleDetail pins the hub tab
  // to "people", because that is where circles live. Closing therefore
  // returned to the People tab and dropped the person out of the SOS flow
  // they were part-way through. The source param already rode along; only
  // the way back never read it. Mirrors nearbyPrivateCheckIn above.
  const editingSosContacts =
    searchParams.get(FLOW_ACTION_PARAM) === FLOW_TO_ACTION["circle-detail"] &&
    searchParams.get(FLOW_SOURCE_PARAM) === SOS_FLOW_SOURCE;
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
  const liveShareDurationTriggerRef = useRef<HTMLElement | null>(null);
  const openLiveShareDuration = (
    grantId: string | undefined,
    trigger: HTMLElement,
  ) => {
    liveShareDurationTriggerRef.current = trigger;
    vm.onEditLiveShareDurationStart(grantId);
  };
  const renderLocationSurface = (children: ReactNode) => (
    <LocationFeatureRoot
      vm={vm}
      liveShareDurationTriggerRef={liveShareDurationTriggerRef}
    >
      {children}
    </LocationFeatureRoot>
  );
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
   *
   * Must be YOUR OWN system Circle -- see resolveOwnSmsSystemCircleId.
   */
  const smsSystemCircleId = useMemo(
    () => resolveOwnSmsSystemCircleId(vm.circles),
    [vm.circles],
  );
  // Trusted can grow to thousands of auto-synced connections. It is a useful
  // provenance view, not a safe "select everyone" source for emergency SMS.
  // Ordinary and SMS Circles remain available for deliberate roster choices.
  const smsCircleChoices = useMemo(
    () => vm.circles.filter((circle) => circle.systemKind !== "trusted"),
    [vm.circles],
  );
  useEffect(() => {
    if (flow !== "sms-contacts" || !smsSystemCircleId) return;
    openCircleDetail(smsSystemCircleId, "replace");
  }, [flow, openCircleDetail, smsSystemCircleId]);

  const openShareFlow = useCallback(
    (initialRecipientId?: string) => {
      setShareStep(initialRecipientId ? "details" : "person");
      startShareComposer(initialRecipientId);
      openFlow("share");
    },
    [openFlow, startShareComposer],
  );

  const openAskFlowForPerson = useCallback(
    (initialRecipientId?: string) => {
      const recipientId = initialRecipientId?.trim();
      if (recipientId) {
        vm.setSelectedRequestOwnerIds([recipientId]);
      }
      openFlow("ask");
    },
    [openFlow, vm],  );

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
    return renderLocationSurface(
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
            circles={smsCircleChoices}
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
            onBack={() =>
              editingSosContacts ? openFlow("sos") : closeFlow("people")
            }
            onLoad={vm.onLoadNamedCircle}
            onLoadOverview={vm.onLoadNamedCircleOverview}
            onLoadMembersPage={vm.onLoadNamedCircleMembersPage}
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
            onLoadEligibleConnectionsPage={
              vm.onLoadNamedCircleEligibleConnectionsPage
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
            onRequestLocation={() => openFlow("ask")}
            onStartShare={() => {
              vm.clearNamedCircleShareContext();
              openShareFlow();
            }}
            onEditLiveShareDurationStart={openLiveShareDuration}
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
      </div>,
    );
  }

  /* ----------------------------------------------------------------- */
  /* Hub (Now | People | Links)                                        */
  /* ----------------------------------------------------------------- */
  return renderLocationSurface(
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title={<PageTitle as="span">Location</PageTitle>}
        leading={<LocationHeaderIconTile />}
        accent="location"
        titleRole="agent"
        actionsInlineMobile
        actions={<LocationHeaderActions vm={vm} />}
        className="[&>div:first-child]:!gap-3.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center"
      />

      <TopShellTabs
        tabSet={{
          ...LOCATION_TAB_DEFINITION,
          activeValue: tab,
        }}
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
              onEditLiveShareDurationStart={openLiveShareDuration}
              onStartShare={() => {
                vm.clearNamedCircleShareContext();
                openShareFlow();
              }}
              onOpenMap={() => router.push(ROUTES.ONE_LOCATION_MAP)}
              // The app's own Location settings, not the OS permission
              // screen. This tile carries voiceActionId
              // "location.open_settings", a route action to
              // ?action=settings -- so asking for it by voice already
              // opened the right screen while tapping it left the app
              // entirely. onOpenLocationSettings stays where it belongs:
              // the permission recovery cards, whose whole job is sending
              // someone to the OS to grant access.
              onOpenSettings={() => openFlow("settings")}
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
              onOpenCircleManager={() => router.push(connectCirclesHref())}
              focusedInviteId={focusedCircleMemberInviteId}
              onDismissFocusedInvite={dismissFocusedCircleMemberInvite}
              onStartShare={openShareFlow}
              onStartAsk={openAskFlowForPerson}
              onOpenActiveShares={() => openFlow("active-shares")}
              onOpenSharedWithMe={() => openFlow("shared-with-me")}
            />
          </LocationHubPanel>

          <LocationHubPanel>
            <LinksHub vm={vm} />
          </LocationHubPanel>
        </SwipeViews>
      </div>
    </div>,
  );
}

function LocationFeatureRoot({
  vm,
  liveShareDurationTriggerRef,
  children,
}: {
  vm: LocationHubViewModel;
  liveShareDurationTriggerRef: { current: HTMLElement | null };
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <LiveShareDurationDialog
        vm={vm}
        triggerRef={liveShareDurationTriggerRef}
      />
    </>
  );
}

function LiveShareDurationDialog({
  vm,
  triggerRef,
}: {
  vm: LocationHubViewModel;
  triggerRef: { current: HTMLElement | null };
}) {
  const grant = vm.liveShareDurationGrantId
    ? vm.activeOwnerGrants.find(
        (candidate) => candidate.id === vm.liveShareDurationGrantId,
      )
    : vm.liveShare?.stoppableGrantId
      ? vm.activeOwnerGrants.find(
          (candidate) => candidate.id === vm.liveShare?.stoppableGrantId,
        )
      : null;
  const title =
    grant?.durationMode === "until_stopped"
      ? "Set an end time"
      : "Change end time";

  return (
    <Dialog
      modal
      open={Boolean(grant && vm.liveShareDurationEditing)}
      onOpenChange={(open) => {
        if (!open && !vm.liveShareDurationSaving) {
          vm.onEditLiveShareDurationCancel();
        }
      }}
    >
      <DialogContent
        className="max-w-[min(420px,calc(100%-2rem))] gap-4 rounded-[24px] p-4 sm:max-w-[420px]"
        showCloseButton={!vm.liveShareDurationSaving}
        srDescription="Choose how long this live location share should continue."
        aria-modal="true"
        aria-busy={vm.liveShareDurationSaving}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = triggerRef.current;
          triggerRef.current = null;
          if (trigger?.isConnected) trigger.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (vm.liveShareDurationSaving) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (vm.liveShareDurationSaving) event.preventDefault();
        }}
      >
        <DialogHeader className="gap-1 text-left">
          <DialogTitle className="text-[20px] font-semibold leading-[25px] text-[color:var(--app-primary-label)]">
            {title}
          </DialogTitle>
        </DialogHeader>
        <LiveShareDurationEditor
          value={vm.liveShareDurationHours}
          onChange={vm.setLiveShareDurationHours}
          onCancel={vm.onEditLiveShareDurationCancel}
          onSave={vm.onSaveLiveShareDuration}
          saving={vm.liveShareDurationSaving}
          surface={false}
        />
      </DialogContent>
    </Dialog>
  );
}

const LOCATION_GROUP_SURFACE =
  "overflow-hidden rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] shadow-[var(--app-card-shadow-standard)] ring-1 ring-inset ring-[color:var(--app-separator)] dark:shadow-none";

const LOCATION_GROUP_SHELL_CLASSNAME =
  "[--settings-group-radius:var(--app-radius-md)] !rounded-[var(--app-radius-md)] !bg-[color:var(--app-primary-surface)] !shadow-[var(--app-card-shadow-standard)] ring-1 ring-inset ring-[color:var(--app-separator)] dark:!shadow-none";

const LOCATION_INTERACTIVE_SURFACE =
  "bg-[color:var(--app-primary-surface)] shadow-[var(--app-card-shadow-standard)] ring-1 ring-inset ring-[color:var(--app-separator)] dark:shadow-none";

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
  onEditLiveShareDurationStart,
  onStartShare,
  onCheckIn,
  onSos,
  onOpenMap,
  onOpenSettings,
  onOpenActiveShares,
  onOpenSharedWithMe,
  onOpenNeedsReview,
  onRequestLocation,
}: {
  vm: LocationHubViewModel;
  onEditLiveShareDurationStart: (
    grantId: string | undefined,
    trigger: HTMLElement,
  ) => void;
  onStartShare: () => void;
  onCheckIn: () => void;
  onSos: () => void;
  onOpenMap: () => void;
  onOpenSettings: () => void;
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
            vm.liveShare.grantCount === 1 && vm.liveShare.stoppableGrantId
              ? () => vm.onStopGrant(vm.liveShare?.stoppableGrantId ?? "")
              : undefined
          }
          stopBusy={
            vm.liveShare.grantCount === 1 &&
            Boolean(vm.liveShare.stoppableGrantId) &&
            vm.revokingGrantId === vm.liveShare.stoppableGrantId
          }
          // Same gate as Stop, for the same reason: with several shares
          // running there is no single one for "change time" to mean.
          onChangeDuration={
            vm.liveShare.grantCount === 1 &&
            vm.liveShare.stoppableGrantId &&
            !vm.liveShare.singleGrantIsSms
              ? (trigger) =>
                  onEditLiveShareDurationStart(
                    vm.liveShare?.stoppableGrantId ?? undefined,
                    trigger,
                  )
              : undefined
          }
          onShareMore={onStartShare}
          onEnded={vm.onLiveShareEnded}
        />
      ) : null}
      {!vm.liveShare ? (
        <LocationNowStatePanel
          blocked={vm.locationBlocked}
          busy={vm.locationAcquiring}
          onPrimaryAction={
            vm.locationBlocked ? vm.onOpenLocationSettings : onStartShare
          }
          onRequestLocation={onRequestLocation}
          onCheckIn={onCheckIn}
          onSos={onSos}
          onOpenMap={onOpenMap}
          onOpenSettings={onOpenSettings}
        />
      ) : null}

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
      className={LOCATION_GROUP_SURFACE}
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
      className="group flex min-h-14 w-full cursor-pointer items-center justify-between border-b border-[color:var(--app-separator)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[color:var(--app-secondary-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]"
    >
      <span className="flex min-w-0 items-center gap-3">
        {leading}
        <RowLabel as="span" className="min-w-0">
          {title}
        </RowLabel>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {typeof trailingValue === "number" ? (
          <TrailingValue as="span" className="min-w-4 text-right">
            {trailingValue}
          </TrailingValue>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-[color:var(--app-tertiary-label)] transition-transform group-active:translate-x-0.5"
        />
      </span>
    </button>
  );
}

function LocationNowStatePanel({
  blocked,
  busy,
  onPrimaryAction,
  onRequestLocation,
  onCheckIn,
  onSos,
  onOpenMap,
  onOpenSettings,
}: {
  blocked: boolean;
  busy: boolean;
  onPrimaryAction: () => void;
  onRequestLocation: () => void;
  onCheckIn: () => void;
  onSos: () => void;
  onOpenMap: () => void;
  onOpenSettings: () => void;
}) {
  const stateLabel = blocked ? "Location unavailable" : "Private";
  const headline = blocked
    ? "Location access is off"
    : "No one can see your location";
  const support = blocked
    ? "Turn it on to share your location."
    : "Share only when you choose.";
  const primaryLabel = blocked ? "Turn on Location" : "Share my location";
  const primaryVoiceControlId = blocked
    ? "one-location-action-location-settings"
    : "one-location-action-share";
  const primaryVoiceActionId = blocked
    ? "location.open_settings"
    : "location.open_share";

  return (
    <section
      aria-label={blocked ? "Location access" : "Location sharing status"}
      data-testid="one-location-now-primary"
      data-now-state={blocked ? "unavailable" : "private"}
      className={cn(
        LOCATION_INTERACTIVE_SURFACE,
        "mx-auto w-full max-w-[720px] rounded-[20px] px-5 py-7 text-center sm:px-8 sm:py-8",
      )}
    >
      <p
        data-ui-contract="required-copy"
        data-ui-id="location-now-state"
        className="text-[13px] font-semibold uppercase leading-4 tracking-[0.06em] text-[color:var(--app-secondary-label)]"
      >
        {stateLabel}
      </p>
      <h2
        data-ui-contract="required-copy"
        data-ui-id="location-now-headline"
        data-ui-truncation="forbid"
        className="mx-auto mt-2 max-w-[440px] text-[28px] font-semibold leading-[34px] tracking-normal text-[color:var(--app-primary-label)]"
      >
        {headline}
      </h2>
      <p
        data-ui-contract="required-copy"
        data-ui-id="location-now-support"
        className="mx-auto mt-2 max-w-[360px] text-[16px] font-normal leading-[22px] text-[color:var(--app-secondary-label)]"
      >
        {support}
      </p>

      <div className="mx-auto mt-6 grid w-full max-w-[440px] gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          data-voice-control-id={primaryVoiceControlId}
          data-voice-action-id={primaryVoiceActionId}
          data-voice-label={primaryLabel}
          aria-label={primaryLabel}
          onClick={onPrimaryAction}
          disabled={busy}
          className="inline-flex min-h-[50px] w-full items-center justify-center rounded-[14px] bg-[color:var(--app-accent)] px-5 text-[color:var(--app-accent-fg)] transition-[background-color,transform] [-webkit-tap-highlight-color:transparent] hover:bg-[color:var(--app-accent-hover)] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          <ButtonLabel as="span">{primaryLabel}</ButtonLabel>
        </button>
        <button
          type="button"
          data-testid="one-location-request-row"
          data-voice-control-id="one-location-action-ask"
          data-voice-action-id="location.open_ask"
          data-voice-label="Ask for location"
          aria-label="Ask for location"
          onClick={onRequestLocation}
          className="inline-flex min-h-[48px] w-full items-center justify-center rounded-[14px] bg-[color:var(--app-secondary-surface)] px-5 text-[color:var(--app-primary-label)] ring-1 ring-inset ring-[color:var(--app-separator)] transition-[background-color,transform] [-webkit-tap-highlight-color:transparent] hover:bg-[color:var(--app-neutral-fill)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          <ButtonLabel as="span">Ask for location</ButtonLabel>
        </button>
      </div>

      <div className="mx-auto mt-5 w-full max-w-[440px]">
        <LocationNowMoreActions
          onCheckIn={onCheckIn}
          onSos={onSos}
          onOpenMap={onOpenMap}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </section>
  );
}

function LocationNowMoreActions({
  onCheckIn,
  onSos,
  onOpenMap,
  onOpenSettings,
}: {
  onCheckIn: () => void;
  onSos: () => void;
  onOpenMap: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <ActionMenu
      label="More actions"
      title="More actions"
      testId="one-location-now-more"
      trigger={
        <button
          type="button"
          data-testid="one-location-now-more"
          aria-label="More actions"
          className="flex min-h-[50px] w-full items-center justify-between rounded-[14px] bg-transparent px-1 text-left text-[color:var(--app-primary-label)] transition-colors hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          <span className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-[color:var(--app-secondary-label)]"
            >
              <Plus className="h-4 w-4" />
            </span>
            <RowLabel as="span" className="min-w-0">
              More actions
            </RowLabel>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-[color:var(--app-tertiary-label)]"
          />
        </button>
      }
      items={[
        {
          id: "arrival-confirm",
          label: "Arrival confirm",
          icon: Check,
          onSelect: onCheckIn,
          voiceControlId: "one-location-action-check-in",
          voiceActionId: "location.open_check_in",
        },
        {
          id: "save-my-soul",
          label: "Save My Soul",
          icon: ShieldCheck,
          onSelect: onSos,
          voiceControlId: "one-location-action-sos",
          voiceActionId: "location.open_sos",
        },
        {
          id: "map",
          label: "Map",
          icon: MapPin,
          onSelect: onOpenMap,
          voiceControlId: "one-location-action-map",
          voiceActionId: "location.open_map",
        },
        {
          id: "settings",
          label: "Settings",
          icon: Settings,
          onSelect: onOpenSettings,
          voiceControlId: "one-location-action-settings",
          voiceActionId: "location.open_settings",
        },
      ]}
    />
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
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[color:var(--app-secondary-surface)] text-[color:var(--app-secondary-label)]"
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
  onStartShare,
  onEditLiveShareDurationStart,
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
  /** Opens the share composer AND its flow. Seeding the composer alone
   *  leaves the person on the same screen with nothing visibly changed. */
  onStartShare?: () => void;
  onEditLiveShareDurationStart: (grantId: string, trigger: HTMLElement) => void;
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
      title: "Manage sharing",
      description:
        ownerGrantGroups.length === 1
          ? "1 person can see your location."
          : `${ownerGrantGroups.length} people can see your location.`,
    },
    "shared-with-me": {
      title: "Shared with me",
      description: "People sharing location with you.",
    },
    "needs-review": {
      title: "Needs review",
      description: "Nothing is shared until you approve.",
    },
  }[kind];

  return (
    <div className="space-y-5" data-testid={`one-location-${kind}`}>
      <TaskFlowHeader title={copy.title} description={copy.description} />
      {kind === "active-shares" ? (
        ownerGrantGroups.length ? (
          <SettingsGroup separatorInset>
            {ownerGrantGroups.map((group) => {
              const name = vm.grantRecipientLabel(group.primaryGrant);
              const single =
                group.grants.length === 1 ? group.primaryGrant : null;
              return (
                <SettingsRow
                  key={group.counterpartUserId}
                  leading={
                    <ActiveShareAvatar
                      name={name}
                      photoUrl={group.primaryGrant.recipientPhotoUrl}
                    />
                  }
                  title={name}
                  description={
                    single ? (
                      <div className="space-y-1">
                        <ActiveShareMetadata grant={single} />
                        {!isSmsTriggeredGrant(single) ? (
                          <button
                            type="button"
                            className="min-h-8 text-[15px] font-medium text-[color:var(--app-accent)]"
                            onClick={(event) =>
                              onEditLiveShareDurationStart(
                                single.id,
                                event.currentTarget,
                              )
                            }
                          >
                            {single.durationMode === "until_stopped"
                              ? "Set end time"
                              : "Change time"}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <span>{`${group.grants.length} active shares`}</span>
                        <div className="pt-1.5">
                          <PersonShareLanes
                            group={group}
                            counterpartName={name}
                            onStopGrant={vm.onStopGrant}
                            onChangeEndTime={onEditLiveShareDurationStart}
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
                    ) : null
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
                // startShareComposer alone only seeds the draft -- it never
                // opened the flow, so this button did nothing at all.
                onClick={() =>
                  onStartShare ? onStartShare() : vm.startShareComposer()
                }
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
                    photoUrl={grant.ownerPhotoUrl}
                    statusLine={
                      multiLane ? (
                        `${group.grants.length} live shares`
                      ) : (
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
                          // SharedWithMeCard already draws and clips the card
                          // around this preview.
                          true,
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
            description="Ask someone to share location."
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
                  photoUrl={request.requesterPhotoUrl}
                  // The amount, and whether it is extra time on a share already
                  // running. Every card used to read "Asks to see your location"
                  // whether the person wanted fifteen minutes or another day.
                  promptLine={locationAskPromptLine(request, vm.nowMs)}
                  reason={request.message ?? undefined}
                  approveLabel={locationApproveActionLabel(request, vm.nowMs)}
                  onApprove={() => vm.onApprove(request)}
                  // Every amount below what was asked, rather than the single
                  // hard-coded "Allow 1 hour" this replaced -- which was not a
                  // choice, and which disappeared entirely for anything asked
                  // at an hour or less. Reported as "if i want to edit the
                  // time, and want to approve req for shorter duration i am
                  // not allowed to do so".
                  //
                  // `durationModeOverride: "timed"` on every one of them, and
                  // that matters most on an `until_stopped` ask: naming an
                  // amount is exactly how an owner answers "forever?" with
                  // "two hours".
                  shorterApprovals={approveShorterDurationOptions(request)}
                  // An extension ADDS the approved amount to the share still
                  // running, so the rungs above are increments and have to say
                  // so -- the same word the primary button already uses.
                  isExtension={Boolean(
                    request.isExtension || request.extendsGrantId,
                  )}
                  onApproveShorter={(hours) =>
                    vm.onApprove(request, {
                      durationHoursOverride: hours,
                      durationModeOverride: "timed",
                    })
                  }
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
  if (scope.kind === "circle") return `circle:${scope.circleId}`;
  if (scope.kind === "circles") {
    // Sorted: two picks of the same Circles in a different tap order are the
    // same scope, not two different ones the equality check would miss.
    return `circles:${[...scope.circleIds].sort().join(",")}`;
  }
  return "all_contacts";
}

function autoApproveScopeEqual(
  left: AutoApproveScope | null,
  right: AutoApproveScope | null,
): boolean {
  return autoApproveScopeKey(left) === autoApproveScopeKey(right);
}

/** The Circle ids a scope covers, regardless of whether it is the original
 * single-Circle shape or the multi-Circle one -- one read path for both. */
function autoApproveScopeCircleIds(scope: AutoApproveScope | null): string[] {
  if (scope?.kind === "circle") return [scope.circleId];
  if (scope?.kind === "circles") return scope.circleIds;
  return [];
}

/** Toggle one Circle in/out of a scope's selection, collapsing to `null`
 * (no scope) rather than an empty "circles" scope when the last one clears. */
function toggleAutoApproveCircle(
  scope: AutoApproveScope | null,
  circleId: string,
): AutoApproveScope | null {
  const current = autoApproveScopeCircleIds(scope);
  const next = current.includes(circleId)
    ? current.filter((id) => id !== circleId)
    : [...current, circleId];
  return next.length ? { kind: "circles", circleIds: next } : null;
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
  // Only Circles the person still owns count -- one may have been deleted
  // since the rule was saved, and a stale id must not draw a blank row.
  const activeCircles = useMemo(() => {
    const ids = new Set(autoApproveScopeCircleIds(autoApproveScope));
    return ownedCircles.filter((circle) => ids.has(circle.id));
  }, [autoApproveScope, ownedCircles]);
  const activeScope =
    autoApproveScope?.kind === "all_contacts"
      ? autoApproveScope
      : activeCircles.length
        ? autoApproveScope
        : null;
  const activeScopeLabel = !vm.autoApproveRequestsEnabled
    ? "Choose a Circle or all contacts."
    : activeScope?.kind === "all_contacts"
      ? "All contacts"
      : activeCircles.length === 1
        ? (activeCircles[0]?.name ?? "Choose another scope.")
        : activeCircles.length > 1
          ? `${activeCircles.length} Circles`
          : "Choose another scope.";
  const primaryScopeAction = vm.autoApproveRequestsEnabled ? "Save" : "Turn on";
  const allContactsScope = useMemo<AutoApproveScope>(
    () => ({ kind: "all_contacts" }),
    [],
  );
  const draftCircleIds = useMemo(
    () => autoApproveScopeCircleIds(draftScope),
    [draftScope],
  );
  const draftCircles = useMemo(
    () => ownedCircles.filter((circle) => draftCircleIds.includes(circle.id)),
    [ownedCircles, draftCircleIds],
  );
  const allDraftCirclesSelected =
    ownedCircles.length > 0 &&
    draftCircleIds.length === ownedCircles.length &&
    ownedCircles.every((circle) => draftCircleIds.includes(circle.id));
  const toggleAllDraftCircles = useCallback(() => {
    setDraftScope(
      allDraftCirclesSelected
        ? null
        : ownedCircles.length
          ? { kind: "circles", circleIds: ownedCircles.map((circle) => circle.id) }
          : null,
    );
  }, [allDraftCirclesSelected, ownedCircles]);

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
    <div className="mx-auto w-full max-w-[640px] space-y-6 pb-[max(20px,env(safe-area-inset-bottom))]">
      {/* No header description. Each row below already says what it does, and
          the line that used to sit here ("Control live sharing") describes
          something this screen's first control no longer does. */}
      <TaskFlowHeader title="Settings" />

      <LocationSettingSection title="Automatic approval">
        <SettingsGroup
          embedded
          separatorInset
          shellClassName="[--settings-group-radius:16px] shadow-none"
          className="[--settings-row-description-gap:2px] [--type-row-description-size:13px] [--type-row-description-line:18px]"
        >
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
            className="[--settings-row-px:16px] [--settings-row-py:14px]"
            testId="one-location-auto-approve-row"
          />
        </SettingsGroup>
      </LocationSettingSection>

      <LocationSettingSection title="Safety">
        <SettingsGroup
          embedded
          separatorInset
          shellClassName="[--settings-group-radius:16px] shadow-none"
        >
          <SettingsRow
            title="Emergency contacts"
            trailing={
              <TrailingValue as="span">{smsContactCount}</TrailingValue>
            }
            onClick={onManageSmsContacts}
            chevron
            density="compact"
            className="[--settings-row-px:16px]"
            testId="one-location-sms-contacts-entry"
          />
        </SettingsGroup>
      </LocationSettingSection>

      <div>
        <SavedLocationsSection />
      </div>

      <Dialog open={scopeSheetOpen} onOpenChange={setScopeSheetOpen}>
        <DialogContent
          className="max-w-[min(420px,calc(100vw-32px))] gap-5 rounded-[24px] p-5 sm:p-6"
          showCloseButton={false}
        >
          <DialogHeader className="gap-1 text-left">
            <DialogTitle className="ui-text-card-title">
              Auto-approve for
            </DialogTitle>
            <DialogDescription className="ui-text-page-subtitle">
              All contacts, or any combination of your Circles.
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
                <div className="flex items-center justify-between gap-3 px-1">
                  <SectionLabel as="p">Circles</SectionLabel>
                  <button
                    type="button"
                    onClick={toggleAllDraftCircles}
                    className="press-scale text-[13px] font-semibold text-[color:var(--app-accent)]"
                  >
                    {allDraftCirclesSelected ? "Clear all" : "Select all"}
                  </button>
                </div>
                <div className="overflow-hidden rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] ring-1 ring-[color:var(--app-separator)]">
                  {ownedCircles.map((circle) => (
                    <AutoApproveScopeOption
                      key={circle.id}
                      title={circle.name}
                      description={scopeMemberCountLabel(circle.memberCount)}
                      selected={draftCircleIds.includes(circle.id)}
                      onSelect={() =>
                        setDraftScope((current) =>
                          toggleAutoApproveCircle(current, circle.id),
                        )
                      }
                      multi
                      inset
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {draftScope ? (
            <p className="ui-text-helper-text">
              {draftScope.kind === "all_contacts"
                ? "New requests from current and future contacts will be approved automatically."
                : draftCircles.length === 1
                  ? `New requests from current and future members of ${draftCircles[0]?.name ?? "this Circle"} will be approved automatically.`
                  : `New requests from current and future members of these ${draftCircles.length} Circles will be approved automatically.`}{" "}
              Requests already waiting still need your answer.
            </p>
          ) : (
            <p className="ui-text-helper-text">
              Requests already waiting still need your answer.
            </p>
          )}

          <DialogFooter className="gap-2 sm:flex-col sm:justify-start">
            <Button
              type="button"
              className="h-12 rounded-full"
              disabled={!draftScope}
              onClick={commitAutoApproveScope}
            >
              <ButtonLabel as="span">{primaryScopeAction}</ButtonLabel>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 rounded-full"
              onClick={() => setScopeSheetOpen(false)}
            >
              <ButtonLabel as="span">Cancel</ButtonLabel>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LocationSettingSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="w-full">
      <SectionLabel as="p" className="mb-2 px-[6px]">
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

function AutoApproveScopeOption({
  title,
  description,
  selected,
  onSelect,
  inset = false,
  multi = false,
}: {
  title: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  inset?: boolean;
  /** Checkbox semantics (independently toggled, several may be selected)
   * instead of the default radio semantics (picking one clears the rest). */
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
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
        <MediumRowLabel as="span" className="block truncate">
          {title}
        </MediumRowLabel>
        {description ? (
          <RowDescription as="span" className="block truncate">
            {description}
          </RowDescription>
        ) : null}
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center border transition-colors",
          multi ? "rounded-[7px]" : "rounded-full",
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

function ActiveShareAvatar({
  name,
  photoUrl,
}: {
  name: string;
  photoUrl?: string | null;
}) {
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center">
      <Avatar initials={personInitials(name)} imageUrl={photoUrl} size={40} />
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
        <ShareCountdownText expiresAt={grant.expiresAt} className="truncate" />
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

/** One person in the People list: avatar (+ live dot) · name · status · direct action. */
function PersonRow({
  name,
  photoUrl,
  verified,
  subtitle,
  active,
  first,
  action,
  expansion,
  profileHref,
  onOpen,
}: {
  name: string;
  photoUrl?: string | null;
  verified?: boolean;
  subtitle: string | null;
  /** When this person has a request profile, the name opens it. */
  profileHref?: string | null;
  /** True when there's a live connection (you're sharing or they're sharing). */
  active: boolean;
  first: boolean;
  action?: ReactNode;
  /**
   * The row's per-share breakdown, when this person holds more than one live
   * share. Rendered under the row so the main line keeps one clear action.
   */
  expansion?: ReactNode;
  onOpen?: () => void;
}) {
  const ariaLabel = subtitle
    ? `Open Location actions for ${name}. ${subtitle}`
    : `Open Location actions for ${name}`;
  const content = (
    <>
      <div className="relative shrink-0">
        <ConnectionPersonAvatar
          label={name}
          photoUrl={photoUrl}
          verified={verified}
          className="h-10 w-10 text-[13px]"
        />
        {active ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute h-3 w-3 rounded-full border-2 border-[color:var(--app-primary-surface)] bg-[color:var(--app-success)]",
              verified ? "-right-0.5 -top-0.5" : "bottom-0 right-0",
            )}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-start gap-1.5">
          {profileHref ? (
            <Link
              href={profileHref}
              className="min-w-0 flex-1 break-words text-left text-[17px] font-medium leading-[22px] tracking-[-0.3px] text-foreground underline-offset-4 hover:underline"
              aria-label={`Open profile: ${name}`}
              data-testid="one-location-person-profile-link"
            >
              {name}
            </Link>
          ) : (
            <p className="min-w-0 flex-1 break-words text-[17px] font-medium leading-[22px] tracking-[-0.3px] text-foreground">
              {name}
            </p>
          )}
        </div>
        {subtitle ? (
          <p className="break-words text-[13px] font-normal leading-[18px] tracking-[-0.2px] text-[color:var(--app-secondary-label)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="shrink-0">{action}</div>
      ) : onOpen && profileHref ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={ariaLabel}
          className="flex h-11 w-11 shrink-0 items-center justify-end text-[color:var(--app-tertiary-label)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : onOpen ? (
        <ChevronRight
          className="h-4 w-4 shrink-0 text-[color:var(--app-tertiary-label)]"
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  return (
    <div
      className={cn(
        "relative transition-colors motion-reduce:transition-none",
        !first &&
          "before:absolute before:left-16 before:right-4 before:top-0 before:h-px before:bg-[color:var(--app-separator)] before:content-['']",
        "[@media(hover:hover)]:hover:bg-[color:var(--app-neutral-fill)]",
      )}
    >
      {onOpen && !profileHref ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={ariaLabel}
          className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2 sm:min-h-16"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5 sm:min-h-16">
          {content}
        </div>
      )}
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

function isGenericConnectionCopy(value: string): boolean {
  return (
    value === "Ready for private location sharing" ||
    /^in your contacts$/i.test(value) ||
    /existing trust or sharing history/i.test(value)
  );
}

type PeopleDirectoryStatus = {
  label: string | null;
  active: boolean;
  kind: "both" | "outgoing" | "incoming" | "pending" | "neutral";
};

function shareGroupStatusLabel({
  group,
  countdownLabel,
  incoming,
}: {
  group: OneLocationGrantLaneGroup;
  countdownLabel: (value?: string | null) => string,
  incoming?: boolean;
}): string {
  if (group.grants.length > 1) {
    return `${group.grants.length} active shares`;
  }
  const grant = group.primaryGrant;
  const left =
    grant.durationMode === "until_stopped"
      ? incoming
        ? "Until they stop"
        : "Until you stop"
      : countdownAsLeft(countdownLabel(grant.expiresAt));
  const prefix = incoming
    ? "Sharing with you"
    : isSmsTriggeredGrant(grant)
      ? "Save My Soul"
      : "You’re sharing";
  return left ? `${prefix} · ${left}` : prefix;
}

function peopleDirectoryStatus(input: {
  outgoingGroup: OneLocationGrantLaneGroup | null;
  incomingGroup: OneLocationGrantLaneGroup | null;
  pendingRequest: OneLocationAccessRequest | null;
  countdownLabel: (value?: string | null) => string;
}): PeopleDirectoryStatus {
  const { outgoingGroup, incomingGroup, pendingRequest, countdownLabel } = input;
  if (outgoingGroup && incomingGroup) {
    return { label: "Sharing both ways", active: true, kind: "both" };
  }
  if (outgoingGroup) {
    return {
      label: shareGroupStatusLabel({ group: outgoingGroup, countdownLabel }),
      active: true,
      kind: "outgoing",
    };
  }
  if (incomingGroup) {
    return {
      label: shareGroupStatusLabel({
        group: incomingGroup,
        countdownLabel,
        incoming: true,
      }),
      active: true,
      kind: "incoming",
    };
  }
  if (pendingRequest) {
    return { label: "Waiting for response", active: false, kind: "pending" };
  }
  return { label: null, active: false, kind: "neutral" };
}

function personalCircleSummary(circles: readonly OneLocationCircleSummary[]) {
  const personal = circles.filter(
    (circle) => circle.systemKind == null && !Boolean(circle.isSystem),
  );
  const created = personal.filter((circle) => circle.role === "owner").length;
  const joined = personal.filter((circle) => circle.role === "member").length;
  return { personal, created, joined };
}

function personalCircleCountLabel({
  created,
  joined,
}: {
  created: number;
  joined: number;
}): string {
  const parts: string[] = [];
  if (created) parts.push(`${created} created`);
  if (joined) parts.push(`${joined} joined`);
  return parts.length ? parts.join(" · ") : "Create or join a Circle";
}

function circleInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function circleFlowErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function CircleIdentityStack({
  circles,
}: {
  circles: readonly OneLocationCircleSummary[];
}) {
  const visible = circles.slice(0, 3);
  const fallback = visible.length
    ? visible
    : [
        {
          id: "circle-summary-fallback",
          name: "Circles",
          memberCount: 0,
        } as OneLocationCircleSummary,
      ];
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-[54px] shrink-0 items-center"
    >
      {fallback.map((circle, index) => {
        const isSmsCircle = circle.systemKind === "sms";
        const isTrustedCircle = circle.systemKind === "trusted";
        const initials = circleInitials(circle.name);
        return (
          <span
            key={`${circle.id}-${index}`}
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border-2 border-[color:var(--app-primary-surface)] text-[13px] font-semibold shadow-sm",
              index > 0 && "-ml-6",
              isSmsCircle
                ? "bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]"
                : "bg-[#E5E5EA] text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#F2F2F7]",
            )}
          >
            {isSmsCircle ? (
              <SmsTextIcon className="text-[10px] font-bold tracking-[-0.2px]" />
            ) : isTrustedCircle ? (
              <ShieldCheck className="h-[17px] w-[17px]" />
            ) : initials ? (
              initials
            ) : (
              <UsersRound className="h-[17px] w-[17px]" />
            )}
          </span>
        );
      })}
    </span>
  );
}

function CircleSummaryGroup({
  circles,
  invitationCount,
  onOpenCircles,
  onOpenInvitations,
}: {
  circles: readonly OneLocationCircleSummary[];
  invitationCount: number;
  onOpenCircles: () => void;
  onOpenInvitations: () => void;
}) {
  const { personal, created, joined } = personalCircleSummary(circles);
  const summary = personalCircleCountLabel({ created, joined });
  const invitationTitle =
    invitationCount === 1 ? "Circle invitation" : "Circle invitations";
  return (
    <div
      className={LOCATION_GROUP_SURFACE}
      data-testid="one-location-circles-summary"
    >
      <button
        type="button"
        onClick={onOpenCircles}
        aria-label={`Circles, ${summary.replace(" · ", " and ")}`}
        className={cn(
          "grid min-h-[68px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left outline-none transition-colors motion-reduce:transition-none",
          "focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2",
          "[@media(hover:hover)]:hover:bg-[color:var(--app-neutral-fill)]",
        )}
      >
        <CircleIdentityStack circles={personal.length ? personal : circles} />
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold leading-[22px] tracking-[-0.3px] text-foreground">
            Circles
          </span>
          <span className="mt-0.5 block text-[13px] font-normal leading-[18px] tracking-[-0.2px] text-[color:var(--app-secondary-label)]">
            {summary}
          </span>
        </span>
        <ChevronRight
          className="h-4 w-4 text-[color:var(--app-tertiary-label)]"
          aria-hidden="true"
        />
      </button>
      {invitationCount > 0 ? (
        <button
          type="button"
          onClick={onOpenInvitations}
          aria-label={`${invitationTitle}, ${invitationCount} pending`}
          className={cn(
            "relative grid min-h-[56px] w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors motion-reduce:transition-none",
            "before:absolute before:left-4 before:right-4 before:top-0 before:h-px before:bg-[color:var(--app-separator)] before:content-['']",
            "focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] focus-visible:ring-offset-2",
            "[@media(hover:hover)]:hover:bg-[color:var(--app-neutral-fill)]",
          )}
          data-testid="one-location-circle-invitations-summary"
        >
          <span className="text-[15px] font-medium leading-5 text-foreground">
            {invitationTitle}
          </span>
          <span className="text-[15px] font-semibold leading-5 text-[color:var(--app-accent)]">
            {invitationCount}
          </span>
          <ChevronRight
            className="h-4 w-4 text-[color:var(--app-tertiary-label)]"
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}

function CircleInvitationsDialog({
  open,
  invites,
  loading,
  focusedInviteId,
  focusedInviteResolutionReady,
  inviteBusy,
  onOpenChange,
  onAcceptInvite,
  onDeclineInvite,
  onDismissFocusedInvite,
}: {
  open: boolean;
  invites: OneLocationCircleMemberInvite[];
  loading: boolean;
  focusedInviteId: string | null;
  focusedInviteResolutionReady: boolean;
  inviteBusy: boolean;
  onOpenChange: (open: boolean) => void;
  onAcceptInvite: (inviteId: string) => Promise<void>;
  onDeclineInvite: (inviteId: string) => Promise<void>;
  onDismissFocusedInvite: () => void;
}) {
  const [respondingInviteId, setRespondingInviteId] = useState<string | null>(
    null,
  );
  const focusedInviteAvailable = focusedInviteId
    ? invites.some((invite) => invite.id === focusedInviteId)
    : true;
  const showUnavailable =
    Boolean(focusedInviteId) &&
    focusedInviteResolutionReady &&
    !loading &&
    !focusedInviteAvailable;

  const respondToInvite = async (
    inviteId: string,
    decision: "accept" | "decline",
  ) => {
    if (respondingInviteId || inviteBusy) return;
    setRespondingInviteId(inviteId);
    try {
      if (decision === "accept") {
        await onAcceptInvite(inviteId);
      } else {
        await onDeclineInvite(inviteId);
      }
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(
          error,
          decision === "accept"
            ? "Could not join this Circle."
            : "Could not decline this invitation.",
        ),
      );
    } finally {
      setRespondingInviteId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && focusedInviteId) onDismissFocusedInvite();
      }}
    >
      <DialogContent className="max-w-[420px] rounded-[24px] p-0">
        <DialogHeader className="px-5 pb-2 pt-5 text-left">
          <DialogTitle className="text-[20px] font-semibold leading-[25px] tracking-[-0.3px]">
            Circle invitations
          </DialogTitle>
          {showUnavailable ? (
            <DialogDescription>
              This Circle invitation is no longer available.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {showUnavailable ? (
          <div className="px-5 pb-5 pt-1">
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onDismissFocusedInvite();
              }}
              className="h-12 w-full rounded-2xl bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            >
              Done
            </Button>
          </div>
        ) : (
          <div
            className={cn("mx-4 mb-4", LOCATION_GROUP_SURFACE)}
            data-testid="one-location-circle-invitations-dialog-list"
          >
            {invites.map((invite, index) => {
              const responding = respondingInviteId === invite.id;
              const inviter =
                invite.inviterDisplayName?.trim() || "Someone you know";
              const circleName = invite.circleName?.trim() || "Circle";
              return (
                <div
                  key={invite.id}
                  className={cn(
                    "relative grid min-h-[68px] grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]",
                    index > 0 &&
                      "before:absolute before:left-16 before:right-4 before:top-0 before:h-px before:bg-[color:var(--app-separator)] before:content-['']",
                  )}
                  tabIndex={invite.id === focusedInviteId ? -1 : undefined}
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#E5E5EA] text-[13px] font-semibold text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#F2F2F7]"
                  >
                    {circleInitials(circleName) || (
                      <UsersRound className="h-[17px] w-[17px]" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="break-words text-[17px] font-medium leading-[22px] tracking-[-0.3px] text-foreground">
                      {circleName}
                    </p>
                    <p className="mt-0.5 break-words text-[13px] leading-[18px] tracking-[-0.2px] text-[color:var(--app-secondary-label)]">
                      Invited by {inviter}
                    </p>
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-2 sm:col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={responding || inviteBusy}
                      onClick={() => void respondToInvite(invite.id, "decline")}
                      className="h-11 rounded-full px-3 text-[15px] text-[color:var(--app-secondary-label)] hover:bg-transparent"
                    >
                      {responding && inviteBusy ? "Declining…" : "Decline"}
                    </Button>
                    <Button
                      type="button"
                      disabled={responding || inviteBusy}
                      onClick={() => void respondToInvite(invite.id, "accept")}
                      className="h-11 rounded-full bg-[color:var(--app-accent)] px-4 text-[15px] text-[color:var(--app-accent-fg)]"
                    >
                      {responding && inviteBusy ? "Joining…" : "Join"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PersonActionsDialog({
  open,
  name,
  photoUrl,
  verified,
  status,
  shareReady,
  pendingRequest,
  withdrawingRequestId,
  onOpenChange,
  onShare,
  onAsk,
  onManageSharing,
  onViewLocation,
  onManageConnection,
  onCancelRequest,
}: {
  open: boolean;
  name: string;
  photoUrl?: string | null;
  verified?: boolean;
  status: PeopleDirectoryStatus;
  shareReady: boolean;
  pendingRequest: OneLocationAccessRequest | null;
  withdrawingRequestId: string | null;
  onOpenChange: (open: boolean) => void;
  onShare: () => void;
  onAsk: () => void;
  onManageSharing: () => void;
  onViewLocation: () => void;
  onManageConnection: () => void;
  onCancelRequest: () => void;
}) {
  const cancelBusy =
    Boolean(pendingRequest) && withdrawingRequestId === pendingRequest?.id;
  const actionRows: ReactNode[] = [];
  const action = (
    key: string,
    title: string,
    onClick: () => void,
    options?: { tone?: "default" | "destructive"; chevron?: boolean },
  ) => (
    <SettingsRow
      key={key}
      title={title}
      density="compact"
      tone={options?.tone ?? "default"}
      chevron={options?.chevron ?? true}
      onClick={onClick}
      testId={`one-location-person-action-${key}`}
    />
  );

  if (status.kind === "both") {
    actionRows.push(action("view", "View their location", onViewLocation));
    actionRows.push(action("manage", "Manage my sharing", onManageSharing));
  } else if (status.kind === "outgoing") {
    actionRows.push(action("manage", "Manage my sharing", onManageSharing));
    if (!pendingRequest) {
      actionRows.push(action("ask", "Ask for location", onAsk));
    }
  } else if (status.kind === "incoming") {
    actionRows.push(action("view", "View their location", onViewLocation));
    if (shareReady) {
      actionRows.push(action("share", "Share my location", onShare));
    }
  } else if (status.kind === "pending" && pendingRequest) {
    actionRows.push(
      <SettingsRow
        key="cancel"
        title={cancelBusy ? "Cancelling…" : "Cancel request"}
        density="compact"
        tone="destructive"
        disabled={cancelBusy}
        onClick={onCancelRequest}
        testId="one-location-person-action-cancel"
      />,
    );
    if (shareReady) {
      actionRows.push(action("share", "Share my location", onShare));
    }
  } else if (shareReady) {
    actionRows.push(action("share", "Share my location", onShare));
    actionRows.push(action("ask", "Ask for location", onAsk));
  } else {
    actionRows.push(
      <SettingsRow
        key="unavailable"
        title="Location sharing is not available with this person yet."
        density="compact"
        disabled
        testId="one-location-person-action-unavailable"
      />,
    );
    actionRows.push(
      action("connection", "Manage connection", onManageConnection),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={`Location actions for ${name}`}
        className="max-w-[420px] rounded-[24px] p-0"
      >
        <DialogHeader className="px-5 pb-3 pt-5 text-left">
          <div className="flex items-center gap-3">
            <ConnectionPersonAvatar
              label={name}
              photoUrl={photoUrl}
              verified={verified}
              className="h-11 w-11 text-[14px]"
            />
            <div className="min-w-0">
              <DialogTitle className="break-words text-[20px] font-semibold leading-[25px] tracking-[-0.3px]">
                {name}
              </DialogTitle>
              {status.label ? (
                <DialogDescription className="mt-0.5 text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
                  {status.label}
                </DialogDescription>
              ) : null}
            </div>
          </div>
        </DialogHeader>
        <div className="mx-4 mb-4">
          <SettingsGroup separatorInset shellClassName={LOCATION_GROUP_SHELL_CLASSNAME}>
            {actionRows.slice(0, 3)}
          </SettingsGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PeopleHub({
  vm,
  onAddConnections,
  onInvite,
  onOpenCircleManager,
  focusedInviteId,
  onDismissFocusedInvite,
  onStartShare,
  onStartAsk,
  onOpenActiveShares,
  onOpenSharedWithMe,
}: {
  vm: LocationHubViewModel;
  onAddConnections: () => void;
  onInvite: () => void;
  onOpenCircleManager: () => void;
  focusedInviteId: string | null;
  onDismissFocusedInvite: () => void;
  onStartShare: (initialRecipientId?: string) => void;
  onStartAsk: (initialRecipientId?: string) => void;
  onOpenActiveShares: () => void;
  onOpenSharedWithMe: () => void;
}) {
  const hasSearch = vm.recipientSearch.trim().length > 0;
  const filtered = vm.visibleRecipients;
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const { expandedLaneUserIds, toggleLaneExpansion } = useExpandedShareLanes();

  const ownerGroupsByUserId = useMemo(() => {
    const byUserId = new globalThis.Map<string, OneLocationGrantLaneGroup>();
    for (const group of groupGrantsByCounterpart(
      vm.activeOwnerGrants.filter((grant) => grant.status === "active"),
      "owner",
    )) {
      byUserId.set(group.counterpartUserId, group);
    }
    return byUserId;
  }, [vm.activeOwnerGrants]);

  const receivedGroupsByOwnerId = useMemo(() => {
    const byUserId = new globalThis.Map<string, OneLocationGrantLaneGroup>();
    for (const group of groupGrantsByCounterpart(
      vm.receivedGrants.filter((grant) => grant.status === "active"),
      "recipient",
    )) {
      byUserId.set(group.counterpartUserId, group);
    }
    return byUserId;
  }, [vm.receivedGrants]);

  const pendingRequestByOwnerId = useMemo(() => {
    const byUserId = new globalThis.Map<string, OneLocationAccessRequest>();
    for (const request of vm.requestedByMe) {
      if (request.status !== "pending" || request.extendsGrantId) continue;
      if (!byUserId.has(request.ownerUserId)) {
        byUserId.set(request.ownerUserId, request);
      }
    }
    return byUserId;
  }, [vm.requestedByMe]);

  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const selectedPerson = useMemo(
    () =>
      selectedPersonId
        ? (vm.recipients.find((recipient) => recipient.userId === selectedPersonId) ??
          filtered.find((recipient) => recipient.userId === selectedPersonId) ??
          null)
        : null,
    [filtered, selectedPersonId, vm.recipients],
  );
  const selectedPersonName = selectedPerson
    ? vm.recipientLabel(selectedPerson)
    : "";
  const selectedOutgoingGroup = selectedPerson
    ? (ownerGroupsByUserId.get(selectedPerson.userId) ?? null)
    : null;
  const selectedIncomingGroup = selectedPerson
    ? (receivedGroupsByOwnerId.get(selectedPerson.userId) ?? null)
    : null;
  const selectedPendingRequest = selectedPerson
    ? (pendingRequestByOwnerId.get(selectedPerson.userId) ?? null)
    : null;
  const selectedPersonStatus = selectedPerson
    ? peopleDirectoryStatus({
        outgoingGroup: selectedOutgoingGroup,
        incomingGroup: selectedIncomingGroup,
        pendingRequest: selectedPendingRequest,
        countdownLabel: vm.expiresCountdownLabel,
      })
    : null;

  const recipientPageHasMore = vm.recipientPageHasMore;
  const recipientPageLoading = vm.recipientPageLoading;
  const onLoadMoreRecipients = vm.onLoadMoreRecipients;

  useEffect(() => {
    if (!focusedInviteId) return;
    if (
      vm.incomingCircleMemberInvitesLoading ||
      !vm.incomingCircleMemberInviteFocusResolved
    ) {
      return;
    }
    setInvitationsOpen(true);
  }, [
    focusedInviteId,
    vm.incomingCircleMemberInviteFocusResolved,
    vm.incomingCircleMemberInvitesLoading,
  ]);

  useEffect(() => {
    if (
      !recipientPageHasMore ||
      recipientPageLoading ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const node = loadMoreSentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onLoadMoreRecipients();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    onLoadMoreRecipients,
    recipientPageHasMore,
    recipientPageLoading,
  ]);

  const addPeopleEmptyAction = hasSearch ? (
    <Link
      href={peopleConnectRecoveryHref(vm.recipientSearch)}
      data-testid="one-location-people-find-or-invite"
      className="inline-flex h-11 min-h-11 items-center justify-center rounded-full bg-[color:var(--app-accent)] px-6 text-[16px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
    >
      Find or invite someone
    </Link>
  ) : (
    <Button
      type="button"
      onClick={onAddConnections}
      data-voice-control-id="one-location-add-connections"
      className="h-11 min-h-11 rounded-full bg-[color:var(--app-accent)] px-6 text-[16px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
    >
      Find or invite someone
    </Button>
  );
  const addConnectionsMenu = (
    <ActionMenu
      label="Add or manage people"
      title="People"
      triggerIcon={Plus}
      testId="one-location-add-people"
      items={[
        {
          id: "find-contacts",
          // Kept mounted and merely DISABLED while a sync is in flight, so a
          // second tap is refused rather than queued -- single-flight, and
          // visibly so. Removing the row instead would make the control
          // disappear mid-action.
          label:
            vm.busy === "contactSync"
              ? "Finding contacts…"
              : vm.contactSyncSummary
                ? "Sync contacts again"
                : "Find contacts",
          onSelect: () => vm.onSyncContacts(),
          disabled: vm.busy === "contactSync",
          busy: vm.busy === "contactSync",
          voiceControlId: "one-location-find-contacts",
        },
        ...(vm.contactSyncSummary && vm.onViewContactSyncResults
          ? [
              {
                id: "sync-results",
                label: "View contact sync results",
                onSelect: () => vm.onViewContactSyncResults?.(),
              },
            ]
          : []),
        {
          id: "invite",
          label: "Invite to One",
          onSelect: () => onInvite(),
          voiceControlId: "one-location-action-invite",
        },
        {
          id: "manage",
          label: "Manage connections",
          onSelect: () => onAddConnections(),
          voiceControlId: "one-location-add-connections",
        },
      ]}
    />
  );

  return (
    <div className="pt-4 sm:pt-5" data-testid="one-location-people-hub">
      <div className="mx-auto w-full max-w-[640px] space-y-5">
        {!hasSearch ? (
          <CircleSummaryGroup
            circles={vm.circles}
            invitationCount={vm.incomingCircleMemberInvites.length}
            onOpenCircles={onOpenCircleManager}
            onOpenInvitations={() => setInvitationsOpen(true)}
          />
        ) : null}

        <section
          aria-labelledby="one-location-people-heading"
          className="space-y-3"
          data-testid="one-location-people-connections"
        >
          {!hasSearch ? (
            <div className="flex items-center justify-between gap-4">
              <h2
                id="one-location-people-heading"
                className="text-[20px] font-semibold leading-[25px] tracking-[-0.3px] text-[color:var(--app-section-label)]"
              >
                People
              </h2>
              {addConnectionsMenu}
            </div>
          ) : (
            <span id="one-location-people-heading" className="sr-only">
              People
            </span>
          )}

          <div
            className={cn(
              "[&_input]:h-[46px] [&_input]:rounded-[14px] [&_input]:border-0 [&_input]:bg-[color:var(--app-primary-surface)] [&_input]:pl-[46px] [&_input]:pr-[18px] [&_input]:text-[16px] [&_input]:leading-[22px] dark:[&_input]:bg-[color:var(--app-secondary-surface)]",
              "[&_svg]:left-[18px] [&_svg]:text-[color:var(--app-tertiary-label)]",
            )}
            data-testid="one-location-people-search"
          >
            <PersonSearchInput
              value={vm.recipientSearch}
              onChange={vm.setRecipientSearch}
              placeholder="Search people"
            />
          </div>

          {filtered.length ? (
            <div
              className={LOCATION_GROUP_SURFACE}
              data-testid="one-location-people-list"
              aria-busy={vm.recipientPageLoading || undefined}
            >
              {filtered.map((recipient, index) => {
                const name = vm.recipientLabel(recipient);
                const outgoingGroup =
                  ownerGroupsByUserId.get(recipient.userId) ?? null;
                const incomingGroup =
                  receivedGroupsByOwnerId.get(recipient.userId) ?? null;
                const pendingRequest =
                  pendingRequestByOwnerId.get(recipient.userId) ?? null;
                const status = peopleDirectoryStatus({
                  outgoingGroup,
                  incomingGroup,
                  pendingRequest,
                  countdownLabel: vm.expiresCountdownLabel,
                });
                const singleGrant =
                  outgoingGroup && outgoingGroup.grants.length === 1
                    ? outgoingGroup.primaryGrant
                    : null;
                const lanesExpanded = expandedLaneUserIds.has(recipient.userId);
                const lanesId = `one-location-people-lanes-${recipient.userId}`;
                const shareReady = vm.isRecipientShareReady(recipient);
                const subtitle =
                  status.label ??
                  (isGenericConnectionCopy(vm.recipientSubtitle(recipient))
                    ? "Connected"
                    : vm.recipientSubtitle(recipient));
                return (
                  <PersonRow
                    key={recipient.userId}
                    name={name}
                    profileHref={
                      recipient.publicPersonRef
                        ? buildPersonProfileRoute(recipient.publicPersonRef, {
                            from: ROUTES.ONE_LOCATION,
                          })
                        : null
                    }
                    photoUrl={recipient.photoUrl}
                    verified={Boolean(recipient.isRia)}
                    expansion={
                      outgoingGroup && !singleGrant ? (
                        <div id={lanesId} hidden={!lanesExpanded}>
                          <PersonShareLanes
                            group={outgoingGroup}
                            counterpartName={name}
                            onStopGrant={vm.onStopGrant}
                            revokingGrantId={vm.revokingGrantId}
                          />
                        </div>
                      ) : null
                    }
                    subtitle={subtitle}
                    active={status.active}
                    first={index === 0}
                    onOpen={
                      status.kind !== "neutral" && !(outgoingGroup && !singleGrant)
                        ? () => setSelectedPersonId(recipient.userId)
                        : undefined
                    }
                    action={
                      outgoingGroup && !singleGrant ? (
                        <ShareLanesDisclosure
                          expanded={lanesExpanded}
                          onToggle={() => toggleLaneExpansion(recipient.userId)}
                          controlsId={lanesId}
                          label={`Manage your shares with ${name}`}
                        />
                      ) : status.kind === "neutral" && shareReady ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onStartShare(recipient.userId)}
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
              {vm.recipientPageHasMore ? (
                <div
                  ref={loadMoreSentinelRef}
                  role="status"
                  data-testid="one-location-people-load-more-sentinel"
                  className="border-t border-[color:var(--app-separator)] px-4 py-3 text-center text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]"
                >
                  {vm.recipientPageLoading ? "Loading more…" : ""}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="[&>[data-ui-role=grouped-card]]:rounded-[var(--app-radius-md)] [&>[data-ui-role=grouped-card]]:!bg-[color:var(--app-primary-surface)] [&>[data-ui-role=grouped-card]]:shadow-[var(--app-card-shadow-standard)] dark:[&>[data-ui-role=grouped-card]]:shadow-none">
              <EmptyState
                title={
                  hasSearch
                    ? `No match for “${vm.recipientSearch.trim()}”`
                    : "No people yet"
                }
                description={
                  hasSearch
                    ? "They may not be in your connections yet."
                    : "Find or invite someone to start sharing privately."
                }
                action={addPeopleEmptyAction}
              />
            </div>
          )}
        </section>
      </div>

      {selectedPerson && selectedPersonStatus ? (
        <PersonActionsDialog
          open={Boolean(selectedPerson)}
          name={selectedPersonName}
          photoUrl={selectedPerson.photoUrl}
          verified={Boolean(selectedPerson.isRia)}
          status={selectedPersonStatus}
          shareReady={vm.isRecipientShareReady(selectedPerson)}
          pendingRequest={selectedPendingRequest}
          withdrawingRequestId={vm.withdrawingRequestId}
          onOpenChange={(open) =>
            setSelectedPersonId(open ? selectedPerson.userId : null)
          }
          onShare={() => {
            setSelectedPersonId(null);
            onStartShare(selectedPerson.userId);
          }}
          onAsk={() => {
            setSelectedPersonId(null);
            onStartAsk(selectedPerson.userId);
          }}
          onManageSharing={() => {
            setSelectedPersonId(null);
            onOpenActiveShares();
          }}
          onViewLocation={() => {
            setSelectedPersonId(null);
            onOpenSharedWithMe();
          }}
          onManageConnection={() => {
            setSelectedPersonId(null);
            onAddConnections();
          }}
          onCancelRequest={() => {
            if (!selectedPendingRequest) return;
            void vm.onWithdrawRequest(selectedPendingRequest.id);
          }}
        />
      ) : null}

      <CircleInvitationsDialog
        open={invitationsOpen}
        invites={vm.incomingCircleMemberInvites}
        loading={vm.incomingCircleMemberInvitesLoading}
        focusedInviteId={focusedInviteId}
        focusedInviteResolutionReady={vm.incomingCircleMemberInviteFocusResolved}
        inviteBusy={vm.busy === "circleMemberInvite"}
        onOpenChange={setInvitationsOpen}
        onAcceptInvite={vm.onAcceptNamedCircleMemberInvite}
        onDeclineInvite={vm.onDeclineNamedCircleMemberInvite}
        onDismissFocusedInvite={onDismissFocusedInvite}
      />
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

function LinkIdentityMark({
  tone = "accent",
}: {
  tone?: "accent" | "success";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
        tone === "success"
          ? "bg-[color:var(--app-success)]/12 text-[color:var(--app-success)] dark:bg-[color:var(--app-success)]/15"
          : "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]",
      )}
    >
      {tone === "success" ? (
        <ShieldCheck className="h-[17px] w-[17px]" strokeWidth={2.1} />
      ) : (
        <Link2 className="h-[17px] w-[17px]" strokeWidth={2.1} />
      )}
    </span>
  );
}

function PublicLinkActionRows({
  onCopy,
  onShare,
  onRevoke,
  revokeBusy,
}: {
  onCopy: () => boolean | Promise<boolean>;
  onShare: () => void;
  onRevoke: () => void;
  revokeBusy?: boolean;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [copyBusy, setCopyBusy] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (copyBusy) return;
    setCopyBusy(true);
    try {
      const copied = await onCopy();
      if (!copied) return;
      setCopyLabel("Copied");
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = setTimeout(() => {
        setCopyLabel("Copy link");
      }, 1600);
    } finally {
      setCopyBusy(false);
    }
  };

  return (
    <div className="space-y-3 px-4 pb-4 pt-2">
      <div className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2">
        <Button
          onClick={onShare}
          className="ui-text-button-label h-12 rounded-[15px] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
        >
          <Share2 className="mr-1.5 h-4 w-4" />
          Share
        </Button>
        <Button
          variant="outline"
          onClick={handleCopy}
          disabled={copyBusy}
          aria-busy={copyBusy || undefined}
          className="ui-text-button-label h-12 rounded-[15px]"
        >
          <Copy className="mr-1.5 h-4 w-4" />
          {copyBusy ? "Copying…" : copyLabel}
        </Button>
      </div>
      <div className="border-t border-[color:var(--app-separator)] pt-1">
        <button
          type="button"
          onClick={onRevoke}
          disabled={revokeBusy}
          className="ui-text-button-label min-h-11 w-full text-left text-[color:var(--app-destructive)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {revokeBusy ? "Revoking…" : "Revoke link"}
        </button>
      </div>
    </div>
  );
}

/** One active-link row: shared grouped row · title · subtitle · Copy. */
function ActiveLinkRow({
  tone,
  title,
  subtitle,
  onCopy,
}: {
  tone: "accent" | "success";
  title: string;
  subtitle: string;
  onCopy: () => void;
}) {
  return (
    <SettingsRow
      density="compact"
      leading={<LinkIdentityMark tone={tone} />}
      title={title}
      description={subtitle}
      trailing={
        <Button
          variant="outline"
          onClick={onCopy}
          size="sm"
          className="shrink-0 border-[color:var(--app-accent)] px-4 text-[color:var(--app-accent)]"
        >
          Copy
        </Button>
      }
    />
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
      <SettingsGroup
        title="Temporary link"
        separatorInset
        shellClassName={LOCATION_GROUP_SHELL_CLASSNAME}
        className="[&>div:first-child]:mt-0"
        testId="one-location-links-temporary-link"
      >
        {hasLiveLink ? (
          hasShareableLink ? (
            <>
              <SettingsRow
                density="compact"
                leading={<LinkIdentityMark />}
                title="Link is live"
                description={
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--app-success)]" />
                    <span>
                      {temp
                        ? publicLinkStatusLabel(
                            vm.expiresCountdownLabel(temp.expiresAt),
                          )
                        : "Active"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Anyone with this link can see your location.</span>
                  </span>
                }
              />
              <PublicLinkActionRows
                onCopy={vm.onCopyPublicInvite}
                onShare={vm.onSharePublicInvite}
                onRevoke={() => {
                  if (temp) vm.onRevokePublicInvite(temp);
                }}
                revokeBusy={vm.busy === "publicRevoke" || !temp}
              />
            </>
          ) : (
            <>
              <SettingsRow
                density="compact"
                leading={<LinkIdentityMark />}
                title="Link is live"
                description="Active, but unavailable on this device."
              />
              <div className="px-4 pb-4 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (temp) vm.onRevokePublicInvite(temp);
                  }}
                  disabled={vm.busy === "publicRevoke" || !temp}
                  className="ui-text-button-label min-h-11 w-full text-left text-[color:var(--app-destructive)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                >
                  {vm.busy === "publicRevoke" || !temp
                    ? "Stopping…"
                    : "Stop link"}
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <SettingsRow
              density="compact"
              leading={<LinkIdentityMark />}
              title="Create a temporary link"
              description="Anyone with this link can see your location until it expires."
            />
            <div className="space-y-4 px-4 pb-4 pt-2">
              <DurationSelector
                value={vm.publicLinkDurationHours}
                onChange={vm.setPublicLinkDurationHours}
                options={PUBLIC_LINK_DURATION_OPTIONS.map((option) => option)}
                label="Duration"
                presentation="buttons"
                maxWidthClassName={null}
              />
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
          </>
        )}
      </SettingsGroup>

      {/* A Circle invite is a different object on a different table with a
          different ceiling, and it is not subject to the one-at-a-time rule
          above: it admits one named person to a Circle rather than showing the
          owner to anyone holding a URL. It keeps its row. */}
      {invite ? (
        <SettingsGroup
          separatorInset
          shellClassName={LOCATION_GROUP_SHELL_CLASSNAME}
          testId="one-location-links-invite-link"
        >
          <ActiveLinkRow
            tone="success"
            title="Invite link"
            subtitle={`${vm.expiresCountdownLabel(invite.expiresAt)} · one person`}
            onCopy={vm.onCopyCircleInvite}
          />
        </SettingsGroup>
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
  //
  // Resynced on ENTERING the step, not only every 30 seconds after it. The
  // clock started at flow mount, so somebody who spent ten minutes choosing
  // people on step 1 arrived here with a ten-minute-old "now" for up to
  // another thirty seconds -- long enough to read a wrong end time, and long
  // enough for the replacement warning below to compare against a share that
  // has less left than it thinks.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (step !== "details") return;
    setNowMs(Date.now());
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
        leading={
          <ConnectionPersonAvatar
            label={label}
            photoUrl={r.photoUrl}
            verified={Boolean(r.isRia)}
          />
        }
        title={
          <span className="flex min-w-0 items-start gap-1.5">
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {r.connectedFromContacts ? (
              <ContactSourceBadge className="mt-px shrink-0" />
            ) : null}
          </span>
        }
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
  /**
   * Whose live share this one would CUT SHORT.
   *
   * Sharing again does not add to what somebody already has — the backend
   * revokes their live grant and inserts a new one — so picking a duration
   * shorter than what is still running gives time back rather than granting
   * it. Step 1 shows each row's remaining time, but the duration is chosen
   * here, and nothing compared the two until this. Empty for a first share and
   * for any extension, so the ordinary case stays silent.
   *
   * Reuses the `nowMs` this step already ticks every 30 seconds, so a screen
   * left open cannot quote a remaining time that has since run out.
   */
  const shareReplacementRows: ShareReplacementRow[] =
    shareReplacementsLosingTime({
      recipientUserIds: selectedReady.map((recipient) => recipient.userId),
      activeOwnerGrants: vm.activeOwnerGrants,
      durationValue: vm.shareDurationHours,
      nowMs,
    }).map(({ recipientUserId, grant, untilStopped }) => {
      const recipient = recipientById.get(recipientUserId);
      return {
        recipientUserId,
        label: recipient ? vm.recipientLabel(recipient) : "This person",
        untilStopped,
        // The two vocabularies this app already owns for the two kinds of live
        // share: "Until you stop" is what every surface that lists a share calls
        // an open-ended one, and `formatLocationRemaining` is what the approvals
        // card, the feed and the Consent Manager call the time left on a timed
        // one. A warning about a share must not be the one place that words it
        // differently.
        remainingLabel: untilStopped
          ? "Until you stop"
          : (formatLocationRemaining(
              parseTimestamp(grant.expiresAt) ?? nowMs,
              nowMs,
            ) ?? "less than a minute more"),
      };
    });
  const shareReplacementDurationLabel = formatLocationDurationLabel(
    resolveShareDurationHours(vm.shareDurationHours),
  );
  const [shareReplacementConfirmOpen, setShareReplacementConfirmOpen] =
    useState(false);
  // The dialog must never outlive the reason it opened. Leaving the confirm
  // step, or de-selecting the person whose share was at risk, both make it a
  // question about nothing.
  const shareReplacementCount = shareReplacementRows.length;
  useEffect(() => {
    if (step !== "details" || !shareReplacementCount) {
      setShareReplacementConfirmOpen(false);
    }
  }, [shareReplacementCount, step]);
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
  const selectedShareCircleRecipientCount = countSelectedCircleRecipients(
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
      <div className="mx-auto w-full max-w-[560px] space-y-5 pb-[calc(var(--app-bottom-fixed-ui,96px)+1rem)]">
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
              <FormLabel as="label" htmlFor="one-location-share-note">
                Optional note
              </FormLabel>
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
                  className="ui-text-input-value block min-h-[92px] w-full resize-none rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] px-4 pb-8 pt-3.5 outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)] aria-invalid:border-[color:var(--app-destructive)] aria-invalid:focus:ring-[color:var(--app-destructive-border)]"
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

        {/* Between the rail that says WHO and the button that starts it: the
            one place an owner is still looking at both the people and the
            duration. Renders nothing unless somebody actually loses time. */}
        <ShareReplacementNotice
          rows={shareReplacementRows}
          newDurationLabel={shareReplacementDurationLabel}
        />

        <div className="space-y-2.5">
          <Button
            // Unchanged for every share that takes nothing away. When one
            // would, the tap opens the confirm dialog instead of posting, and
            // the dialog's own action is what reaches `onConfirmShare`.
            onClick={() => {
              if (shareReplacementRows.length) {
                setShareReplacementConfirmOpen(true);
                return;
              }
              vm.onConfirmShare();
            }}
            disabled={!vm.canShare || shareNoteLimitExceeded}
            isLoading={vm.busy === "share"}
            data-voice-control-id="one-location-confirm-share"
            className="h-[52px] w-full rounded-2xl bg-[color:var(--app-accent)] text-[17px] font-semibold leading-[22px] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 disabled:bg-black/10 disabled:text-black/35 disabled:opacity-100 dark:disabled:bg-white/10 dark:disabled:text-white/35"
          >
            Start sharing
          </Button>
          <Button
            variant="ghost"
            onClick={() => onClose()}
            className="h-11 w-full rounded-2xl bg-transparent text-[17px] font-medium leading-[22px] text-[color:var(--app-accent)] hover:bg-transparent"
          >
            Cancel
          </Button>
        </div>

        <ShareReplacementConfirmDialog
          open={shareReplacementConfirmOpen}
          onOpenChange={setShareReplacementConfirmOpen}
          rows={shareReplacementRows}
          newDurationLabel={shareReplacementDurationLabel}
          busy={vm.busy === "share"}
          onConfirm={() => {
            setShareReplacementConfirmOpen(false);
            vm.onConfirmShare();
          }}
        />
      </div>
    );
  }

  // step === "person"
  return (
    <div className={FLOW_STEP_ONE_CLASSNAME}>
      <TaskFlowHeader
        eyebrow="Step 1 of 2"
        title="Who can see you?"
        description={selectedCountCopy(
          selectedReady.length,
          "Choose a Circle or contact.",
        )}
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
            .sort((a, b) =>
              a.name === "SMS Circle" ? 1 : b.name === "SMS Circle" ? -1 : 0,
            )
            .map((circle) => {
              const selected =
                vm.selectedShareCircleSelection?.circle.id === circle.id &&
                shareCircleFullySelected;
              const circleSelectionDescription = selected
                ? `${selectedShareCircleRecipientCount} selected`
                : circleMemberCountLabel(circle.memberCount);
              const circleRole = roleClasses("people");
              return (
                <SettingsRow
                  key={circle.id}
                  density="compact"
                  disabled={vm.busy === "shareCircle"}
                  onClick={() => void vm.onSelectShareCircle(circle.id)}
                  ariaPressed={selected}
                  ariaLabel={`${selected ? "Deselect" : "Select"} the ${circle.name} Circle, ${circleSelectionDescription}`}
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
                      : circleSelectionDescription
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
              title={
                <span className="flex w-full items-center justify-between gap-4">
                  <span>Not sharing</span>
                  <span className="font-normal text-muted-foreground">
                    {notSharing.length}
                  </span>
                </span>
              }
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
      <div className={STICKY_FLOW_ACTION_CLASSNAME}>
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
 * The new-end-time editor opened from the live share card.
 *
 * A short preset ladder (15 min / 1 hour / 2 hours / 4 hours / Until I stop),
 * not the received-shares editor's select and not the scroll wheel this used
 * to open on. It still opens on what the share actually has left, so the
 * "Ends …" read-back stays honest even when that value matches no rung; the
 * person then picks the length they want in one tap.
 */
function LiveShareDurationEditor({
  value,
  onChange,
  onCancel,
  onSave,
  saving,
  surface = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  surface?: boolean;
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
      className={cn(
        surface ? SUBCARD_SURFACE : null,
        "space-y-4",
        surface ? "p-4" : null,
      )}
      data-testid="one-location-live-share-duration-editor"
      data-ui-contract="control-group"
      data-ui-id="location-live-share-duration-editor"
    >
      {/*
        Four common lengths plus the open-ended row, one tap each — no `Custom`
        wheel and no `8 hours` (issue #6228). Changing a share that is already
        running is a quick decision, and the sixth near-identical choice plus a
        two-drag scroll wheel made this panel read like a settings screen
        stacked under the live clock. Anything in between is still reachable by
        stopping the share and starting a new one.

        `centered` + `maxWidthClassName={null}`: the rungs sit inside a card
        far wider than they need. Freed of the 420px clamp they centre as one
        row from `sm` up instead of wrapping and hugging the left edge; on the
        phone grid the open-ended row spans both columns. The clamp existed to
        stop a stretching grid printing 258px slabs — the ladder is a
        wrapping row of content-width chips now, so there is nothing to stretch.

        `until_stopped` stays available: this is a decision about your own
        location, so open-ended is a real answer here (unlike the Request lane,
        which turns the rung off).
      */}
      <DurationSelector
        value={value}
        onChange={(next) => {
          if (!saving) onChange(next);
        }}
        presentation="ladder"
        rungs={CHANGE_TIME_DURATION_LADDER}
        untilStopValue="until_stopped"
        allowCustom={false}
        centered
        maxWidthClassName={null}
        label="New time"
        // Beside the label rather than on its own line under the control --
        // "New time … Ends 6:50 PM" is one statement, and it is how every
        // other ladder on these screens already reads.
        hint={shareEndsAtLabel(value, nowMs)}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          className="h-11 rounded-full"
          onClick={onCancel}
          disabled={saving}
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
  photoUrl,
  verified,
  fromContacts,
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
  photoUrl?: string | null;
  verified?: boolean;
  fromContacts?: boolean;
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
        <ContactAvatar label={name} photoUrl={photoUrl} verified={verified} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[17px] font-normal leading-[22px] text-foreground">
              {name}
            </span>
            {fromContacts ? (
              <ContactSourceBadge className="mt-px shrink-0" />
            ) : null}
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
  onClose: (nextTab?: LocationHubTab) => void;
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
  const [askDraftReady, setAskDraftReady] = useState(false);
  useEffect(() => {
    if (debouncedSearch !== vm.recipientSearch) {
      vm.setRecipientSearch(debouncedSearch);
    }
    // `vm` is rebuilt every render; depending on it would re-fire this on every
    // render and defeat the debounce entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    if (askDraftReady) return;
    const draft = readStoredAskFlowDraft();
    if (draft) {
      const knownRecipients = new Set(
        vm.recipients.map((recipient) => recipient.userId),
      );
      setSearchDraft(draft.search);
      vm.setRecipientSearch(draft.search);
      vm.setDurationHours(draft.durationHours);
      vm.setRequestMessage(draft.requestMessage);
      if (draft.reason) setReason(draft.reason);
      vm.setSelectedRequestOwnerIds(
        draft.selectedOwnerIds.filter((id) => knownRecipients.has(id)),
      );
    }
    setAskDraftReady(true);
    // Restore once per flow mount. The view model object is intentionally not a
    // dependency because it is rebuilt by the page on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askDraftReady]);

  // Keep the person on this screen after sending, so the roster they just acted
  // on is still the thing in front of them and the next ask is one tap away
  // rather than a trip back through the hub.
  //
  // There is no `justSent` banner any more. `handleRequestAccess` already
  // raises a Sonner toast on a resolved success ("Request sent. We'll notify
  // you here when they respond."), and every person asked already carries the
  // outcome durably in their own row -- an "Asked" pill and "Asked just now for
  // 1 hour, waiting on them". So the banner was the third telling of the same
  // fact, and the only one that took permanent layout at the top of the screen
  // to say something that stopped being news a second later. Reported as
  // exactly that: "request sent is not looking cool, do you really think we
  // want a bar for this only".
  //
  // `frontend-pattern-catalog.md` has said so since before this screen existed:
  // "Do not create inline route banners for row-level saves... Inline errors
  // are for stable page-blocking states only." A sent request is neither.
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
    if (!askDraftReady) return;
    writeStoredAskFlowDraft({
      search: searchDraft,
      selectedOwnerIds: selectedRequestOwnerIds,
      durationHours: vm.durationHours,
      requestMessage: vm.requestMessage,
      reason,
    });
  }, [
    askDraftReady,
    reason,
    searchDraft,
    selectedRequestOwnerIds,
    vm.durationHours,
    vm.requestMessage,
  ]);
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

  const normalizedRecipientSearch = vm.recipientSearch.trim().toLowerCase();
  const searchActive = normalizedRecipientSearch.length > 0;
  const eligibleRecipientRows = useMemo(
    () =>
      rosterRecipientRows.filter(
        (row) => statusByRecipient.get(row.recipient.userId)?.selectable,
      ),
    [rosterRecipientRows, statusByRecipient],
  );
  const askRecipientRows = searchActive
    ? rosterRecipientRows
    : eligibleRecipientRows;
  const pendingNewRequestCount = useMemo(
    () =>
      vm.requestedByMe.filter(
        (request) => request.status === "pending" && !request.extendsGrantId,      ).length,
    [vm.requestedByMe],
  );

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

  /**
   * The extension already waiting on each live grant, indexed once.
   *
   * The People tab keeps the same index for the same reason: with an ask
   * already pending, showing the amounts again is how one share collects four
   * identical requests the owner has to answer one at a time.
   */
  const pendingExtensionByGrantId = useMemo(() => {
    const byGrantId = new globalThis.Map<string, OneLocationAccessRequest>();
    for (const request of vm.requestedByMe) {
      if (request.status !== "pending" || !request.extendsGrantId) continue;
      if (!byGrantId.has(request.extendsGrantId)) {
        byGrantId.set(request.extendsGrantId, request);
      }
    }
    return byGrantId;
  }, [vm.requestedByMe]);

  const isRequestFormValid = vm.selectedRequestOwnerIds.length > 0;
  const sendingRequest = vm.busy === "request";
  const sendRequest = () => {
    // Never submit an incomplete form even if the click somehow reaches the
    // handler (e.g. keyboard/AT), and never double-fire.
    if (!isRequestFormValid || sendingRequest || sendInFlightRef.current)
      return;
    sendInFlightRef.current = true;
    void (async () => {
      try {
        // Confirm only what actually happened. `onSendRequest` resolves true
        // only once at least one request reached the server, and raises the
        // toast itself; a failure leaves the composer intact with its own error
        // toast and never moves the step.
        const result = await vm.onSendRequest(reason);
        if (result.completed) {
          clearStoredAskFlowDraft();
          onClose("now");
        } else if (result.sent) {
          setStep("details");
        }
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  };

  if (step === "details") {
    return (
      <div className={FLOW_STEP_CONFIRM_CLASSNAME}>
        {/* Names the two fields under it rather than asking whether the
            person is ready.

            "Ready to ask?" was a yes/no question about the reader's state of
            mind, on a screen whose whole job is to collect two answers -- how
            long, and why. It told somebody arriving here nothing they did not
            already know (they tapped Continue; they are ready) and nothing
            about what the screen wanted from them. This is the same two words
            the section labels below use, in the same order. */}
        <TaskFlowHeader eyebrow="Step 2 of 2" title="Who, then how long?" />

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

        <SectionCard className="p-5 sm:p-6">
          <div className="space-y-6">
            <DurationSelector
              value={vm.durationHours}
              onChange={vm.setDurationHours}
              maxWidthClassName={null}
              label="How long"
              presentation="ladder"
              allowUntilStop={false}
              // Not FULL: the two lanes shared one constant for a moment, and
              // trimming this screen to four cells must not take rungs off the
              // owner's own "New time" editor, which has a card to itself.
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
                <FormLabel as="label" htmlFor="one-location-ask-other-reason">
                  Add reason
                </FormLabel>
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
                  className="ui-text-input-value block min-h-[88px] w-full resize-none rounded-[14px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] px-4 pb-8 pt-3.5 outline-none focus:ring-2 focus:ring-[color:var(--app-accent-ring)]"
                />
              </div>
            ) : null}
          </div>
        </SectionCard>

        <div
          data-testid="one-location-ask-send-bar"
          className={cn(STICKY_FLOW_ACTION_CLASSNAME, "space-y-2.5")}
        >
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
            onClick={() => onClose()}
            className="h-11 w-full rounded-2xl bg-transparent text-[17px] font-medium leading-[22px] text-[color:var(--app-accent)] hover:bg-transparent"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={FLOW_STEP_ONE_CLASSNAME}>
      <TaskFlowHeader
        eyebrow="Step 1 of 2"
        title="Ask for location"
        description={selectedCountCopy(
          selectedRequestRecipients.length,
          "Choose who to ask.",
        )}
      />

      {/* No confirmation banner here. The send raises a toast, and each person
          asked says so in their own row -- see the note beside `sendRequest`. */}
      <section className="space-y-3">
        <PersonSearchInput
          value={searchDraft}
          onChange={setSearchDraft}
          placeholder="Search people"
        />
        {!searchActive && pendingNewRequestCount > 0 ? (
          <div
            data-testid="one-location-ask-waiting-summary"
            className="rounded-[18px] border border-[color:var(--app-separator)] bg-[color:var(--app-primary-surface)] px-4 py-3"
          >
            <p className="text-[15px] font-semibold leading-5 text-foreground">
              {waitingResponsesLabel(pendingNewRequestCount)}
            </p>
          </div>
        ) : null}
        {askRecipientRows.length ? (
          <VirtualContactList
            items={askRecipientRows}
            getKey={(row) => row.key}
            testId="one-location-ask-recipients"
            ariaLabel="People you can ask"
            maxHeightClassName="max-h-[min(640px,70vh)]"
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
              const exactStatusSearch =
                searchActive &&
                recipientLabel
                  .toLowerCase()
                  .includes(normalizedRecipientSearch);              const showStateActions = !status.selectable && exactStatusSearch;
              return (
                <RequestRecipientListRow
                  key={r.userId}
                  name={recipientLabel}
                  photoUrl={r.photoUrl}
                  verified={Boolean(r.isRia)}
                  fromContacts={r.connectedFromContacts}
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
                    showStateActions && activeGrant
                      ? () =>
                          isEditingThis
                            ? vm.onEditGrantCancel()
                            : vm.onEditGrantStart(activeGrant.id)
                      : undefined
                  }
                  editActive={isEditingThis}
                  onRemove={
                    showStateActions && activeGrant
                      ? () => vm.onStopGrant(activeGrant.id)
                      : showStateActions && pendingRequestId
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
                    showStateActions && isEditingThis && activeGrant ? (
                      /* Reported: "4 hours ke liye approval maine le liya toh
                         neeche ke time duration edit mein aana illogical ...
                         agar deni hain toh user can ask for more time".
                         Right on both counts. This slot held a `Select`
                         labelled "New duration" listing ABSOLUTE lengths
                         preselected to whatever the share had left, so the
                         obvious reading -- "this share is 4 hours" -- was the
                         wrong one: the request carries `extendsGrantId`, which
                         makes the number additive, and picking under what was
                         left silently shortened instead. One field, two
                         operations, and nothing on screen saying which.

                         It is the same control the People tab already used for
                         this exact decision. Ending the share early did not go
                         with it -- that is the row's own Remove, one line up
                         and unambiguous. */
                      <AskForMoreTime
                        grantId={activeGrant.id}
                        ownerUserId={r.userId}
                        ownerLabel={recipientLabel}
                        pendingExtension={pendingExtensionByGrantId.get(
                          activeGrant.id,
                        )}
                        requestingMoreTimeKey={vm.requestingMoreTimeKey}
                        withdrawingRequestId={vm.withdrawingRequestId}
                        onRequestMoreTime={vm.onRequestMoreTime}
                        onWithdrawRequest={vm.onWithdrawRequest}
                      />
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
                title="No one new to ask"
                description="Find or invite them in Connect."
              />
            ) : (
              <EmptyState
                title="No one to ask yet"
                description="Find or invite someone first."
              />
            )}
            <Link
              href={askFlowConnectRecoveryHref(searchDraft)}
              data-testid="one-location-ask-find-or-invite"
              className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-full px-1 text-[15px] font-medium text-[color:var(--app-accent)]"
            >
              Find or invite someone
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          </div>
        )}
      </section>

      <div className={STICKY_FLOW_ACTION_CLASSNAME}>
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
          className="flex min-h-14 items-center gap-3 rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] px-4 py-3 shadow-[var(--app-card-shadow-standard)] dark:shadow-none"
        >
          <div className="flex shrink-0 -space-x-2" aria-hidden="true">
            {recipients.slice(0, 3).map((recipient) => {
              const label = recipientLabel(recipient);
              return (
                <ContactAvatar
                  key={recipient.userId}
                  label={label}
                  photoUrl={recipient.photoUrl}
                  verified={Boolean(recipient.isRia)}
                  className="h-9 w-9 border-2 border-[color:var(--app-card-surface-default-solid)] text-[13px]"
                />
              );
            })}
            <span className="flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-surface)] px-2 text-[13px] font-semibold text-[color:var(--app-secondary-label)]">
              +{recipients.length - 3}
            </span>
          </div>
          <div className="min-w-0 flex-1 text-[17px] leading-[22px] text-[color:var(--app-label)]">
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
          className="divide-y divide-[color:var(--app-separator)] overflow-hidden rounded-[18px] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)] dark:shadow-none"
        >
          {recipients.map((recipient) => {
            const label = recipientLabel(recipient);
            return (
              <div
                key={recipient.userId}
                role="listitem"
                className="flex min-h-14 items-center gap-3 px-4 py-2.5"
              >
                <ContactAvatar
                  label={label}
                  photoUrl={recipient.photoUrl}
                  verified={Boolean(recipient.isRia)}
                  className="h-8 w-8 text-[13px]"
                />
                <span className="flex min-w-0 flex-1 items-start gap-1.5 text-[17px] font-normal leading-[22px] text-[color:var(--app-label)]">
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {recipient.connectedFromContacts ? (
                    <ContactSourceBadge className="mt-px shrink-0" />
                  ) : null}
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

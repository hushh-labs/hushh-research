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
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";

import {
  EmptyState,
  SectionCard,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "./primitives";
import {
  RequestCard,
  SharedWithMeCard,
  TemporaryLinkCard,
  TrustedPersonCard,
} from "./cards";
import {
  DurationSelector,
  LocationTypeSelector,
  PersonSearchInput,
  ReasonChips,
  type LocationTypeValue,
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

  /* device + self location */
  readiness: {
    tone: ReadinessTone;
    title: string;
    description: string;
    actionLabel?: string | null;
  };
  permissionIsPrompt: boolean;
  locationEnabled: boolean;
  autoShareEnabled: boolean;
  locationPaused: boolean;
  locationAccuracyLimited: boolean;
  myLocationPoint: PlainLocationPoint | null;
  myLocationError: string | null;

  /* data lists */
  recipients: OneLocationRecipient[];
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
  onSendRequest: () => void;
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
  onTriggerSos: (message?: string | null) => void;
  onStopSos: () => void;
  onAddSmsContact: (recipientUserId: string) => void;
  onRemoveSmsContact: (recipientUserId: string) => Promise<boolean>;

  /* Check-In (quick action) — reuses the encrypted share pipeline. */
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
};

type FlowKind =
  | "none"
  | "share"
  | "ask"
  | "invite"
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

const BUSY = (vm: LocationHubViewModel, key: string) => vm.busy === key;

function LocationHeaderActions({ vm }: { vm: LocationHubViewModel }) {
  const locationOn = vm.locationEnabled;
  const toggling = BUSY(vm, "selfLocation");
  const refreshing = BUSY(vm, "load");
  const statusLabel = vm.locationPaused
    ? "Location paused"
    : vm.locationAccuracyLimited
      ? "Location limited"
      : locationOn
        ? "Location on"
        : "Location off";

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
          className={cn(
            "data-[state=checked]:bg-emerald-500 dark:data-[state=checked]:bg-emerald-400",
            toggling && "animate-pulse",
          )}
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
    let nextTab: LocationHubTab | null = null;
    let detailAction: FlowKind | null = null;
    if (section === "approvals" || section === "my_requests" || hasRequest) {
      detailAction = "needs-review";
    } else if (section === "shared" || hasGrant) {
      detailAction = "shared-with-me";
    } else if (section === "public_responses" || hasSubmission) {
      nextTab = "links";
    } else if (section === "people") {
      nextTab = "people";
    }
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
  const [shareLocationType, setShareLocationType] =
    useState<LocationTypeValue>("precise");
  const [temporaryLinkLocationType, setTemporaryLinkLocationType] =
    useState<LocationTypeValue>("precise");
  const [reason, setReason] = useState<ReasonValue | null>("Safety check-in");
  const activeFlowRef = useRef<FlowKind>("none");
  const resetShareComposer = vm.resetShareComposer;
  const startShareComposer = vm.startShareComposer;
  const setShareReviewOpen = vm.setShareReviewOpen;

  const resetShareLocalState = useCallback(() => {
    setShareStep("person");
    setShareLocationType("precise");
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
    [pathname, router, searchParams, vm],
  );

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
      setShareReviewOpen(false);
    }
  }, [
    nearbyCheckInAvailable,
    pathname,
    resetShareDraft,
    router,
    searchParams,
    setShareReviewOpen,
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
      setShareLocationType("precise");
      if (nearbyPrivateCheckIn) {
        router.replace(nearbyCheckInReturnHref, { scroll: false });
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
            locationType={shareLocationType}
            setLocationType={setShareLocationType}
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
            selectedUserIds={vm.smsContactUserIds}
            busyKey={vm.busy}
            onBack={() => closeFlow("now")}
            onAdd={vm.onAddSmsContact}
            onRemove={vm.onRemoveSmsContact}
            recipientLabel={vm.recipientLabel}
            recipientSubtitle={vm.recipientSubtitle}
            isRecipientShareReady={vm.isRecipientShareReady}
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
          <TemporaryLinkFlow
            vm={vm}
            locationType={temporaryLinkLocationType}
            setLocationType={setTemporaryLinkLocationType}
            onClose={closeFlow}
          />
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
              onStartShare={() => openShareFlow()}
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
              onOpenSettings={() => openFlow("settings")}
            />
          </LocationHubPanel>

          <LocationHubPanel>
            <PeopleHub
              vm={vm}
              onAddConnections={() => router.push(ROUTES.CONNECT)}
              onInvite={() => openFlow("invite")}
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
  onOpenSettings: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="one-location-now-hub">
      <SettingsGroup separatorInset testId="one-location-now-primary">
        <SettingsRow
          icon={Navigation}
          iconTone="blue"
          title="Share location"
          density="compact"
          chevron
          onClick={onStartShare}
          testId="one-location-share-row"
        />
        <SettingsRow
          icon={Map}
          iconTone="green"
          title="Your Map"
          density="compact"
          chevron
          onClick={onOpenMap}
          testId="one-location-map-row"
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
        />
        <SettingsRow
          icon={MapPin}
          iconTone="blue"
          title="Shared with me"
          density="compact"
          trailing={vm.receivedGrants.length}
          chevron
          onClick={onOpenSharedWithMe}
        />
        <SettingsRow
          icon={ShieldCheck}
          iconTone="orange"
          title="Needs my review"
          density="compact"
          trailing={vm.pendingOwnerRequests.length}
          chevron
          onClick={onOpenNeedsReview}
        />
        <SettingsRow
          icon={Lock}
          iconTone="gray"
          title="Settings"
          density="compact"
          chevron
          onClick={onOpenSettings}
          testId="one-location-settings-entry"
        />
      </SettingsGroup>

      <QuickActionsSection title="Quick actions" columns={2}>
        <QuickActionCard
          tone="green"
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Check-In"
          subtitle={checkInSubtitle}
          onClick={onCheckIn}
        />
        <QuickActionCard
          tone="red"
          icon={<Shield className="h-5 w-5" />}
          title="SMS"
          subtitle={vm.sosActive ? "Live now" : "Save my soul"}
          onClick={onSos}
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
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
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
    <div>
      <TaskFlowHeader
        eyebrow="Location"
        title="Settings"
        description="You control who sees your location and when. Change this anytime."
      />

      <p className="mt-6 px-1 text-[12px] font-bold uppercase tracking-[0.6px] text-black/40 dark:text-muted-foreground">
        Location sharing
      </p>
      <div className="mt-2.5 rounded-2xl bg-white px-4 shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-[color:var(--app-card-surface-default-solid)]">
        <div className="flex items-center gap-3.5 border-b border-black/[0.06] py-4 dark:border-white/10">
          <div className="flex-1">
            <p className="text-[16px] font-semibold text-[#1c1c2e] dark:text-foreground">
              Auto-share my location
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.45] text-black/50 dark:text-muted-foreground">
              On — approved shares keep receiving live updates. Off — new shares
              send only the location you explicitly confirm.
            </p>
          </div>
          <LocationToggle
            checked={vm.autoShareEnabled}
            onChange={vm.onAutoShareChange}
            label="Auto-share my location"
            disabled={BUSY(vm, "selfLocation")}
          />
        </div>
        <div className="flex items-center gap-3.5 py-4">
          <div className="flex-1">
            <p className="text-[16px] font-semibold text-[#1c1c2e] dark:text-foreground">
              Pause my location
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.45] text-black/50 dark:text-muted-foreground">
              Stop new private-share updates and check out from Nearby. Existing
              shares keep their expiry and may retain your last encrypted point.
            </p>
          </div>
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
          />
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2.5 px-1">
        <Shield className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[color:var(--app-accent)]" />
        <p className="text-[13px] leading-[1.5] text-black/50 dark:text-muted-foreground">
          Private shares stay in your circle. Nearby Check-In is separate and
          only starts after you explicitly agree.
        </p>
      </div>

      <p className="mt-7 px-1 text-[12px] font-bold uppercase tracking-[0.6px] text-black/40 dark:text-muted-foreground">
        Safety
      </p>
      <button
        type="button"
        onClick={onManageSmsContacts}
        className="mt-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-colors hover:bg-black/[0.02] dark:bg-[color:var(--app-card-surface-default-solid)]"
        data-testid="one-location-sms-contacts-entry"
      >
        <span className="min-w-0 flex-1 text-[16px] font-semibold text-[#1c1c2e] dark:text-foreground">
          SMS contacts
        </span>
        <span className="text-[14px] text-black/40 dark:text-muted-foreground">
          {smsContactCount}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-black/30 dark:text-muted-foreground" />
      </button>

      <div className="mt-7">
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
        "flex items-center gap-3 p-4",
        !first && "border-t border-black/[0.06] dark:border-white/10",
      )}
    >
      <div className="relative shrink-0">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: tint }}
        >
          {personInitials(name)}
        </span>
        {active ? (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-[#34c759] dark:border-[color:var(--app-card-surface-default-solid)]" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-bold text-[#1c1c2e] dark:text-foreground">
          {name}
        </p>
        <p className="truncate text-[13px] text-black/50 dark:text-muted-foreground">
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
  onStartShare,
  onAsk,
}: {
  vm: LocationHubViewModel;
  onAddConnections: () => void;
  onInvite: () => void;
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
        <SectionCard
          title="Trusted Circle"
          description="Only your connections can receive private live location."
        >
          <div className="grid grid-cols-1 gap-2">
            <Button
              onClick={onAddConnections}
              className="h-11 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
            >
              <UsersRound className="mr-2 h-4 w-4" />
              Add Connections
            </Button>
            <Button
              variant="outline"
              onClick={onInvite}
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
      <PersonSearchInput
        value={vm.recipientSearch}
        onChange={vm.setRecipientSearch}
      />

      {/* Compact circle-management actions. Invite adds people; "Sync contacts"
          tags which existing connections are in your phone contacts. */}
      <div className="grid grid-cols-1 gap-2">
        <Button
          onClick={onAddConnections}
          className="h-10 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
        >
          <UsersRound className="mr-2 h-4 w-4" />
          Add Connections
        </Button>
        <Button
          variant="outline"
          onClick={onInvite}
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
        <div className="overflow-hidden rounded-[20px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-[color:var(--app-card-surface-default-solid)]">
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
        className="flex w-full items-center gap-3.5 rounded-2xl bg-white p-4 text-left shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-colors hover:bg-black/[0.02] dark:bg-[color:var(--app-card-surface-default-solid)]"
      >
        <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-[#e7f0fd] dark:bg-sky-400/15">
          <Navigation className="h-[18px] w-[18px] text-[color:var(--app-accent)]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-[color:var(--app-accent)]">
            Ask someone to share
          </span>
          <span className="block text-[13px] text-black/50 dark:text-muted-foreground">
            Send a request — they approve first.
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-black/35 dark:text-muted-foreground" />
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
        "flex items-center gap-3.5 py-4",
        !first && "border-t border-black/[0.06] dark:border-white/10",
      )}
    >
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
          tileClass,
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-bold text-[#1c1c2e] dark:text-foreground">
          {title}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-black/50 dark:text-muted-foreground">
          {subtitle}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={onCopy}
        className="h-9 shrink-0 rounded-full border-[color:var(--app-accent)] px-4 text-sm font-semibold text-[color:var(--app-accent)]"
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
      <p className="px-1 text-[12px] font-bold uppercase tracking-[0.4px] text-black/40 dark:text-muted-foreground">
        Active links
      </p>

      {hasLinks ? (
        <div className="rounded-[20px] bg-white px-4 shadow-[0_4px_16px_rgba(0,0,0,0.06)] dark:bg-[color:var(--app-card-surface-default-solid)]">
          {temp ? (
            <ActiveLinkRow
              first
              tileClass="bg-[#efe9fb] dark:bg-violet-400/15"
              icon={<LinkIcon className="h-5 w-5 text-[#7c5cff]" />}
              title="Live location link"
              subtitle={`${vm.expiresCountdownLabel(temp.expiresAt)} · anyone with the link`}
              onCopy={vm.onCopyPublicInvite}
            />
          ) : null}
          {invite ? (
            <ActiveLinkRow
              first={!temp}
              tileClass="bg-[#e5f4ea] dark:bg-emerald-400/15"
              icon={<ShieldCheck className="h-5 w-5 text-[#2ea44f]" />}
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
        className="h-12 w-full rounded-full bg-[color:var(--app-accent)] text-[15px] font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
      >
        <Plus className="mr-2 h-4 w-4" />
        Create a new link
      </Button>

      <div className="flex items-start gap-2 px-1">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-black/40 dark:text-muted-foreground" />
        <p className="text-[12px] leading-[1.45] text-black/50 dark:text-muted-foreground">
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

function ShareFlow({
  vm,
  step,
  setStep,
  locationType,
  setLocationType,
  onClose,
}: {
  vm: LocationHubViewModel;
  step: "person" | "details";
  setStep: (s: "person" | "details") => void;
  locationType: LocationTypeValue;
  setLocationType: (v: LocationTypeValue) => void;
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
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Step 3 of 3 · Consent check"
          title="Before you start"
          description="Confirm exactly who can see you, what they see, and when access ends."
        />
        <SectionCard>
          <div className="space-y-3">
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
            <ReviewRow
              label="Location type"
              value={
                locationType === "precise"
                  ? "Precise live location"
                  : "Approximate area"
              }
            />
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
            <LocationTypeSelector
              value={locationType}
              onChange={setLocationType}
            />
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
      <PersonSearchInput
        value={vm.shareRecipientSearch}
        onChange={vm.setShareRecipientSearch}
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
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
          vm.onSendRequest();
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
              <p className="text-xs text-muted-foreground">
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

function TemporaryLinkFlow({
  vm,
  locationType,
  setLocationType,
  onClose,
}: {
  vm: LocationHubViewModel;
  locationType: LocationTypeValue;
  setLocationType: (v: LocationTypeValue) => void;
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
      <SectionCard title="Location type">
        <LocationTypeSelector
          value={locationType}
          onChange={setLocationType}
          label=""
        />
      </SectionCard>
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

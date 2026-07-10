"use client";

/**
 * LocationRedesignHub — mobile-first re-skin of the One Location feature.
 *
 * Figma source of truth: one_location_final_fixed_clean_navigation (node 10:1054),
 * 16 mobile screens organised as four hub tabs (Now | People | Links | Inbox)
 * plus focused, full-screen task flows (Share / Ask / Invite / Public location link).
 *
 * STRICTLY PRESENTATION + LOCAL VIEW-ROUTING.
 * - All data and every action handler are passed in via `vm` from the existing
 *   page component (hushh-webapp/app/one/location/page.tsx). This component does
 *   NOT call services, encrypt, or mutate consent state. It only renders and
 *   delegates to the existing handlers, so the feature's functionality, consent
 *   gating, analytics, and crypto are unchanged.
 * - The global app footer (components/navbar.tsx) is untouched. Local tabs here
 *   are a self-contained navigator shown only on hub/state screens, never inside
 *   focused task flows.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";


import {
  CalendarClock,
  Car,
  CheckCircle2,
  Hand,
  Home,
  Inbox as InboxIcon,
  Link as LinkIcon,
  MapPin,
  Plus,
  Send,
  ShieldAlert,
  UserPlus,
  UsersRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type {
  DriveDestination,
  OneLocationAccessRequest,

  OneLocationCircleInvite,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationRecipient,
  PlainLocationPoint,
} from "@/lib/one-location/types";

import {
  LocationLocalTabs,
  type LocationHubTab,
} from "./location-local-tabs";
import {
  EmptyState,
  LocationHeader,
  PrivacyStatusCard,
  QuickPathRow,
  SectionCard,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "./primitives";
import {
  ActiveShareCard,
  ActivityReceiptCard,
  DeviceReadinessCard,
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
import {
  QuickActionCard,
  QuickActionsSection,
} from "@/components/one-location/redesign/quick-actions";
import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { DriveToFlow } from "./drive-to-flow";
import { PickMeUpFlow } from "./pick-me-up-flow";
import { SafeArrivalFlow } from "./safe-arrival-flow";


type ReadinessTone = "ready" | "warning" | "blocked" | "checking";

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
  myLocationPoint: PlainLocationPoint | null;
  myLocationError: string | null;

  /* data lists */
  recipients: OneLocationRecipient[];
  visibleRecipients: OneLocationRecipient[];
  activeOwnerGrants: OneLocationGrant[];
  receivedGrants: OneLocationGrant[];
  pendingOwnerRequests: OneLocationAccessRequest[];
  requestedByMe: OneLocationAccessRequest[];
  latestActivePublicInvite: OneLocationPublicInvite | null;
  latestActiveCircleInvite: OneLocationCircleInvite | null;
  activityReceipts: { id: string; title: string; detail: string }[];

  /* composer state */
  recipientSearch: string;
  selectedRecipientIds: string[];
  selectedRequestOwnerIds: string[];
  durationHours: string;
  requestMessage: string;
  shareReviewOpen: boolean;
  publicInviteUrl: string;
  circleInviteUrl: string;

  /* setters (presentation state owned by page) */
  setRecipientSearch: (v: string) => void;
  setDurationHours: (v: string) => void;
  setRequestMessage: (v: string) => void;
  setShareReviewOpen: (v: boolean) => void;

  /* selection */
  toggleShareRecipient: (id: string, surface?: string) => void;
  toggleRequestOwner: (id: string, surface?: string) => void;

  /* actions — wired 1:1 to existing handlers */
  onRefresh: () => void;
  onShowMyLocation: () => void;
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

  /* SOS panic */
  sosRecipients: OneLocationRecipient[];
  sosActive: boolean;
  sosBusy: boolean;
  sosStartedAtLabel: string | null;
  onTriggerSos: () => void;
  onStopSos: () => void;

  /* Check-In (quick action) — reuses the encrypted share pipeline. The message
     is surfaced in the recipient's notification (e.g. "Alex: I've checked in
     here, let's catch up") so they see who checked in and why. */
  onCheckIn: (
    recipientIds: string[],
    durationHours: string,
    message?: string,
  ) => void;

  /* Drive To (quick action) — live location + live ETA to trusted people. */
  vaultOwnerToken: string | null;
  driveBusy: boolean;
  recentDestinations: DriveDestination[];
  onDriveTo: (
    destination: DriveDestination,
    recipientIds: string[],
    durationHours: string,
  ) => void;

  /* Pick Me Up (quick action) — inbound: share your LIVE location + a pickup
     message so a trusted person can drive straight to you and watch you until
     they arrive. Reuses the same encrypted share pipeline as Check-In. */
  onPickMeUp: (
    recipientIds: string[],
    durationHours: string,
    message?: string,
  ) => void;

  /* Safe Arrival (quick action) — outbound: share your live journey + ETA to a
     destination until you arrive, framed for peace-of-mind. Reuses the same
     encrypted drive pipeline as Drive To (destination + ETA ride inside the
     envelope). `safeArrivalBusy` drives the flow's loading state. */
  safeArrivalBusy: boolean;
  onSafeArrival: (
    destination: DriveDestination,
    recipientIds: string[],
    durationHours: string,
    message?: string,
  ) => void;


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
  | "drive-to"
  | "pick-me-up"
  | "safe-arrival"
  | "sos";


const BUSY = (vm: LocationHubViewModel, key: string) => vm.busy === key;

// People lists (Ready people / Pending invites) can grow long. Cap their height
// and let them scroll internally so a large Circle doesn't stretch the page into
// an endless column. ~max-h fits roughly 5 cards before scrolling; a thin,
// touch-friendly scrollbar keeps it unobtrusive on mobile.
const PEOPLE_LIST_SCROLL_CLASS =
  "max-h-[340px] space-y-2.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

const ACTIVE_SHARE_LIST_SCROLL_CLASS =
  "max-h-[470px] overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 dark:[&::-webkit-scrollbar-thumb]:bg-white/20";

export function LocationRedesignHub({ vm }: { vm: LocationHubViewModel }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<LocationHubTab>("now");
  const [flow, setFlow] = useState<FlowKind>("none");
  const [collapsedGrantIds, setCollapsedGrantIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Deep-link routing: notification "Open" buttons land here with a `section`
  // (or requestId/grantId/submissionId) query param. The page-level tabs are
  // compose/activity, but the ACTIVE UI is this hub (now/people/links/inbox),
  // which owns its own tab state — so it must consume the deep-link itself and
  // switch to the correct hub tab. Sections map: shared/approvals/my_requests →
  // inbox, public_responses → links. An access-request (`requestId`) or the
  // approvals section opens Inbox so User A/B lands on the approve/deny +
  // "Shared with me" surfaces. Runs on every param change (Next.js keeps the
  // component mounted across same-path query navigations).
  useEffect(() => {
    const section = String(
      searchParams.get("section") || "",
    ).trim();
    const hasRequest = Boolean(String(searchParams.get("requestId") || "").trim());
    const hasGrant = Boolean(String(searchParams.get("grantId") || "").trim());
    const hasSubmission = Boolean(
      String(searchParams.get("submissionId") || "").trim(),
    );
    let nextTab: LocationHubTab | null = null;
    // Which Inbox subsection the notification should land on: an access request
    // (approvals) scrolls to "Needs your review"; a share (shared) scrolls to
    // "Shared with me". Anything else just lands on the tab top.
    let inboxAnchor: string | null = null;
    if (
      section === "approvals" ||
      section === "my_requests" ||
      hasRequest
    ) {
      nextTab = "inbox";
      inboxAnchor = "one-location-inbox-review";
    } else if (section === "shared" || hasGrant) {
      nextTab = "inbox";
      inboxAnchor = "one-location-inbox-shared";
    } else if (section === "public_responses" || hasSubmission) {
      nextTab = "links";
    } else if (section === "people") {
      nextTab = "people";
    }
    if (nextTab) {
      // A notification deep-link must always land on the hub, never inside a
      // half-open task flow (Share / Ask / Invite / Temp link). Close any flow
      // first so the routed tab is actually visible.
      setFlow("none");
      setTab(nextTab);
    }
    // After switching to Inbox, smooth-scroll to the exact subsection so the
    // user immediately sees the allow/deny request or the shared-with-me card
    // (rather than the top of a long Inbox). Retry a few frames to cover the
    // tab transition + list render.
    if (inboxAnchor && typeof window !== "undefined") {
      const anchorId = inboxAnchor;
      let attempts = 0;
      const tryScroll = () => {
        const el = document.getElementById(anchorId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        attempts += 1;
        if (attempts <= 12) {
          window.setTimeout(tryScroll, 80);
        }
      };
      window.setTimeout(tryScroll, 120);
    }
  }, [searchParams]);


  const [shareStep, setShareStep] = useState<"person" | "details">("person");
  const [locationType, setLocationType] =
    useState<LocationTypeValue>("precise");
  const [reason, setReason] = useState<ReasonValue | null>("Safety check-in");

  const inboxCount = vm.pendingOwnerRequests.length;
  const hasActiveShare = vm.activeOwnerGrants.length > 0;

  const closeFlow = () => {
    setFlow("none");
    setShareStep("person");
    vm.setShareReviewOpen(false);
  };

  // When a share completes successfully (page bumps shareCompletedTick), close
  // the 3-step share flow and return to the main One Location hub.
  const lastShareTickRef = useRef(vm.shareCompletedTick);
  useEffect(() => {
    if (vm.shareCompletedTick !== lastShareTickRef.current) {
      lastShareTickRef.current = vm.shareCompletedTick;
      // Closing the flow returns to the hub; the share flow always launches
      // from the "Now" tab, so no explicit tab change is needed.
      setFlow("none");
      setShareStep("person");
    }

  }, [vm.shareCompletedTick]);


  /* ----------------------------------------------------------------- */
  /* Task flows (full-screen, no local tabs)                           */
  /* ----------------------------------------------------------------- */
  if (flow !== "none") {
    return (
      <div className="space-y-6">
        {flow === "share" ? (
          <ShareFlow
            vm={vm}
            step={shareStep}
            setStep={setShareStep}
            locationType={locationType}
            setLocationType={setLocationType}
            onClose={closeFlow}
          />
        ) : flow === "ask" ? (
          <AskFlow
            vm={vm}
            reason={reason}
            setReason={setReason}
            onClose={closeFlow}
          />
        ) : flow === "check-in" ? (
          <CheckInFlow vm={vm} onClose={closeFlow} />
        ) : flow === "drive-to" ? (
          <DriveToFlow vm={vm} onClose={closeFlow} />
        ) : flow === "pick-me-up" ? (
          <PickMeUpFlow vm={vm} onClose={closeFlow} />
        ) : flow === "safe-arrival" ? (
          <SafeArrivalFlow vm={vm} onClose={closeFlow} />
        ) : flow === "sos" ? (

          <SosFlow vm={vm} onClose={closeFlow} />
        ) : flow === "invite" ? (
          <InviteFlow vm={vm} onClose={closeFlow} />
        ) : (
          <TemporaryLinkFlow
            vm={vm}
            locationType={locationType}
            setLocationType={setLocationType}
            onClose={closeFlow}
          />
        )}
      </div>
    );
  }

  /* ----------------------------------------------------------------- */
  /* Hub (Now | People | Links | Inbox)                                */
  /* ----------------------------------------------------------------- */
  const headerSubtitle =
    tab === "now"
      ? "Private by default"
      : tab === "people"
        ? "Circle, contacts and invites"
        : tab === "links"
          ? "Public location and invite links"
          : "Requests and shared locations";

  return (
    <div className="space-y-5">
      <LocationHeader
        title="One Location"
        subtitle={headerSubtitle}
        trailing={
          <Button
            variant="outline"
            size="sm"
            onClick={vm.onRefresh}
            isLoading={BUSY(vm, "load")}
            className="h-9 rounded-full px-3 text-sm"
          >
            Refresh
          </Button>
        }
      />

      <LocationLocalTabs
        value={tab}
        onChange={setTab}
        badges={inboxCount ? { inbox: inboxCount } : undefined}
      />

      {tab === "now" ? (
        <NowHub
          vm={vm}
          hasActiveShare={hasActiveShare}
          inboxCount={inboxCount}
          onStartShare={() => {
            setShareStep("person");
            setFlow("share");
          }}
          onAsk={() => setFlow("ask")}
          onCheckIn={() => setFlow("check-in")}
          onDriveTo={() => setFlow("drive-to")}
          onPickMeUp={() => setFlow("pick-me-up")}
          onSafeArrival={() => setFlow("safe-arrival")}
          onSos={() => setFlow("sos")}
          onGoTab={setTab}
        />

      ) : tab === "people" ? (
        <PeopleHub
          vm={vm}
          onInvite={() => setFlow("invite")}
          onStartShare={() => {
            setShareStep("person");
            setFlow("share");
          }}
        />
      ) : tab === "links" ? (
        <LinksHub vm={vm} onCreateTempLink={() => setFlow("temp-link")} />
      ) : (
        <InboxHub
          vm={vm}
          collapsedGrantIds={collapsedGrantIds}
          onCollapseGrant={(grantId) =>
            setCollapsedGrantIds((current) => {
              if (current.has(grantId)) return current;
              const next = new Set(current);
              next.add(grantId);
              return next;
            })
          }
          onExpandGrant={(grant) => {
            setCollapsedGrantIds((current) => {
              if (!current.has(grant.id)) return current;
              const next = new Set(current);
              next.delete(grant.id);
              return next;
            });
            if (!vm.decryptedPoints[grant.id]) {
              vm.onViewGrant(grant);
            }
          }}
        />
      )}
    </div>
  );
}

/* =================================================================== */
/* NOW HUB                                                              */
/* =================================================================== */

function NowHub({
  vm,
  hasActiveShare,
  inboxCount,
  onStartShare,
  onAsk,
  onCheckIn,
  onDriveTo,
  onPickMeUp,
  onSafeArrival,
  onSos,
  onGoTab,
}: {
  vm: LocationHubViewModel;
  hasActiveShare: boolean;
  inboxCount: number;
  onStartShare: () => void;
  onAsk: () => void;
  onCheckIn: () => void;
  onDriveTo: () => void;
  onPickMeUp: () => void;
  onSafeArrival: () => void;
  onSos: () => void;
  onGoTab: (tab: LocationHubTab) => void;
}) {

  // When location permission is blocked (denied / restricted / services off),
  // surface the Device readiness card at the very TOP so the user immediately
  // sees how to fix it, instead of it sitting in the middle of the page.
  const readinessBlocked = vm.readiness.tone === "blocked";
  const deviceReadinessCard = (
    <SectionCard title="Device readiness">
      <DeviceReadinessCard
        tone={vm.readiness.tone}
        title={vm.readiness.title}
        description={vm.readiness.description}
        actionLabel={vm.readiness.actionLabel ?? undefined}
        onAction={
          vm.readiness.actionLabel
            ? vm.permissionIsPrompt
              ? vm.onRequestPermission
              : vm.onOpenLocationSettings
            : undefined
        }
        actionBusy={vm.busy === "locationSettings"}
        onRefresh={vm.onShowMyLocation}
        refreshBusy={vm.busy === "selfLocation"}
        refreshLabel={vm.myLocationPoint ? "Refresh location" : "Show my location"}
      />
      {vm.myLocationError ? (
        <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-300">
          {vm.myLocationError}
        </p>
      ) : null}
      {vm.myLocationPoint ? (
        <div className="mt-3">{vm.renderMapPreview(vm.myLocationPoint, false)}</div>
      ) : null}
    </SectionCard>
  );

  return (
    <div className="space-y-5">
      {readinessBlocked ? deviceReadinessCard : null}

      <PrivacyStatusCard
        isSharing={hasActiveShare}
        headline={hasActiveShare ? "Sharing in progress" : "Private right now"}
        lines={
          hasActiveShare
            ? ["You are sharing live only for the time you chose."]
            : ["No one can see your location.", "You share only after review."]
        }
      />

      <div className="grid grid-cols-2 gap-3">

        <Button
          onClick={onStartShare}
          className="h-12 whitespace-normal rounded-2xl bg-[#d4a574] px-2 text-center text-[13px] font-semibold leading-tight text-white hover:bg-[#d4a574]/90 sm:text-base"
        >
          <MapPin className="mr-1.5 h-4 w-4 shrink-0" />
          Share my location
        </Button>
        <Button
          variant="outline"
          onClick={onAsk}
          className="h-12 whitespace-normal rounded-2xl px-2 text-center text-[13px] font-semibold leading-tight sm:text-base"
        >
          <Send className="mr-1.5 h-4 w-4 shrink-0" />
          Ask someone
        </Button>
      </div>

      {/* Quick actions — six reusable location shortcuts. Five are live
          (Check-In, SOS, Drive To, Pick Me Up, Safe Arrival); only "Meeting"
          remains "Coming soon". When SOS is already active, its card reflects
          the live state and reopens the panel to stop sharing. */}
      <QuickActionsSection title="Quick actions">

        <QuickActionCard
          tone="green"
          icon={<CheckCircle2 className="h-6 w-6" />}
          title="Check-In"
          subtitle="Share now"
          onClick={onCheckIn}
        />
        <QuickActionCard
          tone="red"
          icon={<ShieldAlert className="h-6 w-6" />}
          title="SOS"
          subtitle={vm.sosActive ? "Live now" : "Emergency"}
          onClick={onSos}
          badge={
            vm.sosActive ? (
              <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600 dark:text-red-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
                </span>
                Live
              </span>
            ) : undefined
          }
        />
        <QuickActionCard
          tone="blue"
          icon={<Car className="h-6 w-6" />}
          title="Drive To"
          subtitle="Share route + ETA"
          onClick={onDriveTo}
        />
        <QuickActionCard
          tone="amber"
          icon={<Hand className="h-6 w-6" />}
          title="Pick Me Up"
          subtitle="Come get me"
          onClick={onPickMeUp}
        />
        <QuickActionCard
          tone="green"
          icon={<Home className="h-6 w-6" />}
          title="Safe Arrival"
          subtitle="Watch me home"
          onClick={onSafeArrival}
        />
        <QuickActionCard
          tone="violet"
          icon={<CalendarClock className="h-6 w-6" />}
          title="Meeting"
          subtitle="Venue"
          comingSoon
        />

      </QuickActionsSection>

      {/* Active SOS banner (only while an incident is live) — quick stop
          without opening the full SOS panel. */}
      {vm.sosActive ? (
        <button
          type="button"
          onClick={onSos}
          className="flex w-full items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-left transition-colors hover:bg-red-500/15"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-red-700 dark:text-red-300">
              SOS live location active
            </span>
            <span className="block text-xs text-red-600/80 dark:text-red-300/80">
              {vm.sosStartedAtLabel
                ? `Since ${vm.sosStartedAtLabel} · tap to manage`
                : "Tap to manage or stop"}
            </span>
          </span>
        </button>
      ) : null}

      {/* Active shares */}
      <SectionCard title="Active shares">
        {hasActiveShare ? (
          <div
            role="list"
            aria-label="Active shares"
            className={cn(
              "space-y-2.5",
              vm.activeOwnerGrants.length > 3 &&
                ACTIVE_SHARE_LIST_SCROLL_CLASS,
            )}
          >
            {vm.activeOwnerGrants.map((grant) => (
              <div key={grant.id} role="listitem">
                <ActiveShareCard
                  name={vm.grantRecipientLabel(grant)}
                  expiryLabel={vm.expiresCountdownLabel(grant.expiresAt)}
                  metaLabel={`Started ${vm.formatDateTime(grant.createdAt)}`}
                  onStop={() => vm.onStopGrant(grant.id)}
                  stopBusy={vm.revokingGrantId === grant.id}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No active shares"
            description="You are not sharing with anyone."
          />
        )}
      </SectionCard>

      {/* Device readiness — rendered here in normal flow; when blocked it is
          hoisted to the very top of the page above (so don't duplicate it). */}
      {readinessBlocked ? null : deviceReadinessCard}

      {/* Quick paths */}

      <SectionCard title="Quick paths">
        <div className="space-y-2.5">
          <QuickPathRow
            icon={<UsersRound className="h-4 w-4" />}
            title="People"
            description="Trusted Circle and invites"
            onClick={() => onGoTab("people")}
          />
          <QuickPathRow
            icon={<LinkIcon className="h-4 w-4" />}
            title="Links"
            description="Public location sharing"
            onClick={() => onGoTab("links")}
          />
          <QuickPathRow
            icon={<InboxIcon className="h-4 w-4" />}
            title="Inbox"
            description="Requests and shared locations"
            badge={inboxCount ? `${inboxCount} new` : undefined}
            onClick={() => onGoTab("inbox")}
          />
        </div>
      </SectionCard>
    </div>
  );
}

/* =================================================================== */
/* PEOPLE HUB                                                           */
/* =================================================================== */

function PeopleHub({
  vm,
  onInvite,
  onStartShare,
}: {
  vm: LocationHubViewModel;
  onInvite: () => void;
  onStartShare: () => void;
}) {
  const ready = vm.visibleRecipients.filter((r) =>
    vm.isRecipientShareReady(r),
  );
  const hasSearchQuery = vm.recipientSearch.trim().length > 0;

  return (
    <div className="space-y-5">
      <SectionCard
        title="Trusted Circle"
        description="Only your connections can receive private live location."
      >
        <div className="grid grid-cols-1 gap-2">
          <Button
            onClick={onInvite}
            className="h-11 rounded-full bg-[#d4a574] text-sm font-semibold text-white hover:bg-[#d4a574]/90"
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

      <SectionCard title="Ready people">
        <PersonSearchInput
          value={vm.recipientSearch}
          onChange={vm.setRecipientSearch}
        />
        {ready.length ? (
          <div className={cn("mt-3", PEOPLE_LIST_SCROLL_CLASS)}>
            {ready.map((r) => (
              <TrustedPersonCard
                key={r.userId}
                name={vm.recipientLabel(r)}
                subtitle="Ready for private sharing"
                tone="ready"
                statusLabel="Ready"
                actionLabel="Share"
                actionAriaLabel={`Share location with ${vm.recipientLabel(r)}`}
                onAction={() => {
                  vm.toggleShareRecipient(r.userId, "people_hub");
                  onStartShare();
                }}
              />
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState
              title={hasSearchQuery ? "No matching people" : "Build your trusted circle"}
              description={
                hasSearchQuery
                  ? "Try a different name."
                  : "Add connections so the people you trust can receive your live location."
              }
              action={
                hasSearchQuery ? undefined : (
                  <Link
                    href="/connect"
                    className="inline-flex h-9 items-center rounded-full bg-[#d4a574] px-4 text-sm font-semibold text-white hover:bg-[#d4a574]/90"
                  >
                    Add connections
                  </Link>
                )
              }
            />
          </div>
        )}
      </SectionCard>

      <TrustNoteCard
        title="Private sharing starts after approval"
        description="They must sign in, verify phone and accept first."
      />
    </div>
  );
}

/* =================================================================== */
/* LINKS HUB                                                            */
/* =================================================================== */

function LinksHub({
  vm,
  onCreateTempLink,
}: {
  vm: LocationHubViewModel;
  onCreateTempLink: () => void;
}) {
  const temp = vm.latestActivePublicInvite;
  const invite = vm.latestActiveCircleInvite;

  return (
    <div className="space-y-5">
      <SectionCard
        title="Links"
        description="Use links only when someone is not in your trusted Circle."
      >
        <Button
          onClick={onCreateTempLink}
          className="h-11 w-full rounded-full bg-[#d4a574] text-sm font-semibold text-white hover:bg-[#d4a574]/90"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create public location link
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Anyone with the link can view until expiry.
        </p>
      </SectionCard>

      <SectionCard title="Active public location link">
        {temp ? (
          <TemporaryLinkCard
            title="Public location link active"
            statusLine="Anyone with this link can view you"
            expiryLabel={vm.expiresCountdownLabel(temp.expiresAt)}
            onCopy={vm.onCopyPublicInvite}
            onShare={vm.onSharePublicInvite}
            onRevoke={() => vm.onRevokePublicInvite(temp)}
            revokeBusy={vm.busy === "publicRevoke"}
          />
        ) : (
          <EmptyState
            title="No active public location link"
            description="Create one above when you need to share outside your Circle."
          />
        )}
      </SectionCard>

      <SectionCard title="Invite link">
        {invite ? (
          <TemporaryLinkCard
            title="Circle invite link"
            statusLine="Invite pending approval"
            expiryLabel={vm.expiresCountdownLabel(invite.expiresAt)}
            onCopy={vm.onCopyCircleInvite}
            onShare={vm.onShareCircleInvite}
            onRevoke={() => vm.onRevokeCircleInvite(invite)}
            revokeBusy={vm.busy === "circleRevoke"}
          />
        ) : (
          <EmptyState
            title="No active invite link"
            description="Invite someone to your Circle from the People tab."
          />
        )}
      </SectionCard>

      <TrustNoteCard
        title="Safe by default"
        description="Links auto-expire and can be revoked anytime."
      />
    </div>
  );
}

/* =================================================================== */
/* INBOX HUB                                                            */
/* =================================================================== */

function InboxHub({
  vm,
  collapsedGrantIds,
  onCollapseGrant,
  onExpandGrant,
}: {
  vm: LocationHubViewModel;
  collapsedGrantIds: Set<string>;
  onCollapseGrant: (grantId: string) => void;
  onExpandGrant: (grant: OneLocationGrant) => void;
}) {
  const received = vm.receivedGrants;
  return (
    <div className="space-y-5">
      {/* Anchor: notification deep-links for access requests (approve/deny)
          scroll here via #one-location-inbox-review. `scroll-mt` keeps the
          heading clear of the sticky header after scrollIntoView. */}
      <div id="one-location-inbox-review" className="scroll-mt-24">
      <SectionCard title="Needs your review">

        {vm.pendingOwnerRequests.length ? (
          <div className="space-y-2.5">
            {vm.pendingOwnerRequests.map((request) => (
              <RequestCard
                key={request.id}
                name={vm.requesterLabel(request)}
                promptLine="to see your live location"
                reason={request.message ?? undefined}
                durationLabel="If approved: 1 hour"
                approveLabel="Share 1 hour"
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
        )}
      </SectionCard>
      </div>

      {/* Anchor: notification deep-links for received shares scroll here via
          #one-location-inbox-shared so the recipient lands directly on the
          person's live-location card. */}
      <div id="one-location-inbox-shared" className="scroll-mt-24">
      <SectionCard title="Shared with me">
        {received.length ? (

          <div className="space-y-2.5">
            {received.map((grant) => {
              const point = vm.decryptedPoints[grant.id];
              const previewExpanded =
                Boolean(point) && !collapsedGrantIds.has(grant.id);
              return (
                <SharedWithMeCard
                  key={grant.id}
                  name={vm.grantOwnerLabel(grant)}
                  statusLine={vm.expiresLabel(grant.expiresAt)}
                  metaLine={
                    point
                      ? `Updated ${vm.formatDateTime(point.capturedAt)}`
                      : undefined
                  }
                  previewExpanded={previewExpanded}
                  mapHref={point ? vm.mapLocationHref(point) : undefined}
                  onView={() => onExpandGrant(grant)}
                  onDismiss={() => onCollapseGrant(grant.id)}
                  viewBusy={vm.busy === "view"}
                >
                  {previewExpanded && point
                    ? vm.renderMapPreview(point, true)
                    : null}
                </SharedWithMeCard>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No active items after expiry"
            description="Locations shared with you appear here while they are live."
          />
        )}
      </SectionCard>
      </div>

      {vm.requestedByMe.length ? (

        <SectionCard title="Sent by you">
          <div className="space-y-2.5">
            {vm.requestedByMe.map((request) => (
              <div
                key={request.id}
                className="flex items-center justify-between gap-3 rounded-[18px] border border-border/60 bg-muted/40 p-3.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {vm.requestOwnerLabel(request)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Status {request.status} · {vm.formatDateTime(request.requestedAt)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-xs font-semibold capitalize text-muted-foreground">
                  {request.status}
                </span>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {vm.activityReceipts.length ? (
        <SectionCard title="Recent receipts">
          <div className="space-y-2">
            {vm.activityReceipts.slice(0, 5).map((receipt) => (
              <ActivityReceiptCard
                key={receipt.id}
                title={receipt.title}
                detail={receipt.detail}
              />
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/* =================================================================== */
/* SOS FLOW (Quick Action wrapper around the existing SOS panic panel)  */
/* =================================================================== */

function SosFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  return (
    <div className="space-y-5">
      {/* Minimal back-nav header only. The SosPanel below renders the single
          "SOS" header, so we intentionally do NOT repeat an "SOS" title here
          (that produced the duplicate-header the screenshot flagged). */}
      <TaskFlowHeader eyebrow="Location" title="Emergency" onBack={onClose} />
      <SosPanel
        recipients={vm.sosRecipients}
        active={vm.sosActive}
        busy={vm.sosBusy}
        startedAtLabel={vm.sosStartedAtLabel}
        onTrigger={vm.onTriggerSos}
        onStop={vm.onStopSos}
        recipientLabel={vm.recipientLabel}
        isRecipientShareReady={vm.isRecipientShareReady}
      />
      <TrustNoteCard
        title="Only your trusted contacts are alerted"
        description="The same people who receive your SOS also appear in Check-In. Nothing is shared publicly."
      />
      {/* Inline so it renders above the chat panel, not floating over it. */}
      <Button
        variant="ghost"
        onClick={onClose}
        className="h-11 w-full rounded-2xl text-sm text-muted-foreground"
      >
        Back to One Location
      </Button>
    </div>
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
  const filtered = vm.visibleRecipients;
  const selectedReady = vm.recipients.filter(
    (r) =>
      vm.selectedRecipientIds.includes(r.userId) && vm.isRecipientShareReady(r),
  );

  // Review screen (consent check) is driven by the existing shareReviewOpen flag.
  if (vm.shareReviewOpen) {
    const primary = selectedReady[0];
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Step 3 of 3 · Consent check"
          title="Before you start"
          description="Confirm exactly who can see you, what they see, and when access ends."
          onBack={() => vm.setShareReviewOpen(false)}
        />
        <SectionCard>
          <div className="space-y-3">
            <ReviewRow
              label="Can see"
              value={primary ? vm.recipientLabel(primary) : "Selected people"}
            />
            <ReviewRow
              label="Location type"
              value={
                locationType === "precise"
                  ? "Precise live location"
                  : "Approximate area"
              }
            />
            <ReviewRow label="Duration" value={durationLabel(vm.durationHours)} />
            <ReviewRow label="Control" value="You can stop anytime" />
          </div>
        </SectionCard>
        <TrustNoteCard
          title="Access ends automatically after expiry"
          description="Never share if you feel pressured. You are always in control."
        />
        <div className="space-y-2.5">
          <Button
            onClick={vm.onConfirmShare}
            isLoading={vm.busy === "share"}
            className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90"
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
          onBack={() => setStep("person")}
        />
        <SectionCard>
          <div className="space-y-5">
            <LocationTypeSelector value={locationType} onChange={setLocationType} />
            <DurationSelector
              value={vm.durationHours}
              onChange={vm.setDurationHours}
            />
            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">
                Optional note
              </p>
              <textarea
                value={vm.requestMessage}
                onChange={(e) => vm.setRequestMessage(e.target.value)}
                rows={2}
                maxLength={80}
                placeholder="On my way to the meeting"
                className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[#d4a574]/25"
              />
            </div>
          </div>
        </SectionCard>
        <TrustNoteCard
          title="Private by design"
          description="They can see you only for the selected time."
        />
        <Button
          onClick={vm.onOpenShareReview}
          disabled={!vm.canShare}
          isLoading={vm.busy === "share"}
          className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90 disabled:opacity-50"
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
        onBack={onClose}
      />
      <PersonSearchInput
        value={vm.recipientSearch}
        onChange={vm.setRecipientSearch}
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
                    ? "Ready for private sharing"
                    : "Invite first to enable sharing"
                }
                tone={ready ? "ready" : "pending"}
                actionLabel={ready ? (selected ? "Selected" : "Select") : undefined}
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
        className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90 disabled:opacity-50"
      >
        Continue
      </Button>

    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-3 last:border-0 last:pb-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm font-medium text-foreground">
        {value}
      </span>
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
        onBack={onClose}
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
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[#d4a574]/25"
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
        className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90 disabled:opacity-50"
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
  const created = Boolean(vm.circleInviteUrl) || Boolean(vm.latestActiveCircleInvite);

  if (created) {
    const invite = vm.latestActiveCircleInvite;
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Share invite link"
          title="Invite link created"
          description="They must approve before location sharing starts."
          onBack={onClose}
        />
        <SectionCard>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#d4a574]/12 text-[#d4a574]">
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
            className="h-11 rounded-full bg-[#d4a574] text-sm font-semibold text-white hover:bg-[#d4a574]/90"
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
        onBack={onClose}
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
        className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90"
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
  const created = Boolean(vm.publicInviteUrl) || Boolean(vm.latestActivePublicInvite);

  if (created) {
    const invite = vm.latestActivePublicInvite;
    return (
      <div className="space-y-5">
        <TaskFlowHeader
          eyebrow="Copy, share or revoke"
          title="Public location link active"
          onBack={onClose}
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
        onBack={onClose}
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
        className="h-12 w-full rounded-2xl bg-[#d4a574] text-base font-semibold text-white hover:bg-[#d4a574]/90"
      >
        Review public location link
      </Button>
    </div>
  );
}

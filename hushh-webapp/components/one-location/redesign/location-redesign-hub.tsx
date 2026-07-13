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


import {
  Calendar,
  Car,
  ChevronRight,
  Clock,
  Hand,
  Heart,
  Link as LinkIcon,
  Lock,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Shield,
  ShieldCheck,
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
  SectionCard,
  TaskFlowHeader,
  TrustNoteCard,
  WarningCard,
} from "./primitives";
import { SharingStatusCard } from "./sharing-status-card";
import {
  ActiveShareCard,
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
    pickupPoint?: { latitude: number; longitude: number; label?: string },
  ) => void;

  /* "I'm on my way" — helper reverse share: creates a drive-style grant back to
     the requester so they can watch the helper approach their pickup point. */
  onImOnMyWay: (grant: OneLocationGrant) => void;

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
  /** Latest decrypted live point for a contact who is sharing with the user, else null. */
  recipientLivePoint: (userId: string) => PlainLocationPoint | null;
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
  | "sos"
  | "privacy";


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
        ) : flow === "privacy" ? (
          <PrivacyFlow
            onClose={closeFlow}
            onManageSharing={() => {
              closeFlow();
              setTab("people");
            }}
          />
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
      ? ""
      : tab === "people"
        ? "Circle, contacts and invites"
        : tab === "links"
          ? "Public location and invite links"
          : "Requests and shared locations";

  return (
    <div className="space-y-5">
      <LocationHeader
        title="Onepoint"
        subtitle={headerSubtitle}
        trailing={
          <button
            type="button"
            onClick={vm.onRefresh}
            disabled={BUSY(vm, "load")}
            className="inline-flex items-center gap-[7px] rounded-[14px] border border-[rgba(0,122,255,0.32)] bg-white px-4 py-[11px] text-[15px] font-semibold text-[#007aff] transition-colors hover:bg-[#f5f9ff] disabled:opacity-60"
          >
            <RefreshCw
              className={cn("h-[15px] w-[15px]", BUSY(vm, "load") && "animate-spin")}
              aria-hidden="true"
            />
            Refresh
          </button>
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
          onOpenPrivacy={() => setFlow("privacy")}
        />

      ) : tab === "people" ? (
        <PeopleHub
          vm={vm}
          onInvite={() => setFlow("invite")}
          onStartShare={() => {
            setShareStep("person");
            setFlow("share");
          }}
          onAsk={() => setFlow("ask")}
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
  onStartShare,
  onAsk,
  onCheckIn,
  onDriveTo,
  onPickMeUp,
  onSafeArrival: _onSafeArrival,
  onSos,
  onOpenPrivacy,
}: {
  vm: LocationHubViewModel;
  hasActiveShare: boolean;
  onStartShare: () => void;
  onAsk: () => void;
  onCheckIn: () => void;
  onDriveTo: () => void;
  onPickMeUp: () => void;
  onSafeArrival: () => void;
  onSos: () => void;
  onOpenPrivacy: () => void;
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
      {/* The live map now lives in the SharingStatusCard hero above; the
          readiness card keeps only the device status + refresh controls. */}
    </SectionCard>
  );

  return (
    <div className="space-y-5">
      {readinessBlocked ? deviceReadinessCard : null}

      <SharingStatusCard
        isSharing={hasActiveShare}
        title={hasActiveShare ? "Sharing in progress" : "Private right now"}
        subtitle={
          hasActiveShare
            ? "Sharing live for the time you chose."
            : "No one can see your location. You share only after review."
        }
        endsLabel={
          hasActiveShare && vm.activeOwnerGrants[0]
            ? vm.expiresCountdownLabel(vm.activeOwnerGrants[0].expiresAt)
            : null
        }
        startedLabel={
          hasActiveShare && vm.activeOwnerGrants[0]
            ? `Started ${vm.formatDateTime(vm.activeOwnerGrants[0].createdAt)}`
            : null
        }
        people={
          hasActiveShare
            ? vm.activeOwnerGrants
                .slice(0, 3)
                .map((g) => ({ id: g.id, name: vm.grantRecipientLabel(g) }))
            : []
        }
        point={vm.myLocationPoint}
        onTapShare={onStartShare}
        live={hasActiveShare || Boolean(vm.myLocationPoint)}
        onToggle={vm.onShowMyLocation}
        toggleBusy={vm.busy === "selfLocation"}
      />

      {/* Capture errors surface here now that the OFF/LIVE badge on the hero
          drives location capture (the Device readiness section is only shown
          when permissions are blocked). */}
      {vm.myLocationError && !readinessBlocked ? (
        <p className="px-1 text-xs font-medium text-red-600 dark:text-red-300">
          {vm.myLocationError}
        </p>
      ) : null}

      <div className="grid grid-cols-[1.25fr_1fr] gap-3">

        <Button
          onClick={onStartShare}
          className="h-12 whitespace-nowrap rounded-2xl bg-[#007aff] px-3 text-center text-[13px] font-semibold text-white hover:bg-[#007aff]/90 sm:text-base"
        >
          <Navigation className="mr-1.5 h-4 w-4 shrink-0" />
          Share my location
        </Button>
        <Button
          variant="outline"
          onClick={onAsk}
          className="h-12 whitespace-nowrap rounded-2xl border-[#007aff] px-3 text-center text-[13px] font-semibold text-[#007aff] hover:bg-[#007aff]/10 sm:text-base"
        >
          <UsersRound className="mr-1.5 h-4 w-4 shrink-0" />
          Ask someone
        </Button>
      </div>

      {/* Quick actions — six location shortcuts on a 3-col grid. Four are live
          (Check-In, Alert, Drive To, Pick Me Up); "Meeting" and "Safe Arrival"
          are coming soon. "Alert" opens the SOS/notify-circle panel. */}
      <QuickActionsSection title="Quick actions">

        <QuickActionCard
          tone="green"
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Check-In"
          subtitle="Share now"
          onClick={onCheckIn}
        />
        <QuickActionCard
          tone="red"
          icon={<Shield className="h-5 w-5" />}
          title="Alert"
          subtitle={vm.sosActive ? "Live now" : "Notify circle"}
          onClick={onSos}
        />
        <QuickActionCard
          tone="blue"
          icon={<Car className="h-5 w-5" />}
          title="Drive To"
          subtitle="Share route + ETA"
          onClick={onDriveTo}
        />
        <QuickActionCard
          tone="blue"
          icon={<Hand className="h-5 w-5" />}
          title="Pick Me Up"
          subtitle="Let someone come"
          onClick={onPickMeUp}
        />
        <QuickActionCard
          tone="violet"
          icon={<Calendar className="h-5 w-5" />}
          title="Meeting"
          subtitle="Set a time & place"
          comingSoon
        />
        <QuickActionCard
          tone="slate"
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Safe Arrival"
          subtitle="Get notified"
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

      {/* Device readiness is only surfaced when permissions are BLOCKED (it is
          hoisted to the very top of the page above). In the normal flow the
          OFF/LIVE badge on the hero card now captures your live location, so we
          no longer show a separate readiness/capture section here. */}

      {/* Privacy — opens the full-screen Privacy flow (Apple Blue v2 design). */}
      <button
        type="button"
        onClick={onOpenPrivacy}
        className="flex w-full items-center gap-3.5 rounded-2xl bg-white p-4 text-left shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-colors hover:bg-black/[0.02] dark:bg-[color:var(--app-card-surface-default-solid)]"
      >
        <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-[#e7f0fd] dark:bg-sky-400/15">
          <Lock className="h-[18px] w-[18px] text-[#007aff]" />
        </span>
        <span className="flex-1 text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
          Privacy
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-black/35 dark:text-muted-foreground" />
      </button>
    </div>
  );
}

/* =================================================================== */
/* PEOPLE HUB                                                           */
/* =================================================================== */

/* =================================================================== */
/* PRIVACY FLOW                                                         */
/* =================================================================== */

/** iOS-style switch (51×31, 27px knob) matching the Apple Blue v2 design. */
function LocationToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-[#34c759]" : "bg-black/15 dark:bg-white/20",
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

function PrivacyFlow({
  onClose,
  onManageSharing,
}: {
  onClose: () => void;
  onManageSharing: () => void;
}) {
  // Inert local state for now — real auto-share / pause wiring comes later.
  const [autoShare, setAutoShare] = useState(false);
  const [paused, setPaused] = useState(false);

  return (
    <div>
      <TaskFlowHeader
        eyebrow="Onepoint"
        title="Privacy"
        description="You control who sees your location and when. Change this anytime."
        onBack={onClose}
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
              On — your circle sees you live, no approval needed. Off — every
              request needs your approval first.
            </p>
          </div>
          <LocationToggle
            checked={autoShare}
            onChange={setAutoShare}
            label="Auto-share my location"
          />
        </div>
        <div className="flex items-center gap-3.5 py-4">
          <div className="flex-1">
            <p className="text-[16px] font-semibold text-[#1c1c2e] dark:text-foreground">
              Pause my location
            </p>
            <p className="mt-0.5 text-[13px] leading-[1.45] text-black/50 dark:text-muted-foreground">
              Go invisible to everyone until you turn this off.
            </p>
          </div>
          <LocationToggle
            checked={paused}
            onChange={setPaused}
            label="Pause my location"
          />
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2.5 px-1">
        <Shield className="mt-0.5 h-[15px] w-[15px] shrink-0 text-[#007aff]" />
        <p className="text-[13px] leading-[1.5] text-black/50 dark:text-muted-foreground">
          Your location is never shared outside your circle. You can revoke
          access to anyone at any time.
        </p>
      </div>

      <p className="mt-7 px-1 text-[12px] font-bold uppercase tracking-[0.6px] text-black/40 dark:text-muted-foreground">
        Who can see you
      </p>
      <button
        type="button"
        onClick={onManageSharing}
        className="mt-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-colors hover:bg-black/[0.02] dark:bg-[color:var(--app-card-surface-default-solid)]"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold text-[#1c1c2e] dark:text-foreground">
            Manage sharing
          </p>
          <p className="mt-0.5 text-[13px] text-black/50 dark:text-muted-foreground">
            See and change who has your live location
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-black/30 dark:text-muted-foreground" />
      </button>
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
  onInvite,
  onStartShare,
  onAsk,
}: {
  vm: LocationHubViewModel;
  onInvite: () => void;
  onStartShare: () => void;
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
              onClick={onInvite}
              className="h-11 rounded-full bg-[#007aff] text-sm font-semibold text-white hover:bg-[#007aff]/90"
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

        <TrustNoteCard
          title="Private sharing starts after approval"
          description="They must sign in, verify phone and accept first."
        />
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
          variant="outline"
          onClick={onInvite}
          className="h-10 rounded-full border-[#007aff] text-sm font-semibold text-[#007aff]"
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
                      className="h-9 rounded-full border-[#007aff] px-5 text-sm font-semibold text-[#007aff]"
                    >
                      Stop
                    </Button>
                  ) : ready ? (
                    <Button
                      onClick={() => {
                        vm.toggleShareRecipient(r.userId, "people_hub");
                        onStartShare();
                      }}
                      className="h-9 rounded-full bg-[#007aff] px-5 text-sm font-semibold text-white hover:bg-[#007aff]/90"
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
          <Navigation className="h-[18px] w-[18px] text-[#007aff]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-[#007aff]">
            Ask someone to share
          </span>
          <span className="block text-[13px] text-black/50 dark:text-muted-foreground">
            Send a request — they approve first.
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-black/35 dark:text-muted-foreground" />
      </button>
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
        className="h-9 shrink-0 rounded-full border-[#007aff] px-4 text-sm font-semibold text-[#007aff]"
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
        className="h-12 w-full rounded-full bg-[#007aff] text-[15px] font-semibold text-white hover:bg-[#007aff]/90"
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
                promptLine="Asks to see your location · 1 hour"
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
              const enRoute = vm.activeOwnerGrants.some(
                (g) =>
                  g.shareKind === "pickup_enroute" &&
                  g.recipientUserId === grant.ownerUserId,
              );
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
                  message={grant.shareMessage ?? undefined}
                  isPickup={grant.shareKind === "pick_me_up"}
                  onImOnMyWay={() => vm.onImOnMyWay(grant)}
                  enRoute={enRoute}
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
          <div>
            {vm.requestedByMe.map((request, i) => {
              const active = /active|approved|shared|granted/i.test(
                request.status,
              );
              return (
                <div
                  key={request.id}
                  className={cn(
                    "flex items-center gap-3 py-3.5",
                    i > 0 && "border-t border-black/[0.06] dark:border-white/10",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
                      {vm.requestOwnerLabel(request)}
                    </p>
                    <p className="text-xs text-black/50 dark:text-muted-foreground">
                      {vm.formatDateTime(request.requestedAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
                      active
                        ? "bg-[#e5f4ea] text-[#2ea44f] dark:bg-emerald-400/15 dark:text-emerald-300"
                        : "bg-[#eef2f8] text-black/60 dark:bg-white/10 dark:text-muted-foreground",
                    )}
                  >
                    {active ? "Active" : "Pending"}
                  </span>
                </div>
              );
            })}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/* =================================================================== */
/* SOS FLOW (Quick Action wrapper around the existing SOS panic panel)  */
/* =================================================================== */

/** Circle avatar tones for the "Location shared with …" stack. */
const SOS_AVATAR_TONES = [
  "bg-amber-500",
  "bg-blue-600",
  "bg-rose-500",
  "bg-teal-500",
  "bg-violet-500",
];

function sosInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 1) || "?").toUpperCase();
}

/** Small square shortcut card (Call / Message / Share live location). */
function SosQuickCard({
  icon: Icon,
  title,
  subtitle,
  onClick,
}: {
  icon: typeof Phone;
  title: string;
  subtitle: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-col gap-3 rounded-[16px] bg-white p-3 text-left shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:bg-white/[0.05]"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#fdeeec] dark:bg-[#e0342c]/15">
        <Icon className="h-[17px] w-[17px] text-[#e0342c]" strokeWidth={1.8} />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-bold text-foreground">
          {title}
        </span>
        <span className="mt-2 flex items-end justify-between gap-2.5">
          <span className="min-w-0 truncate text-[12px] text-black/45 dark:text-white/45">
            {subtitle}
          </span>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#eef2f8] dark:bg-white/10">
            <ChevronRight className="h-3 w-3 text-black/40 dark:text-white/40" />
          </span>
        </span>
      </span>
    </button>
  );
}

/** Row inside the "Reach out for help" list. */
function SosHelpRow({
  icon: Icon,
  badge,
  title,
  subtitle,
  actionLabel,
  actionIcon: ActionIcon,
  isLast,
  onClick,
}: {
  icon?: typeof Phone;
  badge?: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  actionIcon?: typeof Phone;
  isLast?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-3",
        !isLast && "border-b border-black/[0.05] dark:border-white/[0.06]",
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#fdeeec] dark:bg-[#e0342c]/15">
        {badge ? (
          <span className="text-[13px] font-bold text-[#e0342c]">{badge}</span>
        ) : Icon ? (
          <Icon className="h-[18px] w-[18px] text-[#e0342c]" strokeWidth={1.5} />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold text-foreground">{title}</div>
        <div className="mt-px truncate text-[13px] text-black/45 dark:text-white/45">
          {subtitle}
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#fdeeec] px-[15px] py-[9px] text-[14px] font-semibold text-[#d92c24] dark:bg-[#e0342c]/15 dark:text-[#ff6f66]"
      >
        {ActionIcon ? (
          <ActionIcon className="h-3.5 w-3.5" strokeWidth={2} />
        ) : null}
        {actionLabel}
      </button>
    </div>
  );
}

function SosFlow({
  vm,
  onClose,
}: {
  vm: LocationHubViewModel;
  onClose: () => void;
}) {
  const recipients = vm.sosRecipients;
  const sharedCount = recipients.length;

  return (
    <div className="space-y-3.5">
      {/* Back + title (design: circular back button, then "Safety"). */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Back"
        className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-black/[0.05] text-foreground dark:bg-white/10"
      >
        <ChevronRight className="h-[18px] w-[18px] rotate-180" />
      </button>
      <h1 className="text-[33px] font-bold tracking-[-0.6px] text-foreground">
        Safety
      </h1>

      <SosPanel
        recipients={recipients}
        active={vm.sosActive}
        busy={vm.sosBusy}
        startedAtLabel={vm.sosStartedAtLabel}
        onTrigger={vm.onTriggerSos}
        onStop={vm.onStopSos}
        recipientLabel={vm.recipientLabel}
        isRecipientShareReady={vm.isRecipientShareReady}
      />

      {/* Location shared with N people */}
      {sharedCount > 0 ? (
        <div className="rounded-[18px] bg-white p-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-white/[0.05]">
          <div className="text-[16px] font-bold text-foreground">
            Location shared with {sharedCount}{" "}
            {sharedCount === 1 ? "person" : "people"}
          </div>
          <div className="mt-3.5 flex items-center justify-between gap-3">
            <div className="flex -space-x-1">
              {recipients.slice(0, 4).map((r, index) => (
                <span
                  key={r.userId}
                  className={cn(
                    "flex h-[52px] w-[52px] items-center justify-center rounded-full text-sm font-semibold text-white ring-[2.5px] ring-white dark:ring-[#1c1c1e]",
                    SOS_AVATAR_TONES[index % SOS_AVATAR_TONES.length],
                  )}
                  aria-hidden
                >
                  {sosInitials(vm.recipientLabel(r))}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="shrink-0 whitespace-nowrap rounded-[14px] border-[1.5px] border-[#007aff] px-[18px] py-[11px] text-[14px] font-semibold text-[#007aff] dark:border-[#4a9eff] dark:text-[#4a9eff]"
            >
              View all
            </button>
          </div>
        </div>
      ) : null}

      {/* Quick shortcuts */}
      <div className="grid grid-cols-3 gap-2.5">
        <SosQuickCard icon={Phone} title="Call" subtitle="Call for help" />
        <SosQuickCard
          icon={MessageCircle}
          title="Message"
          subtitle="Message contacts"
        />
        <SosQuickCard
          icon={MapPin}
          title="Share live location"
          subtitle="With your circle"
        />
      </div>

      {/* Reach out for help */}
      <div className="rounded-[18px] bg-white px-4 py-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-white/[0.05]">
        <div className="text-[16px] font-bold text-foreground">
          Reach out for help
        </div>
        <div className="mt-3 rounded-[14px] bg-[#f5f6f8] px-3 dark:bg-white/[0.04]">
          <SosHelpRow
            icon={Shield}
            title="Emergency Contact"
            subtitle="Contact your emergency contact"
            actionLabel="Call"
            actionIcon={Phone}
          />
          <SosHelpRow
            badge="911"
            title="Local Emergency"
            subtitle="Call local emergency services"
            actionLabel="Call"
            actionIcon={Phone}
          />
          <SosHelpRow
            icon={Heart}
            title="Crisis Support"
            subtitle="Connect with 24/7 support"
            actionLabel="Chat"
            actionIcon={MessageCircle}
          />
          <SosHelpRow
            icon={Clock}
            title="Safety Check"
            subtitle="Set a timer and get a check-in"
            actionLabel="Start"
            isLast
          />
        </div>
      </div>

      {/* Privacy */}
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-[16px] bg-white px-4 py-3.5 text-left shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:bg-white/[0.05]"
      >
        <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-[#eef3fb] dark:bg-[#007aff]/15">
          <Lock className="h-[18px] w-[18px] text-[#007aff] dark:text-[#4a9eff]" strokeWidth={1.6} />
        </span>
        <span className="flex-1 text-[15px] font-medium text-foreground">
          Privacy
        </span>
        <ChevronRight className="h-4 w-4 text-black/35 dark:text-white/35" />
      </button>
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
            className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90"
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
                className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[#007aff]/25"
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
          className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90 disabled:opacity-50"
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
        className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90 disabled:opacity-50"
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
          className="w-full rounded-[14px] border border-border/70 bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-[#007aff]/25"
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
        className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90 disabled:opacity-50"
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
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#007aff]/12 text-[#007aff]">
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
            className="h-11 rounded-full bg-[#007aff] text-sm font-semibold text-white hover:bg-[#007aff]/90"
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
        className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90"
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
        className="h-12 w-full rounded-2xl bg-[#007aff] text-base font-semibold text-white hover:bg-[#007aff]/90"
      >
        Review public location link
      </Button>
    </div>
  );
}

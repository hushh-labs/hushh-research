"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  ArrowRight,
  Briefcase,
  Check,
  FinanceAgentIcon,
  Heart,
  LifeBuoy,
  MapPin,
  Plus,
  ShieldCheck,
  TrendingUp,
  UserPlus,
} from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import type { AgentProfileIconStyle } from "@/lib/design/agent-theme-registry";
import { DASHBOARD_AGENT_ICON_STYLE_BY_ID } from "@/lib/design/home-icon-palette";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import type { OneLocationCircleMember, OneLocationCircleSummary } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";
import {
  CIRCLE_STARTERS,
  findStarterCircle,
  type CircleStarter,
  type CircleStarterId,
  type ConnectCirclesSnapshot,
} from "./circle-discovery";
import { CONNECT_HERO_CLASSNAME } from "./connect-living-layout";

const STARTER_ICONS = {
  family: Heart,
  finance: FinanceAgentIcon,
  investor: TrendingUp,
  business: Briefcase,
  location: MapPin,
  sms: LifeBuoy,
};

// Match the home palette and its duotone icon language. These colours do not
// imply access has been granted; SMS means Save My Soul, not text messaging.
const STARTER_ICON_STYLES: Record<CircleStarterId, AgentProfileIconStyle> = {
  family: DASHBOARD_AGENT_ICON_STYLE_BY_ID.email,
  finance: DASHBOARD_AGENT_ICON_STYLE_BY_ID.finance,
  investor: DASHBOARD_AGENT_ICON_STYLE_BY_ID.ria,
  business: DASHBOARD_AGENT_ICON_STYLE_BY_ID.consent,
  location: DASHBOARD_AGENT_ICON_STYLE_BY_ID.location,
  sms: DASHBOARD_AGENT_ICON_STYLE_BY_ID.gmail,
};
const STARTER_TONE_CLASSNAME =
  "[--circle-tint:var(--agent-icon-profile-bg)] [--circle-ink:var(--agent-icon-profile-fg)] dark:[--circle-tint:var(--agent-icon-profile-bg-dark)] dark:[--circle-ink:var(--agent-icon-profile-fg-dark)]";
const CIRCLE_TOUR_INTERVAL_MS = 3_000;

export type CircleDiscoveryCardProps = {
  ownerName: string;
  ownerPhotoUrl?: string | null;
  connections: readonly ConnectionSummaryEntry[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  snapshot: ConnectCirclesSnapshot;
  loadCircleMembers?: (circleId: string) => Promise<readonly OneLocationCircleMember[]>;
  creating: CircleStarterId | null;
  onFindPeople: () => void;
  onCreateCircle: () => void;
  onUseStarter: (starter: CircleStarter) => void;
  onOpenCircle: (circleId: string) => void;
  onRetry: () => void;
  onRetryCircles: () => void;
  onSetupCircles: () => void;
};

/** An introduction, not a permission grant. A choice only previews a circle. */
export function CircleDiscoveryCard({
  ownerName,
  ownerPhotoUrl,
  connections,
  totalCount,
  loading,
  error,
  snapshot,
  loadCircleMembers,
  creating,
  onFindPeople,
  onCreateCircle,
  onUseStarter,
  onOpenCircle,
  onRetry,
  onRetryCircles,
  onSetupCircles,
}: CircleDiscoveryCardProps) {
  const [selected, setSelected] = useState<CircleStarterId>("family");
  const [autoTourActive, setAutoTourActive] = useState(true);
  const [memberPreview, setMemberPreview] = useState<{
    circleId: string;
    source: readonly OneLocationCircleSummary[];
    members: readonly OneLocationCircleMember[];
  } | null>(null);
  const memberRequests = useRef<{
    source: readonly OneLocationCircleSummary[];
    loader: CircleDiscoveryCardProps["loadCircleMembers"];
    requests: Map<string, Promise<readonly OneLocationCircleMember[]>>;
  }>({ source: snapshot.circles, loader: loadCircleMembers, requests: new Map() });
  const headingId = useId();
  const descriptionId = useId();
  const starter = CIRCLE_STARTERS.find((item) => item.id === selected)!;
  const circle = findStarterCircle(snapshot.circles, starter);
  const circleId = circle?.id;
  const circleMemberCount = circle?.memberCount;
  const trusted = snapshot.circles.find(
    (item) => item.role === "owner" && item.systemKind === "trusted",
  );
  const isEmpty = !loading && !error && totalCount === 0;
  const connectionsUnavailable = error && totalCount === 0;
  const needsSetup = !snapshot.loading && !snapshot.available;
  const circlesUnavailable = !snapshot.loading && Boolean(snapshot.error);
  const shownConnections = connections.slice(0, 3);
  const moreConnections = Math.max(0, totalCount - shownConnections.length);
  const previewMembers =
    memberPreview?.circleId === circle?.id && memberPreview?.source === snapshot.circles
      ? memberPreview.members
      : [];

  useEffect(() => {
    if (
      memberRequests.current.source !== snapshot.circles ||
      memberRequests.current.loader !== loadCircleMembers
    ) {
      memberRequests.current = {
        source: snapshot.circles,
        loader: loadCircleMembers,
        requests: new Map(),
      };
    }
    if (!circleId || !circleMemberCount || circleMemberCount <= 1 || !snapshot.ownerId || !loadCircleMembers) {
      return;
    }
    const source = snapshot.circles;
    const key = `${circleId}:${circleMemberCount}`;
    let active = true;
    let request = memberRequests.current.requests.get(key);
    if (!request) {
      request = loadCircleMembers(circleId).then((members) =>
        members.filter((member) => member.userId !== snapshot.ownerId).slice(0, 2),
      );
      memberRequests.current.requests.set(key, request);
    }
    void request.then((members) => {
      if (active) setMemberPreview({ circleId, source, members });
    }).catch(() => {
      if (memberRequests.current.source === source) {
        memberRequests.current.requests.delete(key);
      }
    });
    return () => { active = false; };
  }, [circleId, circleMemberCount, loadCircleMembers, snapshot.circles, snapshot.ownerId]);

  const memberSlot = (index: number) => {
    const member = previewMembers[index];
    return member ? (
      <span key={index} data-testid="circle-discovery-member-avatar" title={member.displayName} className="flex size-7 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] shadow-sm min-[390px]:size-8 sm:size-9">
        <ConnectionPersonAvatar size="compact" className="!size-full" photoUrl={member.photoUrl} label={member.displayName} />
      </span>
    ) : (
      <span key={index} data-testid="circle-discovery-empty-slot" className="flex size-7 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-fill)] text-[color:var(--app-secondary-label)] shadow-sm min-[390px]:size-8 sm:size-9">
        <UserPlus className="size-3 min-[390px]:size-3.5 sm:size-4" />
      </span>
    );
  };

  const stopAutoTour = useCallback(() => setAutoTourActive(false), []);
  const selectStarter = useCallback(
    (starterId: CircleStarterId) => {
      stopAutoTour();
      setSelected(starterId);
    },
    [stopAutoTour],
  );
  const handlePrimaryAction = useCallback(() => {
    stopAutoTour();
    if (circle) onOpenCircle(circle.id);
    else onUseStarter(starter);
  }, [circle, onOpenCircle, onUseStarter, starter, stopAutoTour]);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!reducedMotion) return;
    const handlePreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopAutoTour();
    };
    if (reducedMotion.matches) stopAutoTour();
    reducedMotion.addEventListener?.("change", handlePreferenceChange);
    return () => reducedMotion.removeEventListener?.("change", handlePreferenceChange);
  }, [stopAutoTour]);

  useEffect(() => {
    if (!autoTourActive) return;
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      setSelected((current) => {
        const currentIndex = CIRCLE_STARTERS.findIndex((item) => item.id === current);
        return CIRCLE_STARTERS[(currentIndex + 1) % CIRCLE_STARTERS.length]!.id;
      });
    }, CIRCLE_TOUR_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [autoTourActive]);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="connect-living-connections"
      data-circle-discovery-card=""
      data-auto-tour={autoTourActive ? "running" : "stopped"}
      className={cn(CONNECT_HERO_CLASSNAME, "motion-step-enter")}
    >
      <div className="relative grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center text-center md:block">
        <h2 id={headingId} className="ui-text-major-section-title col-start-2 text-[color:var(--app-label)] sm:!text-2xl">
          Circles
        </h2>
        <p data-circle-discovery-intro="" className="ui-text-caption col-span-3 mx-auto mt-1 max-w-80 !text-[color:var(--app-secondary-label)] sm:mt-1 sm:!text-sm sm:!leading-5">
          Group people you trust. Choose what they can access.
        </p>
        <button
          type="button"
          aria-label="Create your own circle"
          title="Create your own circle"
          disabled={Boolean(creating)}
          onClick={onCreateCircle}
          className="col-start-3 row-start-1 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50 md:absolute md:right-0 md:top-0 md:px-2"
        >
          <Plus aria-hidden="true" className="size-5" />
          <span className="sr-only md:not-sr-only md:text-xs md:font-medium">Custom circle</span>
        </button>
      </div>

      <div data-circle-discovery-content="" className="mx-auto mt-1 grid w-full max-w-[52rem] min-w-0 items-center gap-2 sm:mt-4 sm:gap-2 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)] md:gap-6 lg:gap-8">
        <div
          className="relative mx-auto aspect-square w-[min(76vw,18rem,calc(100svh-26rem))] sm:w-[18rem] lg:w-[20rem]"
          data-testid="circle-discovery-orbit"
          data-circle-discovery-orbit=""
        >
          <svg aria-hidden="true" viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full">
            <circle cx="50" cy="50" r="36" fill="none" stroke="var(--app-card-border-standard)" strokeWidth="0.4" />
          </svg>
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 size-[68%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--app-secondary-fill)_30%,var(--app-card-surface-default-solid))_0%,transparent_76%)]"
            aria-hidden="true"
          />
          <div
            className="absolute left-1/2 top-1/2 flex w-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center min-[390px]:w-24 sm:w-28"
            data-testid="circle-discovery-owner"
          >
            <div className="flex items-center -space-x-2 sm:-space-x-2.5" aria-hidden="true">
              {memberSlot(0)}
              <span data-circle-discovery-owner-avatar="" className="relative z-10 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] shadow-sm">
                <ConnectionPersonAvatar size="list" className="!size-12 max-[359px]:!size-10 min-[390px]:!size-13 sm:!size-11 [&_[data-slot=avatar-fallback]]:!text-base" photoUrl={ownerPhotoUrl} label={ownerName} />
              </span>
              {memberSlot(1)}
            </div>
            <span data-circle-discovery-owner-label="" className="max-w-full truncate text-sm font-semibold text-[color:var(--app-label)] sm:mt-2">
              {starter.label}
            </span>
            <span data-circle-discovery-owner-status="" className="text-xs leading-4 text-[color:var(--app-secondary-label)]">
              <span className="sm:hidden">
                {circle ? (circle.memberCount <= 1 ? "Just you" : `${circle.memberCount} people`) : "Start with you"}
              </span>
              <span className="hidden sm:inline">
                {circle
                  ? circle.memberCount <= 1
                    ? "Created · ready for your people"
                    : `${circle.memberCount} people in your circle`
                  : "Start with you"}
              </span>
            </span>
          </div>
          {CIRCLE_STARTERS.map((item, index) => {
            const angle = -Math.PI / 2 + (index * Math.PI) / 3;
            const Icon = STARTER_ICONS[item.id];
            const existing = findStarterCircle(snapshot.circles, item);
            const active = item.id === selected;
            return (
              <button
                key={item.id}
                type="button"
                aria-label={`Explore ${item.name}${existing ? ", already created" : ""}`}
                aria-pressed={active}
                aria-controls={descriptionId}
                disabled={Boolean(creating)}
                // Pointer enter on mount is not intent. Actual movement, touch, or
                // keyboard focus stops the tour, and surrounding space never does.
                onPointerMove={stopAutoTour}
                onPointerDown={stopAutoTour}
                onFocus={stopAutoTour}
                onClick={() => selectStarter(item.id)}
                title={existing?.name ?? item.name}
                data-testid={`circle-starter-${item.id}`}
                data-circle-orbit-bottom-node={item.id === "business" ? "" : undefined}
                className={cn(
                  STARTER_TONE_CLASSNAME,
                  "group absolute top-[var(--circle-node-mobile-top)] flex w-[4.5rem] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-xl py-0.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:cursor-wait sm:top-[var(--circle-node-desktop-top)]",
                )}
                style={{
                  ...STARTER_ICON_STYLES[item.id],
                  left: `${50 + Math.cos(angle) * 44}%`,
                  "--circle-node-mobile-top": `${50 + Math.sin(angle) * 36}%`,
                  "--circle-node-desktop-top": `${50 + Math.sin(angle) * 40}%`,
                } as CSSProperties}
              >
                <span className="motion-step-enter flex flex-col items-center gap-0.5" style={{ animationDelay: `${80 + index * 45}ms` }}>
                  <span
                    data-circle-starter-icon={item.id}
                    className={cn(
                      "relative flex size-12 items-center justify-center rounded-full border bg-[color:var(--circle-tint)] text-[color:var(--circle-ink)] shadow-sm transition-[transform,box-shadow,border-color] duration-200 group-hover:scale-105 group-active:scale-95 motion-reduce:transform-none motion-reduce:transition-none sm:size-11",
                      active
                        ? "scale-105 border-[color:var(--app-accent)] ring-[3px] ring-[color:var(--app-accent-ring)]"
                        : "border-[color:color-mix(in_oklab,var(--circle-ink)_14%,transparent)]",
                    )}
                  >
                    <Icon aria-hidden="true" data-circle-icon-style="duotone" weight="duotone" color="currentColor" className="size-5.5" />
                    {existing ? (
                      <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] sm:size-4">
                        <Check aria-hidden="true" className="size-2.5 sm:size-3" />
                      </span>
                    ) : null}
                  </span>
                  <span className={cn(
                    "max-w-full text-xs leading-4",
                    active ? "font-semibold text-[color:var(--app-label)]" : "text-[color:var(--app-secondary-label)]",
                  )}>
                    {item.label}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 md:max-w-[22rem]">
          <div
            id={descriptionId}
            key={selected}
            data-testid="circle-discovery-preview"
            data-circle-discovery-preview=""
            className="motion-step-enter rounded-[var(--app-radius-sm)] bg-[color:var(--app-secondary-surface)] px-3 py-2.5 text-center md:rounded-[var(--app-card-radius-compact)] md:border md:border-[color:var(--app-card-border-standard)] md:bg-[color:var(--app-card-surface-default-solid)] md:px-5 md:py-5 md:text-left"
            aria-live={autoTourActive ? "off" : "polite"}
            aria-atomic="true"
          >
            <p className="hidden text-xs font-medium text-[color:var(--app-secondary-label)] md:block">
              {circle ? "Your circle" : "Make it yours"}
            </p>
            <h3 className="text-sm font-semibold leading-5 text-[color:var(--app-label)] md:mt-1 md:text-lg">
              {circle?.name ?? starter.name}
            </h3>
            <p className="ui-text-caption mx-auto mt-1 max-w-[28rem] !text-xs !leading-[1.35] !text-[color:var(--app-secondary-label)] sm:!text-sm sm:!leading-5 md:mx-0 md:mt-2">
              {starter.description}
            </p>
          </div>
          <div className={cn(
            "mt-1 grid gap-1.5 sm:gap-2 md:mt-4 md:grid-cols-1",
            !needsSetup && !circlesUnavailable && "grid-cols-2 max-[299px]:grid-cols-1",
          )} data-circle-discovery-actions="">
            {needsSetup ? (
              <Button type="button" size="standard" variant="blue" effect="fill" onClick={onSetupCircles} className="!h-11 w-full !rounded-[var(--app-card-radius-compact)]">
                Finish setting up One
              </Button>
            ) : circlesUnavailable ? (
              <>
                <p className="text-xs text-[color:var(--app-secondary-label)]">We couldn't load your circles.</p>
                <Button type="button" size="standard" variant="blue" effect="fill" onClick={onRetryCircles} className="!h-11 w-full !rounded-[var(--app-card-radius-compact)]">
                  Retry circles
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="standard"
                variant="blue"
                effect="fill"
                disabled={snapshot.loading || Boolean(creating)}
                loading={Boolean(creating)}
                onPointerMove={stopAutoTour}
                onPointerDown={stopAutoTour}
                onFocus={stopAutoTour}
                onClick={handlePrimaryAction}
                aria-label={creating ? "Creating…" : snapshot.loading ? "Loading circles…" : circle ? "Open circle" : `Create a Circle — ${starter.name}`}
                className="!h-11 w-full !rounded-[var(--app-card-radius-compact)] !px-3"
                data-testid="circle-discovery-primary"
              >
                {creating ? "Creating…" : snapshot.loading ? "Loading circles…" : circle ? "Open circle" : "Create a Circle"}
              </Button>
            )}
            <Button
              type="button"
              variant="blue"
              effect="fade"
              size="standard"
              disabled={loading || Boolean(creating)}
              onClick={connectionsUnavailable ? onRetry : onFindPeople}
              className="!h-11 w-full !rounded-[var(--app-card-radius-compact)] !bg-[color:var(--app-secondary-surface)] !text-[color:var(--app-accent)]"
            >
              {connectionsUnavailable ? "Try again" : "Add connection"}
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-1 flex max-w-[52rem] min-w-0 items-center justify-center gap-2 border-t border-[color:var(--app-card-border-standard)] pt-1 text-xs leading-4 text-[color:var(--app-secondary-label)] md:justify-start md:pt-3">
        {loading ? (
          <p>Loading your connections…</p>
        ) : connectionsUnavailable ? (
          <p>Couldn't load your connections. Try again to find your people.</p>
        ) : isEmpty ? (
          <p>Send a request, then add people after they accept.</p>
        ) : (
          <>
            <span aria-hidden="true" className="hidden shrink-0 -space-x-2 min-[360px]:flex">
              {shownConnections.map((person) => (
                <span key={person.connectionId} className="rounded-full border-2 border-[color:var(--app-card-surface-default-solid)]">
                  <ConnectionPersonAvatar size="compact" className="!size-6" photoUrl={person.photoUrl} label={person.displayName || "Connection"} />
                </span>
              ))}
              {moreConnections ? (
                <span className="relative flex size-6 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[9px] font-semibold sm:size-7 sm:text-[10px]">
                  +{moreConnections}
                </span>
              ) : null}
            </span>
            <span className="whitespace-nowrap">
              <span className="sm:hidden">{totalCount} connected</span>
              <span className="hidden sm:inline">{totalCount} {totalCount === 1 ? "connection" : "connections"} to build with</span>
            </span>
            {trusted ? (
              <button
                type="button"
                disabled={Boolean(creating)}
                onClick={() => onOpenCircle(trusted.id)}
                className="hidden min-h-11 items-center gap-1 rounded-full px-1 text-xs text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:inline-flex"
              >
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                Your Trusted Circle <ArrowRight aria-hidden="true" className="size-3" />
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

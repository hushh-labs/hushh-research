"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  ArrowRight,
  Briefcase,
  Check,
  Heart,
  Lock,
  MapPin,
  MessageCircle,
  Plus,
  ShieldCheck,
  TrendingUp,
  UserPlus,
  Wallet,
} from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import type { AgentProfileIconStyle } from "@/lib/design/agent-theme-registry";
import { DASHBOARD_AGENT_ICON_STYLE_BY_ID } from "@/lib/design/home-icon-palette";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
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
  finance: Wallet,
  investor: TrendingUp,
  business: Briefcase,
  location: MapPin,
  sms: MessageCircle,
};

// Reuse the home palette, but map it to the supplied design's semantic tones
// across both Connect tabs. These colours do not imply access has been granted.
const STARTER_ICON_STYLES: Record<CircleStarterId, AgentProfileIconStyle> = {
  family: DASHBOARD_AGENT_ICON_STYLE_BY_ID.email,
  finance: DASHBOARD_AGENT_ICON_STYLE_BY_ID.wallet,
  investor: DASHBOARD_AGENT_ICON_STYLE_BY_ID.ria,
  business: DASHBOARD_AGENT_ICON_STYLE_BY_ID.consent,
  location: DASHBOARD_AGENT_ICON_STYLE_BY_ID.location,
  sms: DASHBOARD_AGENT_ICON_STYLE_BY_ID.marketplace,
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
  const headingId = useId();
  const descriptionId = useId();
  const starter = CIRCLE_STARTERS.find((item) => item.id === selected)!;
  const circle = findStarterCircle(snapshot.circles, starter);
  const trusted = snapshot.circles.find(
    (item) => item.role === "owner" && item.systemKind === "trusted",
  );
  const isEmpty = !loading && !error && totalCount === 0;
  const connectionsUnavailable = error && totalCount === 0;
  const needsSetup = !snapshot.loading && !snapshot.available;
  const circlesUnavailable = !snapshot.loading && Boolean(snapshot.error);
  const shownConnections = connections.slice(0, 3);
  const moreConnections = Math.max(0, totalCount - shownConnections.length);

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
      data-auto-tour={autoTourActive ? "running" : "stopped"}
      className={cn(CONNECT_HERO_CLASSNAME, "motion-step-enter")}
    >
      <div className="relative text-center">
        <h2 id={headingId} className="ui-text-major-section-title !text-lg sm:!text-2xl text-[color:var(--app-label)]">
          Circles
        </h2>
        <p className="mx-auto mt-0.5 max-w-80 text-[11px] leading-3.5 sm:mt-1 sm:text-sm sm:leading-5 text-[color:var(--app-secondary-label)]">
          Group people you trust. Choose what they can access.
        </p>
        <button
          type="button"
          aria-label="Create your own circle"
          title="Create your own circle"
          disabled={Boolean(creating)}
          onClick={onCreateCircle}
          className="absolute right-0 top-0 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50 sm:px-2"
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="sr-only sm:not-sr-only sm:text-xs sm:font-medium">Custom circle</span>
        </button>
      </div>

      <div className="mx-auto mt-1 grid w-full max-w-[52rem] min-w-0 items-center gap-1 sm:mt-4 sm:gap-2 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)] md:gap-6 lg:gap-8">
        <div
          className="relative mx-auto aspect-square w-[min(100%,11.25rem)] min-[390px]:w-[12rem] min-[420px]:w-[13rem] sm:w-[18rem] lg:w-[20rem]"
          data-testid="circle-discovery-orbit"
        >
          <svg aria-hidden="true" viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full">
            <circle cx="50" cy="50" r="36" fill="none" stroke="var(--app-card-border-standard)" strokeWidth="0.4" />
          </svg>
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 size-[52%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--app-secondary-surface)_0%,transparent_72%)]"
            aria-hidden="true"
          />
          <div
            className="absolute left-1/2 top-1/2 flex w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center sm:w-28"
            data-testid="circle-discovery-owner"
          >
            <div className="flex items-center -space-x-2.5" aria-hidden="true">
              <span className="flex size-6 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-fill)] text-[color:var(--app-secondary-label)] shadow-sm sm:size-9">
                <UserPlus className="size-3 sm:size-4" />
              </span>
              <span className="relative z-10 rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] shadow-sm">
                <ConnectionPersonAvatar size="profile" className="!size-8 sm:!size-11" photoUrl={ownerPhotoUrl} label={ownerName} />
              </span>
              <span className="flex size-6 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-fill)] text-[color:var(--app-secondary-label)] shadow-sm sm:size-9">
                <UserPlus className="size-3 sm:size-4" />
              </span>
            </div>
            <span className="mt-1.5 max-w-full truncate text-xs font-semibold text-[color:var(--app-label)] sm:text-sm">
              {starter.label}
            </span>
            <span className="text-[10px] leading-3 text-[color:var(--app-secondary-label)] sm:text-xs">
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
                className={cn(
                  STARTER_TONE_CLASSNAME,
                  "group absolute flex w-14 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-xl py-0.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:cursor-wait sm:w-[4.5rem]",
                )}
                style={{
                  ...STARTER_ICON_STYLES[item.id],
                  left: `${50 + Math.cos(angle) * 42}%`,
                  top: `${50 + Math.sin(angle) * 38}%`,
                }}
              >
                <span className="motion-step-enter flex flex-col items-center gap-0.5" style={{ animationDelay: `${80 + index * 45}ms` }}>
                  <span
                    data-circle-starter-icon={item.id}
                    className={cn(
                      "relative flex size-8 items-center justify-center rounded-full border bg-[color:var(--circle-tint)] text-[color:var(--circle-ink)] shadow-sm transition-[transform,box-shadow,border-color] duration-200 group-hover:scale-105 group-active:scale-95 motion-reduce:transform-none motion-reduce:transition-none sm:size-11",
                      active
                        ? "scale-105 border-[color:var(--app-accent)] ring-[3px] ring-[color:var(--app-accent-ring)]"
                        : "border-[color:color-mix(in_oklab,var(--circle-ink)_14%,transparent)]",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 sm:size-5" />
                    {existing ? (
                      <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] sm:size-4">
                        <Check aria-hidden="true" className="size-2.5 sm:size-3" />
                      </span>
                    ) : null}
                  </span>
                  <span className={cn(
                    "max-w-full text-[10px] leading-3 sm:text-xs sm:leading-4",
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
            className="motion-step-enter bg-[color:var(--app-secondary-surface)] px-1 py-0.5 text-center md:rounded-[var(--app-card-radius-compact)] md:border md:border-[color:var(--app-card-border-standard)] md:bg-[color:var(--app-card-surface-default-solid)] md:px-5 md:py-5 md:text-left"
            aria-live={autoTourActive ? "off" : "polite"}
            aria-atomic="true"
          >
            <p className="hidden text-xs font-medium text-[color:var(--app-secondary-label)] md:block">
              {circle ? "Your circle" : "Make it yours"}
            </p>
            <h3 className="sr-only md:not-sr-only md:mt-1 md:text-lg md:font-semibold md:text-[color:var(--app-label)]">
              {circle?.name ?? starter.name}
            </h3>
            <p className="mx-auto max-w-[28rem] text-[10px] leading-3.5 text-[color:var(--app-secondary-label)] sm:text-sm sm:leading-5 md:mx-0 md:mt-2">
              {starter.description}
            </p>
          </div>
          <div className="mt-1 flex items-center gap-2 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-surface)] px-2 py-1 md:mt-4 md:px-3 md:py-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-secondary-label)] shadow-sm md:size-9">
              <Lock aria-hidden="true" className="size-3.5 md:size-4" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-[11px] font-semibold leading-4 text-[color:var(--app-label)] sm:text-xs">
                Nothing is shared automatically.
              </span>
              <span className="block text-[10px] leading-3 text-[color:var(--app-secondary-label)] sm:text-xs sm:leading-4">
                You can change access anytime.
              </span>
            </span>
          </div>
          <div className="mt-1 grid gap-1.5 min-[360px]:grid-cols-2 sm:gap-2 md:mt-4 md:grid-cols-1">
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
                aria-label={creating ? "Creating…" : snapshot.loading ? "Loading circles…" : circle ? "Open circle" : `Create ${starter.name}`}
                className="relative !h-11 w-full !rounded-[var(--app-card-radius-compact)] !px-3 !text-xs sm:!text-base"
                data-testid="circle-discovery-primary"
              >
                {creating ? "Creating…" : snapshot.loading ? "Loading circles…" : circle ? "Open circle" : "Create a Circle"}
                {!creating && !snapshot.loading ? <ArrowRight aria-hidden="true" className="absolute right-2 size-3 sm:right-4 sm:size-4" /> : null}
              </Button>
            )}
            <Button
              type="button"
              variant="blue"
              effect="fade"
              size="standard"
              disabled={loading || Boolean(creating)}
              onClick={connectionsUnavailable ? onRetry : onFindPeople}
              className="!h-11 w-full !rounded-[var(--app-card-radius-compact)] !bg-[color:var(--app-secondary-surface)] !text-xs !text-[color:var(--app-accent)] sm:!text-base"
            >
              {connectionsUnavailable ? "Try again" : "Add connection"}
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-1 flex max-w-[52rem] min-w-0 items-center justify-center gap-2 border-t border-[color:var(--app-card-border-standard)] pt-1 text-[11px] text-[color:var(--app-secondary-label)] md:justify-start md:pt-3">
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
                <span className="relative flex size-7 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[10px] font-semibold">
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

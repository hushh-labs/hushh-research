"use client";

import { useId, useState } from "react";
import {
  ArrowRight,
  Briefcase,
  Check,
  Heart,
  Landmark,
  MapPin,
  Plus,
  ShieldCheck,
  TrendingUp,
  UserPlus,
} from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { SmsTextIcon } from "@/components/one-location/redesign/sms-text-icon";
import { Button } from "@/lib/morphy-ux/button";
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
  finance: Landmark,
  investor: TrendingUp,
  business: Briefcase,
  location: MapPin,
  sms: SmsTextIcon,
};

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

/** One compact, interactive introduction. Selecting an idea never creates a circle. */
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

  return (
    <section
      aria-labelledby={headingId}
      data-testid="connect-living-connections"
      className={cn(CONNECT_HERO_CLASSNAME, "motion-step-enter")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="ui-text-major-section-title !text-xl sm:!text-2xl text-[color:var(--app-label)]"
          >
            Your life, in circles
          </h2>
          <p className="mt-1 text-xs leading-4 sm:text-sm sm:leading-5 text-[color:var(--app-secondary-label)]">
            Your people. You choose what to share.
          </p>
        </div>
        <button
          type="button"
          aria-label="Create your own circle"
          title="Create your own circle"
          disabled={Boolean(creating)}
          onClick={onCreateCircle}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50"
        >
          <Plus aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Custom circle</span>
        </button>
      </div>

      <div className="mt-1 grid min-w-0 items-center gap-2 sm:mt-4 sm:grid-cols-2 sm:gap-6">
        <div
          className="relative mx-auto aspect-square w-full max-w-[10.75rem] min-[420px]:max-w-[11.5rem] sm:max-w-[18rem]"
          data-testid="circle-discovery-orbit"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            className="pointer-events-none absolute inset-0 size-full overflow-visible"
          >
            <circle
              cx="50"
              cy="50"
              r="35"
              fill="none"
              stroke="var(--app-card-border-standard)"
              strokeWidth="0.4"
            />
            {CIRCLE_STARTERS.map((item, index) => {
              const angle = -Math.PI / 2 + (index * Math.PI) / 3;
              return (
                <line
                  key={item.id}
                  x1="50"
                  y1="50"
                  x2={50 + Math.cos(angle) * 35}
                  y2={50 + Math.sin(angle) * 35}
                  stroke={
                    item.id === selected
                      ? "var(--app-accent)"
                      : "var(--app-card-border-standard)"
                  }
                  strokeWidth="0.5"
                  opacity={item.id === selected ? 0.7 : 0.5}
                />
              );
            })}
          </svg>
          <div
            className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
            data-testid="circle-discovery-owner"
          >
            <span className="rounded-full border border-[color:var(--app-accent)] bg-[color:var(--app-card-surface-default-solid)] p-1">
              <ConnectionPersonAvatar
                size="profile"
                className="!size-8 sm:!size-14"
                photoUrl={ownerPhotoUrl}
                label={ownerName}
              />
            </span>
            <span className="text-[10px] leading-3 sm:text-xs sm:leading-4 font-medium text-[color:var(--app-secondary-label)]">
              You
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
                onClick={() => setSelected(item.id)}
                title={existing?.name ?? item.name}
                data-testid={`circle-starter-${item.id}`}
                className="group absolute flex w-12 sm:w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-xl py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:cursor-wait"
                style={{
                  left: `${50 + Math.cos(angle) * 35}%`,
                  top: `${50 + Math.sin(angle) * 35}%`,
                }}
              >
                <span
                  className="motion-step-enter flex flex-col items-center gap-0.5 sm:gap-1"
                  style={{ animationDelay: `${80 + index * 45}ms` }}
                >
                  <span
                    className={cn(
                      "relative flex size-8 sm:size-11 items-center justify-center rounded-full border bg-[color:var(--app-card-surface-default-solid)] transition-transform duration-150 group-hover:scale-105 group-active:scale-95 motion-reduce:transform-none motion-reduce:transition-none",
                      active
                        ? "scale-105 border-[color:var(--app-accent)] text-[color:var(--app-accent)] ring-4 ring-[color:var(--app-accent-ring)]"
                        : "border-[color:var(--app-card-border-standard)] text-[color:var(--app-secondary-label)]",
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={item.id === "sms" ? "text-[11px]" : "size-5"}
                    />
                    {existing ? (
                      <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]">
                        <Check aria-hidden="true" className="size-3" />
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "max-w-full text-[11px] leading-3 sm:text-xs sm:leading-4",
                      active
                        ? "font-semibold text-[color:var(--app-label)]"
                        : "text-[color:var(--app-secondary-label)]",
                    )}
                  >
                    {item.label}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div
          key={selected}
          id={descriptionId}
          className="motion-step-enter grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 min-w-0 rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-secondary-surface)] px-3 py-2 sm:block sm:p-5"
          data-testid="circle-discovery-preview"
        >
          <div
            className="contents sm:block"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="hidden sm:block text-xs font-medium text-[color:var(--app-accent)]">
              {circle ? "Your circle" : "Make it yours"}
            </p>
            <h3 className="ui-text-card-title !text-base sm:!text-xl row-start-1 col-start-1 sm:mt-1 break-words text-[color:var(--app-label)]">
              {circle?.name ?? starter.name}
            </h3>
            <p className="col-span-2 row-start-2 mt-1 text-xs leading-4 sm:mt-2 sm:text-sm sm:leading-5 text-[color:var(--app-secondary-label)]">
              {starter.description}
            </p>
            {circle ? (
              <p className="hidden sm:block col-span-2 row-start-3 text-xs leading-4 sm:text-sm sm:leading-5 mt-1 sm:mt-2 text-[color:var(--app-label)]">
                {circle
                  ? circle.memberCount <= 1
                    ? "Created · ready for your people"
                    : `${circle.memberCount} people in your circle`
                  : null}
              </p>
            ) : null}
          </div>
          {needsSetup ? (
            <Button
              type="button"
              size="standard"
              variant="blue"
              effect="fill"
              onClick={onSetupCircles}
              className="col-span-2 mt-2 w-full"
            >
              Finish setting up One
            </Button>
          ) : circlesUnavailable ? (
            <div className="col-span-2 mt-3">
              <p className="ui-text-row-description text-[color:var(--app-secondary-label)]">
                We couldn't load your circles.
              </p>
              <Button
                type="button"
                size="standard"
                variant="blue"
                effect="fill"
                onClick={onRetryCircles}
                className="mt-2 w-full"
              >
                Retry circles
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="standard"
              variant="blue"
              effect="fill"
              disabled={snapshot.loading || Boolean(creating)}
              loading={Boolean(creating)}
              onClick={() =>
                circle ? onOpenCircle(circle.id) : onUseStarter(starter)
              }
              aria-label={
                creating
                  ? "Creating…"
                  : snapshot.loading
                    ? "Loading circles…"
                    : circle
                      ? "Open circle"
                      : `Create ${starter.name}`
              }
              className="row-start-1 col-start-2 !px-3 sm:!px-5 sm:mt-3 sm:w-full whitespace-normal"
              data-testid="circle-discovery-primary"
            >
              <span className="inline-flex items-center justify-center gap-2">
                <span className="sm:hidden">
                  {creating
                    ? "Creating…"
                    : snapshot.loading
                      ? "Loading…"
                      : circle
                        ? "Open"
                        : "Create"}
                </span>
                <span className="hidden sm:inline">
                  {creating
                    ? "Creating…"
                    : snapshot.loading
                      ? "Loading circles…"
                      : circle
                        ? "Open circle"
                        : `Create ${starter.name}`}
                </span>
                {!creating && !snapshot.loading ? (
                  <ArrowRight
                    aria-hidden="true"
                    className="hidden sm:block size-4 shrink-0"
                  />
                ) : null}
              </span>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-[color:var(--app-card-border-standard)] pt-2 sm:mt-4 sm:pt-4 sm:gap-3 sm:justify-between">
        <div className="min-w-0 flex-1">
          {loading ? (
            <p className="ui-text-row-description text-[color:var(--app-secondary-label)]">
              Loading your connections…
            </p>
          ) : connectionsUnavailable ? (
            <p className="ui-text-row-description text-[color:var(--app-secondary-label)]">
              Couldn't load your connections. Try again to find your people.
            </p>
          ) : isEmpty ? (
            <div>
              <p className="hidden sm:block ui-text-row-description font-medium text-[color:var(--app-label)]">
                Start with someone you trust.
              </p>
              <p className="text-xs leading-4 sm:text-sm sm:leading-5 sm:mt-1 text-[color:var(--app-secondary-label)]">
                Send a request, then add people after they accept.
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden="true" className="flex shrink-0 -space-x-2">
                {shownConnections.map((person) => (
                  <span
                    key={person.connectionId}
                    className="rounded-full border-2 border-[color:var(--app-card-surface-default-solid)]"
                  >
                    <ConnectionPersonAvatar
                      size="compact"
                      photoUrl={person.photoUrl}
                      label={person.displayName || "Connection"}
                    />
                  </span>
                ))}
                {moreConnections ? (
                  <span className="relative flex size-8 items-center justify-center rounded-full border-2 border-[color:var(--app-card-surface-default-solid)] bg-[color:var(--app-secondary-surface)] text-[10px] font-semibold">
                    +{moreConnections}
                  </span>
                ) : null}
              </span>
              <div className="min-w-0">
                <p className="text-xs leading-4 sm:text-sm sm:leading-5 text-[color:var(--app-label)]">
                  <span className="sm:hidden">{totalCount} connected</span>
                  <span className="hidden sm:inline">
                    {totalCount}{" "}
                    {totalCount === 1 ? "connection" : "connections"} to build
                    with
                  </span>
                </p>
                {trusted ? (
                  <button
                    type="button"
                    disabled={Boolean(creating)}
                    onClick={() => onOpenCircle(trusted.id)}
                    className="-ml-1 hidden sm:flex min-h-11 items-center gap-1 rounded-full px-1 text-xs text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                  >
                    <ShieldCheck
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    Your Trusted Circle
                    <ArrowRight
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="blue"
          effect="fade"
          size="standard"
          disabled={loading || Boolean(creating)}
          onClick={connectionsUnavailable ? onRetry : onFindPeople}
          className="shrink-0 gap-2 !px-3 !text-sm sm:!px-5 sm:!text-base border border-[color:var(--app-accent)]"
        >
          <span className="inline-flex items-center gap-2">
            <UserPlus aria-hidden="true" className="hidden sm:block size-4" />
            {connectionsUnavailable ? "Try again" : "Add connection"}
          </span>
        </Button>
      </div>
    </section>
  );
}

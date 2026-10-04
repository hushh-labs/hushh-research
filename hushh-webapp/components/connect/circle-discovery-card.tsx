"use client";

import { useId, type CSSProperties } from "react";
import {
  AlertCircle,
  ArrowRight,
  Briefcase,
  FinanceAgentIcon,
  Heart,
  MapPin,
  Plus,
  ShieldCheck,
  TrendingUp,
} from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import { DASHBOARD_AGENT_ICON_STYLE_BY_ID } from "@/lib/design/home-icon-palette";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import type { OneLocationCircleMember } from "@/lib/one-location/types";
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
  sms: AlertCircle,
};
const STARTER_STYLES = {
  family: DASHBOARD_AGENT_ICON_STYLE_BY_ID.email,
  finance: DASHBOARD_AGENT_ICON_STYLE_BY_ID.finance,
  investor: DASHBOARD_AGENT_ICON_STYLE_BY_ID.ria,
  business: DASHBOARD_AGENT_ICON_STYLE_BY_ID.consent,
  location: DASHBOARD_AGENT_ICON_STYLE_BY_ID.location,
  sms: DASHBOARD_AGENT_ICON_STYLE_BY_ID.gmail,
};
const STARTER_ORDER: readonly CircleStarterId[] = [
  "sms",
  "location",
  "family",
  "finance",
  "investor",
  "business",
];
const STARTER_DESCRIPTIONS = {
  sms: "Emergency contacts & alerts",
  location: "Choose who to share your location with",
  family: "Shared family trusted network",
  finance: "Private banking & investments",
  investor: "Key stakeholders & updates",
  business: "Partners & company contacts",
};

export type CircleDiscoveryCardProps = {
  ownerName: string;
  ownerPhotoUrl?: string | null;
  connections: readonly ConnectionSummaryEntry[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  snapshot: ConnectCirclesSnapshot;
  loadCircleMembers?: (
    circleId: string,
  ) => Promise<readonly OneLocationCircleMember[]>;
  creating: CircleStarterId | null;
  onFindPeople: () => void;
  onCreateCircle: () => void;
  onUseStarter: (starter: CircleStarter) => void;
  onOpenCircle: (circleId: string) => void;
  onRetry: () => void;
  onRetryCircles: () => void;
  onSetupCircles: () => void;
};

/** A compact view of the existing starter actions; the circle service owns creation. */
export function CircleDiscoveryCard({
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
  const headingId = useId();
  const trusted = snapshot.circles.find(
    (item) => item.role === "owner" && item.systemKind === "trusted",
  );
  const shownConnections = connections.slice(0, 3);
  const moreConnections = Math.max(0, totalCount - shownConnections.length);
  const unavailable = !snapshot.loading && Boolean(snapshot.error);
  const needsSetup = !snapshot.loading && !snapshot.available && !unavailable;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="connect-living-connections"
      data-circle-discovery-card=""
      className={CONNECT_HERO_CLASSNAME}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2
              id={headingId}
              className="ui-text-card-title text-[color:var(--app-label)]"
            >
              Circles
            </h2>
            <span className="rounded-full bg-[color:var(--app-secondary-surface)] px-2 py-0.5 text-xs text-[color:var(--app-secondary-label)]">
              {CIRCLE_STARTERS.length}
            </span>
          </div>
          <p className="ui-text-caption mt-1 text-[color:var(--app-secondary-label)]">
            Manage access permissions across your trusted groups.
          </p>
        </div>
        <Button
          type="button"
          variant="blue"
          effect="fade"
          size="compact"
          aria-label="Create your own circle"
          disabled={Boolean(creating)}
          onClick={onCreateCircle}
          className="shrink-0 gap-1 !px-2.5"
        >
          <span className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap">
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            <span>Custom circle</span>
          </span>
        </Button>
      </div>
      <div
        className="mt-3 divide-y divide-[color:var(--app-card-border-standard)]"
        data-circle-discovery-content=""
      >
        {STARTER_ORDER.map((id) => {
          const starter = CIRCLE_STARTERS.find((item) => item.id === id)!;
          const circle = findStarterCircle(snapshot.circles, starter);
          const Icon = STARTER_ICONS[id];
          return (
            <div
              key={id}
              className="flex min-h-16 items-center gap-3 py-2"
              data-testid={`circle-starter-${id}`}
            >
              <span
                style={STARTER_STYLES[id] as CSSProperties}
                data-circle-starter-icon={id}
                className="flex size-9 shrink-0 items-center justify-center rounded-full border border-current/15 bg-[color:var(--agent-icon-profile-bg)] text-[color:var(--agent-icon-profile-fg)] dark:bg-[color:var(--agent-icon-profile-bg-dark)] dark:text-[color:var(--agent-icon-profile-fg-dark)]"
              >
                <Icon
                  aria-hidden="true"
                  weight="duotone"
                  className="size-4.5"
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ui-text-row-label-compact">{starter.label}</span>
                </div>
                <p className="ui-text-caption mt-0.5 text-[color:var(--app-secondary-label)]">
                  {circle && id === "location"
                    ? `${circle.memberCount} ${circle.memberCount === 1 ? "member" : "members"}`
                    : STARTER_DESCRIPTIONS[id]}
                </p>
              </div>
              <Button
                type="button"
                variant={circle ? "blue" : "none"}
                effect="fade"
                size="compact"
                disabled={snapshot.loading || Boolean(creating) || unavailable}
                onClick={() =>
                  needsSetup
                    ? onSetupCircles()
                    : circle
                      ? onOpenCircle(circle.id)
                      : onUseStarter(starter)
                }
                aria-label={`${circle ? "Open" : "Setup"} ${starter.label} circle`}
                className="min-w-16 shrink-0 !bg-transparent !px-3 hover:!bg-transparent"
              >
                {creating === id
                  ? "Creating…"
                  : snapshot.loading
                    ? "Loading…"
                    : circle
                      ? "Open"
                      : "Setup"}
              </Button>
            </div>
          );
        })}
      </div>
      {unavailable ? (
        <div className="flex items-center justify-between gap-2">
          <p className="ui-text-caption">Couldn't load your circles.</p>
          <Button
            type="button"
            variant="blue"
            effect="fade"
            size="compact"
            onClick={onRetryCircles}
          >
            Retry circles
          </Button>
        </div>
      ) : null}
      {needsSetup ? (
        <Button
          type="button"
          variant="blue"
          effect="fade"
          size="compact"
          onClick={onSetupCircles}
        >
          Finish setting up One
        </Button>
      ) : null}
      <div
        data-circle-discovery-footer=""
        className="mt-3 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--app-card-border-standard)] pt-2"
      >
        <button
          type="button"
          onClick={error && totalCount === 0 ? onRetry : onFindPeople}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-full text-left text-xs text-[color:var(--app-secondary-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          <span aria-hidden="true" className="flex shrink-0 -space-x-2">
            {shownConnections.map((person) => (
              <span
                key={person.connectionId}
                className="rounded-full border-2 border-[color:var(--app-card-surface-default-solid)]"
              >
                <ConnectionPersonAvatar
                  size="compact"
                  className="!size-6"
                  photoUrl={person.photoUrl}
                  label={person.displayName || "Connection"}
                />
              </span>
            ))}
            {moreConnections > 0 ? (
              <span className="relative flex size-7 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[10px]">
                +{moreConnections}
              </span>
            ) : null}
          </span>
          <span>
            {loading
              ? "Loading connections…"
              : error && totalCount === 0
                ? "Retry connections"
                : totalCount === 0
                  ? "Find people to connect with"
                  : `${totalCount} ${totalCount === 1 ? "connection" : "connections"} to build with`}
          </span>
        </button>
        {trusted ? (
          <button
            type="button"
            data-circle-discovery-trusted=""
            disabled={Boolean(creating)}
            onClick={() => onOpenCircle(trusted.id)}
            className="ml-auto inline-flex min-h-11 items-center gap-1.5 text-xs md:gap-2 md:text-sm font-normal text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50"
          >
            <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 md:size-4" />
            <span>Your Trusted Circle</span>
            <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 md:size-4" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

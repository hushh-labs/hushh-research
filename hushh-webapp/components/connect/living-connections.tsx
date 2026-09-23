"use client";

import { UserPlus, UsersRound } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import {
  CONNECT_HERO_ACTIONS_CLASSNAME,
  CONNECT_HERO_CLASSNAME,
  CONNECT_HERO_ORBIT_CLASSNAME,
} from "./connect-living-layout";

type LivingConnectionsProps = {
  ownerName: string;
  ownerPhotoUrl?: string | null;
  connections: readonly ConnectionSummaryEntry[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  onFindPeople: () => void;
  onExploreCircles: () => void;
  onOpenPerson: (personRef: string) => void;
  onRetry: () => void;
};

const NODE_POSITIONS = [
  { left: "20%", top: "26%" },
  { left: "80%", top: "26%" },
  { left: "20%", top: "74%" },
  { left: "80%", top: "74%" },
] as const;

/** A small visual summary of real connections; the directory remains the full roster. */
export function LivingConnections({
  ownerName,
  ownerPhotoUrl,
  connections,
  totalCount,
  loading,
  error,
  onFindPeople,
  onExploreCircles,
  onOpenPerson,
  onRetry,
}: LivingConnectionsProps) {
  const visible = connections.slice(0, NODE_POSITIONS.length);
  const isEmpty = !loading && !error && totalCount === 0;

  return (
    <section
      aria-label="Your connections at a glance"
      data-testid="connect-living-connections"
      className={CONNECT_HERO_CLASSNAME}
    >
      <div className="mx-auto max-w-[36rem] text-center">
        <div className={CONNECT_HERO_ORBIT_CLASSNAME}>
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          >
            {visible.map((connection, index) => {
              const position = [
                [20, 26],
                [80, 26],
                [20, 74],
                [80, 74],
              ][index];
              if (!position) return null;
              return (
                <line
                  key={connection.connectionId}
                  x1="50"
                  y1="50"
                  x2={position[0]}
                  y2={position[1]}
                  stroke="var(--app-card-border-standard)"
                  strokeWidth="0.42"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {isEmpty ? (
              <line
                x1="50"
                y1="50"
                x2="80"
                y2="36"
                stroke="var(--app-card-border-standard)"
                strokeWidth="0.42"
                strokeDasharray="4 5"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          <div className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5">
            <span className="rounded-full border-2 border-[color:var(--app-accent)] p-1">
              <ConnectionPersonAvatar
                size="profile"
                photoUrl={ownerPhotoUrl}
                label={ownerName}
              />
            </span>
            <span className="ui-text-row-description max-w-24 truncate text-[color:var(--app-primary-label)]">
              You
            </span>
          </div>

          {visible.map((connection, index) => {
            const position = NODE_POSITIONS[index];
            if (!position) return null;
            const name = connection.displayName || connection.userId;
            const content = (
              <>
                <span className="rounded-full border border-[color:var(--app-card-border-standard)] bg-background p-1 transition-colors group-hover:border-[color:var(--app-accent)] motion-reduce:transition-none">
                  <ConnectionPersonAvatar
                    size="list"
                    photoUrl={connection.photoUrl}
                    label={name}
                    verified={Boolean(connection.isRia)}
                  />
                </span>
              </>
            );
            const className =
              "group absolute z-10 flex min-h-11 -translate-x-1/2 -translate-y-1/2 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]";
            const style = { left: position.left, top: position.top };
            return connection.publicPersonRef ? (
              <button
                key={connection.connectionId}
                type="button"
                className={className}
                style={style}
                aria-label={`Open ${name}'s profile`}
                title={name}
                onClick={() => onOpenPerson(connection.publicPersonRef!)}
              >
                {content}
              </button>
            ) : (
              <div key={connection.connectionId} className={className} style={style} title={name}>
                {content}
              </div>
            );
          })}

          {isEmpty ? (
            <div
              aria-hidden="true"
              className="absolute left-[80%] top-[36%] flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-dashed border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-fill)] text-[color:var(--app-secondary-label)] sm:size-16"
            >
              <UserPlus className="size-6" />
            </div>
          ) : null}
        </div>

        <h2 className="ui-text-major-section-title text-[color:var(--app-primary-label)]">
          {loading
            ? "Finding your people…"
            : error && totalCount === 0
              ? "Your people are unavailable"
              : isEmpty
                ? "Bring your people closer"
                : "Your people, together"}
        </h2>
        <p className="ui-text-page-subtitle mx-auto mt-1 max-w-[30rem] text-[color:var(--app-secondary-label)]">
          {loading
            ? "Your connections will appear here in a moment."
            : error && totalCount === 0
              ? "We couldn't load your connections. Try again to see your people."
              : isEmpty
                ? "Connect with someone you trust, then create shared circles together."
                : `${totalCount} ${totalCount === 1 ? "connection" : "connections"}. Bring people together in circles for what matters to you.`}
        </p>
        <div className={CONNECT_HERO_ACTIONS_CLASSNAME}>
          <Button
            type="button"
            variant="blue"
            effect="fill"
            size="standard"
            onClick={error && totalCount === 0 ? onRetry : onFindPeople}
            disabled={loading}
            className="gap-2"
          >
            <UserPlus aria-hidden="true" className="size-4" />
            {error && totalCount === 0
              ? "Try again"
              : isEmpty
                ? "Find your first connection"
                : "Find people"}
          </Button>
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="standard"
            onClick={onExploreCircles}
            className="gap-2"
          >
            <UsersRound aria-hidden="true" className="size-4" />
            Explore circles
          </Button>
        </div>
        <details className="mx-auto mt-4 max-w-[30rem] text-left text-[color:var(--app-secondary-label)]">
          <summary className="ui-text-row-description mx-auto w-fit cursor-pointer rounded-full px-2 py-1 text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]">
            How Connect works
          </summary>
          <ol className="ui-text-row-description mt-3 space-y-2 rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-secondary-fill)] px-4 py-3">
            <li>1. Find someone on One and send a connection request.</li>
            <li>2. Make a circle for the people you choose.</li>
            <li>3. Use that circle where One supports sharing with a group.</li>
          </ol>
        </details>
      </div>
    </section>
  );
}

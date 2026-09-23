"use client";

import { UserPlus, UsersRound } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";
import {
  CONNECT_HERO_ACTIONS_CLASSNAME,
  CONNECT_HERO_CLASSNAME,
} from "./connect-living-layout";
import { PeopleOrbit } from "./people-orbit";

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
  const isEmpty = !loading && !error && totalCount === 0;

  return (
    <section
      aria-label="Your connections at a glance"
      data-testid="connect-living-connections"
      className={CONNECT_HERO_CLASSNAME}
    >
      <div className="mx-auto max-w-[36rem] text-center">
        <PeopleOrbit
          people={connections.map((connection) => ({
            id: connection.connectionId,
            name: connection.displayName || connection.userId,
            photoUrl: connection.photoUrl,
            verified: Boolean(connection.isRia),
            publicPersonRef: connection.publicPersonRef,
          }))}
          totalCount={isEmpty ? 0 : totalCount}
          onOpenPerson={onOpenPerson}
          emptyAdornment={isEmpty ? (
            <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-[color:var(--app-card-border-standard)] bg-[color:var(--app-secondary-fill)] text-[color:var(--app-secondary-label)]">
              <UserPlus className="size-5" />
            </span>
          ) : undefined}
          center={
            <span className="flex flex-col items-center gap-1">
              <span className="rounded-full border-2 border-[color:var(--app-accent)] bg-[color:var(--app-card-surface-default-solid)] p-1">
                <ConnectionPersonAvatar size="profile" photoUrl={ownerPhotoUrl} label={ownerName} />
              </span>
              <span className="ui-text-row-description text-[color:var(--app-primary-label)]">You</span>
            </span>
          }
        />

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

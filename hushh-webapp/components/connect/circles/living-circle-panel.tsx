"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, UsersRound } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { PeopleOrbit } from "@/components/connect/people-orbit";
import { Button } from "@/components/ui/button";
import { buildPersonProfileRoute, ROUTES } from "@/lib/navigation/routes";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleMember,
} from "@/lib/one-location/types";

const DRAG_TYPE = "application/x-hushh-circle-person";

export function LivingCirclePanel({
  circleName,
  members,
  memberCount,
  canInvite,
  candidates,
  availableCount,
  remainingCapacity,
  loading,
  error,
  addingUserId,
  onAdd,
  searchQuery,
  onSearchChange,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
}: {
  circleName: string;
  members: readonly OneLocationCircleMember[];
  memberCount: number;
  canInvite: boolean;
  candidates: readonly OneLocationCircleEligibleConnection[];
  availableCount: number;
  remainingCapacity: number;
  loading: boolean;
  error: string | null;
  addingUserId: string | null;
  onAdd: (userId: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const [overCircle, setOverCircle] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const shownCandidates = expanded ? candidates : candidates.slice(0, 6);
  const owner = members.find((member) => member.role === "owner");
  const orbitMembers = owner
    ? members.filter((member) => member.userId !== owner.userId)
    : members;
  const orbitMemberCount = Math.max(0, memberCount - (owner ? 1 : 0));
  // Keep the first four positions stable while a new circle grows. These are
  // illustrations, not member records or a representation of the circle limit.
  const emptySlots =
    canInvite &&
    members.length === memberCount &&
    memberCount > 0 &&
    (loading || !error)
      ? Math.min(
          Math.max(0, 4 - memberCount),
          loading ? 3 : Math.max(0, remainingCapacity),
        )
      : 0;
  const addFromDrop = (userId: string) => {
    if (!canInvite || addingUserId || remainingCapacity <= 0) return;
    if (candidates.some((candidate) => candidate.userId === userId)) onAdd(userId);
  };
  const profileHref = (publicPersonRef: string) =>
    buildPersonProfileRoute(publicPersonRef, { from: ROUTES.CONNECT });
  const ownerAvatar = owner ? (
    <span className="flex size-16 items-center justify-center rounded-full border-2 border-[color:var(--app-accent)] bg-[color:var(--app-card-surface-default-solid)] p-1 text-[color:var(--app-accent)] shadow-sm transition-transform duration-150 hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none">
      <ConnectionPersonAvatar
        size="profile"
        className="!size-12"
        photoUrl={owner.photoUrl}
        label={owner.displayName}
        verified={Boolean(owner.isRia)}
      />
    </span>
  ) : (
    <span className="flex size-16 items-center justify-center rounded-full border-2 border-[color:var(--app-accent)] bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-accent)] shadow-sm">
      <UsersRound aria-hidden="true" className="size-7" />
    </span>
  );

  return (
    <section
      data-testid="connect-living-circle-detail"
      aria-label={`${circleName} members`}
      className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-5 sm:px-6 sm:py-6"
    >
      <div
        data-testid="connect-circle-drop-zone"
        className={`mx-auto w-fit rounded-full bg-[radial-gradient(circle,var(--app-secondary-surface)_0%,transparent_70%)] transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none ${overCircle ? "ring-2 ring-[color:var(--app-accent)]" : ""}`}
        onDragOver={(event) => {
          if (!canInvite || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOverCircle(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverCircle(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOverCircle(false);
          addFromDrop(event.dataTransfer.getData(DRAG_TYPE));
        }}
      >
        <PeopleOrbit
          people={orbitMembers.map((member) => ({
            id: member.userId,
            name: member.displayName,
            photoUrl: member.photoUrl,
            verified: Boolean(member.isRia),
            publicPersonRef: member.publicPersonRef,
          }))}
          totalCount={orbitMemberCount}
          emptySlots={emptySlots}
          center={
            owner?.publicPersonRef ? (
              <Link
                data-testid="circle-owner-profile"
                className="cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                title={owner.displayName}
                aria-label={`Open ${owner.displayName}'s profile`}
                href={profileHref(owner.publicPersonRef)}
              >
                {ownerAvatar}
              </Link>
            ) : (
              ownerAvatar
            )
          }
          profileHrefForPerson={profileHref}
        />
      </div>
      <p aria-live="polite" className="ui-text-row-description mt-1 text-center text-[color:var(--app-secondary-label)]">
        {overCircle
          ? "Release to add this person"
          : memberCount <= 1
            ? "Your circle starts with you"
            : `${memberCount} people in this circle`}
      </p>
      {memberCount === 1 && emptySlots > 0 ? (
        <p className="mt-1 text-center text-xs text-[color:var(--app-secondary-label)]">
          Room for the people you choose.
        </p>
      ) : null}

      {canInvite ? (
        <div className="mx-auto mt-6 max-w-[34rem] border-t border-[color:var(--app-card-border-standard)] pt-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="ui-text-card-title text-[color:var(--app-primary-label)]">Bring in your connections</h2>
              <p className="ui-text-row-description mt-1 text-[color:var(--app-secondary-label)]">
                Drag a person into the circle on desktop, or tap Add on any device.
              </p>
            </div>
            {remainingCapacity > 0 && (availableCount > 6 || expanded) ? (
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => {
                  if (expanded) onSearchChange("");
                  setExpanded(!expanded);
                }}
              >
                {expanded ? "Show less" : `See all (${availableCount})`}
              </Button>
            ) : null}
          </div>
          {expanded ? (
            <label className="mt-4 block">
              <span className="sr-only">Search connections to add</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search connections"
                className="h-11 w-full rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 text-[color:var(--app-primary-label)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
              />
            </label>
          ) : null}
          {loading ? (
            <p className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">Loading connections…</p>
          ) : error ? (
            <div className="mt-4 flex items-center gap-3">
              <p className="ui-text-row-description text-[color:var(--app-secondary-label)]">{error}</p>
              <Button type="button" variant="outline" size="compact" onClick={onRetry}>Retry</Button>
            </div>
          ) : remainingCapacity <= 0 ? (
            <p className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">This circle is full.</p>
          ) : shownCandidates.length ? (
            <div className="mt-4 grid grid-cols-1 gap-2 min-[430px]:grid-cols-2">
              {shownCandidates.map((person) => (
                <div
                  key={person.userId}
                  draggable={!addingUserId}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_TYPE, person.userId);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  className="flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-2.5 py-2 shadow-[0_2px_12px_-10px_rgba(15,23,42,0.28)] transition-[border-color,box-shadow] duration-200 hover:border-[color:var(--app-accent)] sm:cursor-grab sm:active:cursor-grabbing"
                >
                  <ConnectionPersonAvatar size="compact" photoUrl={person.photoUrl} label={person.displayName} verified={person.isRia} />
                  <span className="ui-text-row-description min-w-0 flex-1 truncate text-[color:var(--app-primary-label)]" title={person.displayName}>{person.displayName}</span>
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-sm font-semibold text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50"
                    onClick={() => onAdd(person.userId)}
                    disabled={Boolean(addingUserId)}
                    aria-label={`Add ${person.displayName} to ${circleName}`}
                  >
                    <Plus aria-hidden="true" className="size-4" /> {addingUserId === person.userId ? "Adding…" : "Add"}
                  </button>
                </div>
              ))}
            </div>
          ) : searchQuery.trim() ? (
            <p className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">
              No matching connections.
            </p>
          ) : (
            <p className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">
              No connections available to add. <Link className="font-semibold text-[color:var(--app-accent)] underline-offset-2 hover:underline" href={`${ROUTES.CONNECT}?tab=all`}>Find people</Link>
            </p>
          )}
          {expanded && hasMore && !loading && !error && remainingCapacity > 0 ? (
            <Button type="button" variant="outline" size="compact" className="mt-4 w-full" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "Loading…" : "Load more connections"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

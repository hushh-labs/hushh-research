"use client";

import { PersonProfileLink } from "@/components/connections/person-profile-link";
import { useId, useState } from "react";
import Link from "next/link";
import { Check, Plus, Trash2, UsersRound } from "@/components/icons";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { PeopleOrbit } from "@/components/connect/people-orbit";
import { CircleAvatar } from "./circle-photo-editor";
import { Button } from "@/components/ui/button";
import { SheetCount, SheetPersonRow, SheetSearch, sheetPartStyles } from "@/components/app-ui/sheet-parts";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { TaskSurfaceToolbar, TaskSurfaceBody, TaskSurfaceFooter } from "@/lib/morphy-ux/ui/task-surfaces";
import { buildPersonProfileRoute, ROUTES } from "@/lib/navigation/routes";
import { filterPeopleByQuery } from "@/lib/one-location/people-search";
import { circleInviteSelectionLimit } from "@/lib/one-location/circle-invite-contract";
import { connectPersonName, connectPersonSelectionDetail } from "@/lib/connections/person-label";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleMember,
} from "@/lib/one-location/types";

const DRAG_TYPE = "application/x-hushh-circle-person";
const REMOVE_DRAG_TYPE = "application/x-hushh-circle-remove-member";

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
  selectedUserIds,
  selectedPeople = candidates,
  submitting,
  onAdd,
  onSubmit,
  onRemove,
  searchQuery,
  onSearchChange,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
  groupPhotoUrl,
  showGroupIdentity = false,
  focusOnAdding = false,
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
  selectedUserIds: ReadonlySet<string>;
  selectedPeople?: readonly OneLocationCircleEligibleConnection[];
  submitting: boolean;
  onAdd: (userId: string) => void;
  onSubmit: () => void;
  onRemove?: (userId: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  groupPhotoUrl?: string | null;
  showGroupIdentity?: boolean;
  /** First-member setup keeps the next action ahead of the decorative preview. */
  focusOnAdding?: boolean;
}) {
  const [peopleView, setPeopleView] = useState("all");
  const peopleViewId = useId().replace(/:/g, "");
  const visiblePeople = peopleView === "selected"
    ? filterPeopleByQuery(selectedPeople.filter(person => selectedUserIds.has(person.userId)), searchQuery, connectPersonName)
    : candidates;
  const [overCircle, setOverCircle] = useState(false);
  const [overRemoveZone, setOverRemoveZone] = useState(false);
  const [draggingMemberId, setDraggingMemberId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const shownCandidates = expanded ? candidates : candidates.slice(0, 6);
  const selectionLimit = circleInviteSelectionLimit(remainingCapacity);
  const owner = members.find((member) => member.role === "owner");
  const orbitMembers = owner && !showGroupIdentity
    ? members.filter((member) => member.userId !== owner.userId)
    : members;
  const orbitMemberCount = Math.max(0, memberCount - (owner && !showGroupIdentity ? 1 : 0));
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
    if (!canInvite || submitting || selectedUserIds.has(userId) || selectedUserIds.size >= selectionLimit) return;
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
        label={connectPersonName(owner)}
        verified={Boolean(owner.isRia)}
      />
    </span>
  ) : (
    <span className="flex size-16 items-center justify-center rounded-full border-2 border-[color:var(--app-accent)] bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-accent)] shadow-sm">
      <UsersRound aria-hidden="true" className="size-7" />
    </span>
  );

  if (focusOnAdding) return (
    <section data-testid="connect-circle-add-picker" className="contents" aria-label={`Add people to ${circleName}`}>
      <TaskSurfaceToolbar>
        <SheetSearch value={searchQuery} onValueChange={onSearchChange} label="Search connections to add" placeholder="Name, email or phone" />
        <SegmentedTabs className={sheetPartStyles.tabs} value={peopleView} onValueChange={setPeopleView} ariaLabel="People views" variant="subordinate"
          tabSetId={peopleViewId} options={[{ value: "all", label: "All connections" }, { value: "selected", label: `Selected (${selectedUserIds.size})` }]} />
      </TaskSurfaceToolbar>
      <TaskSurfaceBody role="tabpanel" id={`top-shell-${peopleViewId}-panel-${peopleView}`} aria-labelledby={`top-shell-${peopleViewId}-tab-${peopleView}`}>
        {error ? <div className="flex items-center justify-between gap-3 py-3" role="status"><p className="text-sm text-muted-foreground">{error}</p><Button type="button" variant="ghost" size="compact" onClick={onRetry}>Retry</Button></div> : null}
        {loading && !candidates.length && peopleView === "all" ? <p className="py-4 text-sm text-muted-foreground">Loading connections…</p>
          : remainingCapacity <= 0 ? <p className="py-4 text-sm text-muted-foreground">This circle is full.</p>
          : visiblePeople.length ? visiblePeople.map(person => <SheetPersonRow key={person.userId}
            avatar={<ConnectionPersonAvatar userId={person.userId} size="compact" className="!size-9" photoUrl={person.photoUrl} label={connectPersonName(person)} verified={person.isRia} />}
            name={connectPersonName(person)} detail={connectPersonSelectionDetail(person)} checked={selectedUserIds.has(person.userId)}
            onCheckedChange={() => onAdd(person.userId)}
            disabled={submitting || (!selectedUserIds.has(person.userId) && selectedUserIds.size >= selectionLimit)}
            label={`Add ${connectPersonName(person)} to ${circleName}`} />)
          : !error ? <p className="py-4 text-sm text-muted-foreground">{peopleView === "selected" ? "No people selected." : searchQuery.trim() ? "No matching connections." : "No connections available to add."}</p> : null}
        {peopleView === "all" && hasMore && !loading && !error && remainingCapacity > 0 ? <Button type="button" variant="ghost" size="compact" className="my-3 w-full" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading…" : "Load more connections"}</Button> : null}
      </TaskSurfaceBody>
      <TaskSurfaceFooter>
        <SheetCount>{selectedUserIds.size} selected</SheetCount>
        <Button type="button" size="compact" onClick={onSubmit} disabled={submitting || Boolean(error) || !selectedUserIds.size || selectedUserIds.size > selectionLimit}>{submitting ? "Adding people…" : "Add people"}</Button>
      </TaskSurfaceFooter>
    </section>
  );

  return (
    <section
      data-profile-type-scale="circles"
      data-testid="connect-living-circle-detail"
      aria-label={`${circleName} members`}
      className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-4 py-5 sm:px-6 sm:py-6"
    >
      {!focusOnAdding ? <>
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
            name: connectPersonName(member),
            photoUrl: member.photoUrl,
            verified: Boolean(member.isRia),
            publicPersonRef: member.publicPersonRef,
          }))}
          totalCount={orbitMemberCount}
          emptySlots={emptySlots}
          center={
            showGroupIdentity ? <CircleAvatar photoUrl={groupPhotoUrl} className="size-16 ring-2 ring-background" /> : owner?.publicPersonRef ? (
              <PersonProfileLink
                data-testid="circle-owner-profile"
                className="cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
                title={connectPersonName(owner)}
                aria-label={`Open ${connectPersonName(owner)}'s profile`}
                href={profileHref(owner.publicPersonRef)}
              >
                {ownerAvatar}
              </PersonProfileLink>
            ) : (
              ownerAvatar
            )
          }
          profileHrefForPerson={profileHref}
          onMemberDragStart={
            onRemove
              ? (person, event) => {
                  event.dataTransfer.setData(REMOVE_DRAG_TYPE, person.id);
                  event.dataTransfer.effectAllowed = "move";
                  setDraggingMemberId(person.id);
                }
              : undefined
          }
          onMemberDragEnd={
            onRemove
              ? () => {
                  setDraggingMemberId(null);
                  setOverRemoveZone(false);
                }
              : undefined
          }
        />
      </div>
      <p data-profile-role="description" aria-live="polite" className="ui-text-row-description mt-1 text-center text-[color:var(--app-secondary-label)]">
        {overCircle
          ? "Release to select this person"
          : overRemoveZone
            ? "Release to remove from circle"
            : draggingMemberId
              ? "Drag down to remove from circle"
              : memberCount <= 1
                ? "Your circle starts with you"
                : `${memberCount} people in this circle`}
      </p>
      {memberCount === 1 && emptySlots > 0 ? (
        <p data-profile-role="description" className="mt-1 text-center text-xs text-[color:var(--app-secondary-label)]">
          Room for the people you choose.
        </p>
      ) : null}
      </> : null}

      {canInvite || onRemove ? (
        <div
          data-testid="connect-circle-remove-drop-zone"
          className={`mx-auto w-full max-w-[34rem] rounded-[var(--app-card-radius-standard)] border-[color:var(--app-card-border-standard)] transition-[background-color,box-shadow] duration-200 ${focusOnAdding ? "" : "mt-6 border-t pt-5"} ${
            overRemoveZone
              ? "bg-[color:var(--app-destructive-tint)] p-3 ring-2 ring-[color:var(--app-destructive-border)]"
              : draggingMemberId
                ? "bg-[color:var(--app-destructive-tint)]/40 p-3 ring-1 ring-dashed ring-[color:var(--app-destructive-border)]"
                : ""
          }`}
          onDragOver={(event) => {
            if (!onRemove || !event.dataTransfer.types.includes(REMOVE_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setOverRemoveZone(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverRemoveZone(false);
          }}
          onDrop={(event) => {
            if (!onRemove || !event.dataTransfer.types.includes(REMOVE_DRAG_TYPE)) return;
            event.preventDefault();
            const memberId = event.dataTransfer.getData(REMOVE_DRAG_TYPE);
            setOverRemoveZone(false);
            setDraggingMemberId(null);
            if (memberId && onRemove) {
              onRemove(memberId);
            }
          }}
        >
          {draggingMemberId || overRemoveZone ? (
            <div
              data-testid="connect-circle-remove-banner"
              className="mb-4 flex items-center justify-center gap-2 rounded-[var(--app-card-radius-compact)] border border-dashed border-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)] px-4 py-3 text-sm font-medium text-destructive transition-[background-color,border-color] duration-150"
            >
              <Trash2 className="size-4 shrink-0" aria-hidden="true" />
              <span>{overRemoveZone ? "Release to remove from circle" : "Drag down here to remove from circle"}</span>
            </div>
          ) : null}

          {canInvite ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="ui-text-card-title text-[color:var(--app-primary-label)]">Bring in your connections</h2>
                  <p data-profile-role="description" className="ui-text-row-description mt-1 text-[color:var(--app-secondary-label)]">
                    Select people, then add them together.
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
              {error ? (
                <div className="mt-4 flex items-center gap-3" role="status">
                  <p data-profile-role="description" className="ui-text-row-description text-[color:var(--app-secondary-label)]">{error}</p>
                  <Button type="button" variant="outline" size="compact" onClick={onRetry}>Retry</Button>
                </div>
              ) : null}
              {loading && !candidates.length ? (
                <p data-profile-role="description" className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">Loading connections…</p>
              ) : error && !candidates.length ? null
              : remainingCapacity <= 0 ? (
                <p data-profile-role="description" className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">This circle is full.</p>
              ) : shownCandidates.length ? (
                <div className="mt-4 grid grid-cols-1 gap-2 min-[430px]:grid-cols-2">
                  {shownCandidates.map((person, index) => (
                    <div
                      key={person.userId}
                      draggable={!focusOnAdding && !submitting && (selectedUserIds.has(person.userId) || selectedUserIds.size < selectionLimit)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DRAG_TYPE, person.userId);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      className="flex min-w-0 items-center gap-2 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-2.5 py-2 shadow-[0_2px_12px_-10px_rgba(15,23,42,0.28)] transition-[border-color,box-shadow] duration-200 hover:border-[color:var(--app-accent)] "
                    >
                      <ConnectionPersonAvatar userId={person.userId} size="compact" photoUrl={person.photoUrl} label={connectPersonName(person)} verified={person.isRia} />
                      <span className="min-w-0 flex-1">
                        <span data-profile-role="name" className="block truncate text-[color:var(--app-primary-label)]" title={connectPersonName(person)}>{connectPersonName(person)}</span>
                        <span id={`${peopleViewId}-${index}-detail`} className="block text-xs text-[color:var(--app-secondary-label)]">{connectPersonSelectionDetail(person)}</span>
                      </span>
                      <button
                        type="button"
                        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-sm font-semibold text-[color:var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] disabled:opacity-50"
                        onClick={() => onAdd(person.userId)}
                        disabled={submitting || (!selectedUserIds.has(person.userId) && selectedUserIds.size >= selectionLimit)}
                        aria-pressed={selectedUserIds.has(person.userId)}
                        aria-label={`Add ${connectPersonName(person)} to ${circleName}`}
                        aria-describedby={`${peopleViewId}-${index}-detail`}
                      >
                        {selectedUserIds.has(person.userId) ? <Check aria-hidden="true" className="size-4" /> : <Plus aria-hidden="true" className="size-4" />}
                        {selectedUserIds.has(person.userId) ? "Selected" : "Add"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : searchQuery.trim() ? (
                <p data-profile-role="description" className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">
                  No matching connections.
                </p>
              ) : (
                <p data-profile-role="description" className="ui-text-row-description mt-4 text-[color:var(--app-secondary-label)]">
                  No connections available to add. <Link className="font-semibold text-[color:var(--app-accent)] underline-offset-2 hover:underline" href={`${ROUTES.CONNECT}?tab=all`}>Find people</Link>
                </p>
              )}
              {selectedUserIds.size > 0 || submitting ? (
                <div className="mt-4 space-y-2">
                  <p data-profile-role="description" role="status" className="ui-text-row-description text-[color:var(--app-secondary-label)]">
                    {submitting ? "Adding selected people…" : `${selectedUserIds.size} selected`}
                  </p>
                  {selectedUserIds.size >= selectionLimit && !submitting ? (
                    <p data-profile-role="description" className="text-xs text-[color:var(--app-secondary-label)]">You can add up to {selectionLimit} people at a time.</p>
                  ) : null}
                  <Button type="button" className="w-full" onClick={onSubmit} disabled={submitting || Boolean(error) || selectedUserIds.size > selectionLimit}>
                    {submitting ? "Adding people…" : `Add ${selectedUserIds.size} ${selectedUserIds.size === 1 ? "person" : "people"}`}
                  </Button>
                </div>
              ) : null}
              {expanded && hasMore && !loading && !error && remainingCapacity > 0 ? (
                <Button type="button" variant="outline" size="compact" className="mt-4 w-full" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? "Loading…" : "Load more connections"}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

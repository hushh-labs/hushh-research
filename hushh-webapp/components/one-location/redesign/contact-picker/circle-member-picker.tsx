"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, UsersRound } from "lucide-react";

import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { ContactAvatar } from "@/components/one-location/redesign/contact-picker/atoms";
import { ContactListControls } from "@/components/one-location/redesign/contact-picker/list-controls";
import { VirtualContactList } from "@/components/one-location/redesign/contact-picker/virtual-list";
import {
  filterByContactQuery,
  sortByContactMode,
  type ContactSortMode,
} from "@/lib/one-location/contact-picker-controls";
import type { CircleRecipientSelection } from "@/lib/one-location/circle-recipient-selection";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { circleMemberCountLabel } from "@/lib/one-location/circle-member-count";
import { cn } from "@/lib/utils";

type MemberRow = {
  userId: string;
  label: string;
  fromContacts: boolean;
  /** Set when the member cannot receive SMS yet; explains why, inline. */
  blockedReason: string | null;
};

/**
 * One Circle, expandable into its own member picker.
 *
 * The old row offered a single "Add" that took the whole roster. That was
 * tolerable at 20 members and is not at 100 (migration 158): adding a
 * hundred-person Circle to emergency SMS because you wanted four of them is
 * not a mistake the UI should make easy to make.
 *
 * Expanding resolves the roster through the same
 * `resolveCircleRecipientSelection` the Share flow uses, so "who in this Circle
 * can actually receive an SMS" is answered once, in one place, for both
 * features. Members it excludes are still listed -- with the reason -- because
 * someone hunting for a person who is not there needs to know they were found
 * and skipped, not silently absent.
 */
export function CircleMemberPicker({
  circle,
  expanded,
  onToggle,
  selectedUserIds,
  busy,
  onLoadMembers,
  onAddMembers,
  recipientLabel,
}: {
  circle: OneLocationCircleSummary;
  expanded: boolean;
  onToggle: () => void;
  selectedUserIds: ReadonlySet<string>;
  busy: boolean;
  onLoadMembers: (circleId: string) => Promise<CircleRecipientSelection>;
  onAddMembers: (circleId: string, userIds: string[]) => Promise<void>;
  recipientLabel: (person: {
    userId: string;
    displayName?: string | null;
  }) => string;
}) {
  const [selection, setSelection] = useState<CircleRecipientSelection | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ContactSortMode>("default");
  const [adding, setAdding] = useState(false);

  // STATE BEATS CATEGORY: a Circle is the people role, but one holding nobody
  // except the viewer has nothing to report and stays neutral. `memberCount`
  // includes the viewer, so the count that decides this is `memberCount - 1` --
  // the same test the Circles list and the check-in flow apply.
  const circleRole = roleClasses("people", {
    inactive: Math.max(0, circle.memberCount - 1) === 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSelection(await onLoadMembers(circle.id));
    } catch {
      setSelection(null);
      setLoadError("This Circle's members could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [circle.id, onLoadMembers]);

  // Resolved on expand, not on mount. A hub with ten Circles would otherwise
  // fire ten roster requests just to draw ten collapsed rows.
  useEffect(() => {
    if (!expanded || selection || loading || loadError) return;
    void load();
  }, [expanded, load, loadError, loading, selection]);

  const readyRows = useMemo<MemberRow[]>(() => {
    if (!selection) return [];
    return selection.ready.map((target) => ({
      userId: target.recipient.userId,
      label: recipientLabel(target.recipient),
      fromContacts: Boolean(target.recipient.connectedFromContacts),
      blockedReason: null,
    }));
  }, [recipientLabel, selection]);

  const blockedRows = useMemo<MemberRow[]>(() => {
    if (!selection) return [];
    return (
      selection.excluded
        // "You are not a recipient of your own alert" is not news, and listing
        // the viewer in their own Circle's picker is noise in every roster.
        .filter((item) => item.reason !== "self")
        .map((item) => ({
          userId: item.member.userId,
          label: recipientLabel(item.member),
          fromContacts: Boolean(item.member.connectedFromContacts),
          blockedReason: item.label,
        }))
    );
  }, [recipientLabel, selection]);

  const allRows = useMemo(
    () => [...readyRows, ...blockedRows],
    [blockedRows, readyRows],
  );

  const visibleRows = useMemo(
    () =>
      sortByContactMode(
        filterByContactQuery(allRows, query, (row) => row.label),
        sortMode,
        (row) => row.label,
      ),
    [allRows, query, sortMode],
  );

  const addableIds = useMemo(
    () =>
      readyRows
        .filter((row) => !selectedUserIds.has(row.userId))
        .map((row) => row.userId),
    [readyRows, selectedUserIds],
  );
  const tickedAddable = useMemo(
    () => addableIds.filter((id) => ticked.has(id)),
    [addableIds, ticked],
  );
  const allAddableTicked =
    addableIds.length > 0 && tickedAddable.length === addableIds.length;

  const toggleMember = (userId: string) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const commit = async () => {
    if (!tickedAddable.length || adding) return;
    setAdding(true);
    try {
      await onAddMembers(circle.id, tickedAddable);
      setTicked(new Set());
    } finally {
      setAdding(false);
    }
  };

  const alreadyAddedCount = readyRows.filter((row) =>
    selectedUserIds.has(row.userId),
  ).length;

  const toggleAll = () =>
    setTicked((current) => {
      const next = new Set(current);
      if (allAddableTicked) {
        for (const id of addableIds) next.delete(id);
      } else {
        for (const id of addableIds) next.add(id);
      }
      return next;
    });

  return (
    <div data-testid={"circle-picker-" + circle.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={
          (expanded ? "Collapse " : "Choose people from ") + circle.name
        }
        className="flex min-h-[58px] w-full items-center gap-3 px-3.5 py-2 text-left"
      >
        <span
          className={cn(
            "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]",
            circleRole.tile,
            circleRole.glyph,
          )}
        >
          <UsersRound className="h-[17px] w-[17px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
            {circle.name}
          </span>
          <span className="mt-0.5 block text-[15px] leading-5 text-muted-foreground">
            {circleMemberCountLabel(circle.memberCount)}
            {alreadyAddedCount ? " · " + alreadyAddedCount + " added" : ""}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="border-t border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)] px-3.5 py-3">
          {loading ? (
            <p className="flex items-center gap-2 py-2 text-[15px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading members…
            </p>
          ) : loadError ? (
            <div role="status" className="py-1">
              <p className="text-[15px] text-muted-foreground">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 h-9 rounded-full bg-[color:var(--app-neutral-fill-strong)] px-4 text-[13px] font-semibold text-foreground"
              >
                Try again
              </button>
            </div>
          ) : !allRows.length ? (
            <p className="py-2 text-[15px] text-muted-foreground">
              No one in this Circle is ready for SMS yet.
            </p>
          ) : (
            <>
              <ContactListControls
                sourceCount={allRows.length}
                query={query}
                onQueryChange={setQuery}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                placeholder={"Search " + circle.name}
                resultCount={visibleRows.length}
              />

              {addableIds.length ? (
                <div className="mb-2 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="h-8 rounded-full px-3 text-[13px] font-semibold text-[color:var(--app-accent)]"
                  >
                    {allAddableTicked
                      ? "Clear all"
                      : "Select all " + addableIds.length}
                  </button>
                  <span className="text-[13px] text-muted-foreground">
                    {tickedAddable.length} selected
                  </span>
                </div>
              ) : null}

              <VirtualContactList
                items={visibleRows}
                getKey={(row) => row.userId}
                testId={"circle-members-" + circle.id}
                ariaLabel={circle.name + " members"}
                maxHeightClassName="max-h-[44vh]"
                renderItem={(row) => {
                  const added = selectedUserIds.has(row.userId);
                  const blocked = Boolean(row.blockedReason);
                  const checked = added || ticked.has(row.userId);
                  return (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={row.label}
                      disabled={added || blocked || adding || busy}
                      onClick={() => toggleMember(row.userId)}
                      className={cn(
                        "flex min-h-[58px] w-full items-center gap-3 px-3.5 py-2 text-left",
                        (added || blocked) && "opacity-60",
                      )}
                    >
                      <ContactAvatar label={row.label} />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-start gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[17px] font-normal leading-[22px] text-foreground">
                            {row.label}
                          </span>
                          {row.fromContacts ? (
                            <ContactSourceBadge className="mt-px shrink-0" />
                          ) : null}
                        </span>
                        {row.blockedReason ? (
                          <span className="mt-0.5 block truncate text-[13px] leading-4 text-muted-foreground">
                            {row.blockedReason}
                          </span>
                        ) : added ? (
                          <span className="mt-0.5 block text-[13px] leading-4 text-muted-foreground">
                            Already added
                          </span>
                        ) : null}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2",
                          checked
                            ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)]"
                            : "border-[color:var(--app-separator)]",
                          blocked && "opacity-40",
                        )}
                      >
                        {checked ? (
                          <Check className="h-3.5 w-3.5 text-[color:var(--app-accent-fg)]" />
                        ) : null}
                      </span>
                    </button>
                  );
                }}
              />

              <button
                type="button"
                disabled={!tickedAddable.length || adding || busy}
                onClick={() => void commit()}
                data-testid={"circle-add-selected-" + circle.id}
                className="press-scale mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] text-[15px] font-semibold text-[color:var(--app-accent-fg)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:text-muted-foreground"
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {tickedAddable.length
                  ? "Add " +
                    tickedAddable.length +
                    (tickedAddable.length === 1 ? " person" : " people")
                  : "Select people to add"}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

"use client";

/**
 * Per-share-type controls for a person who holds more than one live share.
 *
 * Replacement of a live location share is scoped to a LANE on the backend --
 * the emergency one (`share_kind === "sos"`, what this UI calls SMS / Save My
 * Soul) and everything else -- so one pair can legitimately hold two live
 * grants at once. Three surfaces list people (Active shares, People, and the
 * recipient's Shared with me) and all three used to equate one grant with one
 * person. These are the pieces they share so they cannot answer "which share
 * is this and how do I end it" three different ways.
 */

import { useCallback, useState } from "react";

import { ChevronDown, Siren } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  grantLaneLabel,
  type OneLocationGrantLaneGroup,
} from "@/lib/one-location/grant-lanes";
import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import type { OneLocationGrant } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

import { ShareCountdownText } from "./live-share-status-card";
import { MUTED_TEXT } from "./tokens";

/**
 * One live share inside a per-person row: what kind it is, when it ends, and
 * its own Stop.
 *
 * Per-share-type rather than per-person, because after the two-lane split the
 * two shares to one person are genuinely different consents with different end
 * times. Stopping the SMS one here revokes exactly the grant the SOS screen's
 * "Stop sharing" would revoke -- same grant id, same `revokeGrant` call -- and
 * leaves the ordinary share running, which is the whole point of #5506.
 */
export function ShareLaneRow({
  grant,
  counterpartName,
  onStop,
  stopping,
  formatEndsAt,
  action = "stop",
}: {
  grant: OneLocationGrant;
  counterpartName: string;
  /** Omitted when there is nothing this side may do about the share. */
  onStop?: () => void;
  stopping?: boolean;
  formatEndsAt?: (value: string) => string;
  /**
   * Whose share this is, in the only way that changes the words.
   *
   * `"stop"` is the owner ending their own share. `"remove"` is the recipient
   * dropping one they were given -- `revoke_grant` accepts either party and
   * records the difference as `owner_revoke` vs `recipient_revoke`, so both are
   * real, and the copy has to say which one the tap is.
   */
  action?: "stop" | "remove";
}) {
  const isSms = isSmsTriggeredGrant(grant);
  const removing = action === "remove";
  return (
    <div
      className="flex min-h-[54px] items-center gap-3 py-1.5"
      data-testid="one-location-share-lane"
      data-share-lane={isSms ? "sos" : "ordinary"}
      data-grant-id={grant.id}
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-medium text-foreground">
          {isSms ? (
            <Siren
              className="h-3.5 w-3.5 shrink-0 text-[color:var(--app-destructive)]"
              aria-hidden="true"
            />
          ) : null}
          {grantLaneLabel(grant)}
        </p>
        <p className={cn(MUTED_TEXT, "truncate text-[13px]")}>
          {grant.durationMode === "until_stopped" ? (
            "Until you stop"
          ) : formatEndsAt && grant.expiresAt ? (
            `Access until ${formatEndsAt(grant.expiresAt)}`
          ) : (
            <ShareCountdownText expiresAt={grant.expiresAt} />
          )}
        </p>
      </div>
      {onStop ? (
        <button
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-2 text-[15px] font-medium leading-[20px] text-[#FF3B30] transition-colors hover:text-[#D70015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          onClick={onStop}
          disabled={stopping}
          aria-label={
            removing
              ? isSms
                ? `Stop viewing the Save My Soul share from ${counterpartName}`
                : `Stop viewing the location share from ${counterpartName}`
              : isSms
                ? `Stop the SMS share with ${counterpartName}`
                : `Stop the location share with ${counterpartName}`
          }
        >
          {stopping ? "Stopping…" : removing ? "Stop viewing" : "Stop"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The disclosure body of a per-person row: every live share with that person.
 *
 * Rendered only when there is more than one, so the ordinary single-share case
 * keeps the one-tap Stop it has always had rather than growing a chevron for a
 * list of one.
 *
 * Every share gets its OWN control, on both sides. The recipient's card carries
 * a single Remove, and with two shares behind one card that button could only
 * ever drop one of them -- silently, since nothing on screen would say which.
 * One control per share is the only honest arrangement once one card can stand
 * for two consents.
 */
export function PersonShareLanes({
  group,
  counterpartName,
  onStopGrant,
  revokingGrantId,
  formatEndsAt,
  action,
}: {
  group: OneLocationGrantLaneGroup;
  counterpartName: string;
  onStopGrant?: (grantId: string) => void;
  revokingGrantId?: string | null;
  formatEndsAt?: (value: string) => string;
  /** See {@link ShareLaneRow}. Defaults to the owner's "stop". */
  action?: "stop" | "remove";
}) {
  return (
    <div className="divide-y divide-[color:var(--app-separator)]">
      {group.grants.map((grant) => (
        <ShareLaneRow
          key={grant.id}
          grant={grant}
          counterpartName={counterpartName}
          formatEndsAt={formatEndsAt}
          action={action}
          onStop={onStopGrant ? () => onStopGrant(grant.id) : undefined}
          stopping={revokingGrantId === grant.id}
        />
      ))}
    </div>
  );
}

/**
 * A chevron toggle that reads as one control.
 *
 * Matches the disclosure treatment `SharedWithMeCard` already uses for its map
 * preview: a real button, `aria-expanded`, `aria-controls`, and a ChevronDown
 * that rotates 180 degrees. Reused rather than re-styled so the two kinds of
 * expandable row on this screen do not diverge.
 */
export function ShareLanesDisclosure({
  expanded,
  onToggle,
  controlsId,
  label,
}: {
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-9 shrink-0 gap-1 rounded-full px-3 text-[15px] font-semibold"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={label}
    >
      Manage
      <ChevronDown
        className={cn(
          "h-4 w-4 transition-transform duration-200",
          expanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </Button>
  );
}

/**
 * Which people have their per-share breakdown open, keyed by PERSON.
 *
 * Keyed by person rather than by grant so the disclosure stays put while the
 * grants underneath are replaced wholesale on every live poll. Shared by the
 * three surfaces that list people -- Active shares, People and Shared with me
 * -- because an owner who expands a row on one of them and finds it collapsed
 * on the next has learned that expanding means nothing.
 */
export function useExpandedShareLanes() {
  const [expandedLaneUserIds, setExpandedLaneUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleLaneExpansion = useCallback((counterpartUserId: string) => {
    setExpandedLaneUserIds((current) => {
      const next = new Set(current);
      if (next.has(counterpartUserId)) next.delete(counterpartUserId);
      else next.add(counterpartUserId);
      return next;
    });
  }, []);
  return { expandedLaneUserIds, toggleLaneExpansion };
}

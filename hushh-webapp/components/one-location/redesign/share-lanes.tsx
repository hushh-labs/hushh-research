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

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ChevronDown, Siren } from "@/components/icons";

import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  grantLaneLabel,
  type OneLocationGrantLaneGroup,
} from "@/lib/one-location/grant-lanes";
import { isSmsTriggeredGrant } from "@/lib/one-location/notifications";
import type { OneLocationGrant } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";
import {
  ACTIVE_SHARE_CHANGE_TIME_CLASSNAME,
  ACTIVE_SHARE_CATEGORY_ROW_CLASSNAME,
  ACTIVE_SHARE_COMPARISON_CELL_CLASSNAME,
  ACTIVE_SHARE_COMPARISON_GRID_CLASSNAME,
  ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME,
  ACTIVE_SHARE_LANE_ROW_CLASSNAME,
  ACTIVE_SHARE_STOP_CLASSNAME,
} from "./active-share-row-layout";

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
  onChangeEndTime,
  formatEndsAt,
  action = "stop",
  layout = "list",
  avatar,
}: {
  grant: OneLocationGrant;
  counterpartName: string;
  /** Omitted when there is nothing this side may do about the share. */
  onStop?: () => void;
  stopping?: boolean;
  onChangeEndTime?: (trigger: HTMLElement) => void;
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
  layout?: "list" | "comparison" | "category";
  avatar?: ReactNode;
}) {
  const isSms = isSmsTriggeredGrant(grant);
  const removing = action === "remove";
  const comparison = layout === "comparison";
  const category = layout === "category";
  const stopLabel = removing
    ? "Stop viewing"
    : comparison || category
      ? isSms ? "Stop SMS" : "Stop"
      : "Stop";
  const changeTimeControl = !isSms && onChangeEndTime ? (
    <Button data-location-type-role="utility-action"
      type="button"
      variant="ghost"
      size="compact"
      className={cn(ACTIVE_SHARE_CHANGE_TIME_CLASSNAME, (comparison || category) && "justify-start px-0")}
      onClick={(event) => onChangeEndTime(event.currentTarget)}
      disabled={stopping}
      data-share-duration-grant-id={grant.id}
      aria-label={`Change end time for ${counterpartName}`}
    >
      {grant.durationMode === "until_stopped" ? "Set end time" : "Change time"}
    </Button>
  ) : null;
  return (
    <div
      className={category ? ACTIVE_SHARE_CATEGORY_ROW_CLASSNAME : comparison ? ACTIVE_SHARE_COMPARISON_CELL_CLASSNAME : ACTIVE_SHARE_LANE_ROW_CLASSNAME}
      data-testid="one-location-share-lane"
      data-share-lane={isSms ? "sos" : "ordinary"}
      data-grant-id={grant.id}
    >
      {category ? <div className="col-start-1 row-start-1 flex items-center">{avatar}</div> : null}
      <div className={cn("min-w-0 flex-1", comparison && "flex flex-wrap items-center justify-between gap-x-2", category && (isSms ? "col-start-2 row-start-1" : "col-start-2 col-span-2 row-start-1"))}>
        <p data-location-type-role="row-title" className={cn(
          TYPOGRAPHY_CLASSNAMES.rowLabel,
          "flex min-w-0 items-center gap-1.5 text-foreground",
          comparison && "@min-[46rem]:sr-only",
          (comparison || category) && "ui-text-row-label-compact",
          comparison && isSms && "text-[color:var(--app-destructive)]",
        )}>
          {isSms && !category ? (
            <Siren
              className="h-3.5 w-3.5 shrink-0 text-[color:var(--app-destructive)]"
              aria-hidden="true"
            />
          ) : null}
          {category ? counterpartName : comparison && isSms ? "SMS" : grantLaneLabel(grant)}
        </p>
        <p data-location-type-role="row-description" className={cn(TYPOGRAPHY_CLASSNAMES.rowDescription, MUTED_TEXT, "[overflow-wrap:anywhere]", (comparison || category) && "ui-text-row-description-compact")}>
          {grant.durationMode === "until_stopped" ? (
            "Until you stop"
          ) : formatEndsAt && grant.expiresAt ? (
            `Access until ${formatEndsAt(grant.expiresAt)}`
          ) : (
            <ShareCountdownText expiresAt={grant.expiresAt} />
          )}
        </p>
        {comparison ? changeTimeControl : null}
      </div>
      <div className={category ? cn("flex min-w-0 items-center", isSms ? "col-start-3 row-start-1 justify-end" : "col-start-2 col-span-2 row-start-2 flex-wrap justify-between gap-x-2 gap-y-1") : comparison ? "flex shrink-0 items-center justify-end" : ACTIVE_SHARE_LANE_ACTIONS_CLASSNAME}>
        {!comparison ? changeTimeControl : null}
        {onStop ? (
        <Button data-location-type-role="utility-action"
          type="button"
          variant="ghost"
          size="compact"
          className={cn(ACTIVE_SHARE_STOP_CLASSNAME, category && "sm:ml-auto")}
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
          {stopping ? "Stopping…" : stopLabel}
        </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Manage sharing keeps identity separate from each independently revocable share. */
export function ActiveShareComparison({
  groups,
  recipientName,
  renderAvatar,
  onStopGrant,
  revokingGrantId,
  onChangeEndTime,
}: {
  groups: OneLocationGrantLaneGroup[];
  recipientName: (grant: OneLocationGrant) => string;
  renderAvatar: (group: OneLocationGrantLaneGroup, name: string) => ReactNode;
  onStopGrant: (grantId: string) => void;
  revokingGrantId: string | null;
  onChangeEndTime: (grantId: string, trigger: HTMLElement) => void;
}) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const [narrowContainer, setNarrowContainer] = useState(false);
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    // Follow the comparison's 46rem container breakpoint, including tablet
    // gutters and larger text, without mounting a second set of live controls.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrowContainer(entry.contentRect.width < 46 * rem);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  if (isMobile || narrowContainer) {
    return (
      <div ref={containerRef} className="space-y-6" data-testid="one-location-share-comparison" data-share-layout="categories">
        {(["ordinaryGrant", "smsGrant"] as const).map((channel) => {
          const channelGroups = groups.filter((group) => group[channel]);
          if (!channelGroups.length) return null;
          const isSms = channel === "smsGrant";
          return (
            <SettingsGroup
              key={channel}
              testId={isSms ? "one-location-sms-shares" : "one-location-ordinary-shares"}
              title={isSms ? <span className="text-[color:var(--app-destructive)]">SMS</span> : "Location shares"}
              titleAction={<span className={cn(TYPOGRAPHY_CLASSNAMES.rowDescription, MUTED_TEXT)}>{channelGroups.length}</span>}
              headingClassName="mt-0"
              density="compact"
              separatorInset
            >
              {channelGroups.flatMap((group) => group.grants
                .filter((grant) => isSmsTriggeredGrant(grant) === isSms)
                .map((grant) => {
                  const name = recipientName(grant);
                  return <SettingsRow key={grant.id} title={
                  <ShareLaneRow
                    grant={grant}
                    layout="category"
                    avatar={renderAvatar(group, name)}
                    counterpartName={name}
                    stopping={revokingGrantId === grant.id}
                    onStop={() => onStopGrant(grant.id)}
                    onChangeEndTime={!isSms ? (trigger) => onChangeEndTime(grant.id, trigger) : undefined}
                  />
                } />;
                }))}
            </SettingsGroup>
          );
        })}
      </div>
    );
  }
  return (
    <div ref={containerRef} className="@container" data-testid="one-location-share-comparison" data-share-layout="comparison">
      <div aria-hidden="true" className={cn(
        ACTIVE_SHARE_COMPARISON_GRID_CLASSNAME,
        TYPOGRAPHY_CLASSNAMES.rowDescription,
        "mb-2 hidden px-4 text-[color:var(--app-secondary-label)] @min-[46rem]:grid",
      )}>
        <span>Person</span><span>Location share</span><span className="text-[color:var(--app-destructive)]">SMS</span>
      </div>
      <SettingsGroup separatorInset density="compact">
        {groups.map((group) => {
          const name = recipientName(group.primaryGrant);
          return (
            <SettingsRow key={group.counterpartUserId} className="[--settings-row-py:8px]" title={
              <div className={ACTIVE_SHARE_COMPARISON_GRID_CLASSNAME}>
                <div className="flex min-w-0 items-center gap-3">
                  {renderAvatar(group, name)}
                  <span data-location-type-role="row-title" className={cn(TYPOGRAPHY_CLASSNAMES.rowLabel, "ui-text-row-label-compact min-w-0 [overflow-wrap:anywhere]")}>{name}</span>
                </div>
                {[false, true].map((isSms) => {
                  const grants = group.grants.filter((grant) => isSmsTriggeredGrant(grant) === isSms);
                  return grants.length ? (
                    <div key={String(isSms)} className="min-w-0 space-y-1">
                      {grants.map((grant) => <ShareLaneRow
                        key={grant.id}
                        grant={grant}
                        layout="comparison"
                        counterpartName={name}
                        stopping={revokingGrantId === grant.id}
                        onStop={() => onStopGrant(grant.id)}
                        onChangeEndTime={!isSms ? (trigger) => onChangeEndTime(grant.id, trigger) : undefined}
                      />)}
                    </div>
                  ) : (
                  <span key={String(isSms)} className={cn(TYPOGRAPHY_CLASSNAMES.rowDescription, "hidden text-[color:var(--app-secondary-label)] @min-[46rem]:block")}>
                    <span aria-hidden="true">—</span><span className="sr-only">No active share</span>
                  </span>
                  );
                })}
              </div>
            } />
          );
        })}
      </SettingsGroup>
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
  onChangeEndTime,
  formatEndsAt,
  action,
}: {
  group: OneLocationGrantLaneGroup;
  counterpartName: string;
  onStopGrant?: (grantId: string) => void;
  revokingGrantId?: string | null;
  onChangeEndTime?: (grantId: string, trigger: HTMLElement) => void;
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
          onChangeEndTime={
            action !== "remove" && !isSmsTriggeredGrant(grant) && onChangeEndTime
              ? (trigger) => onChangeEndTime(grant.id, trigger)
              : undefined
          }
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
    <Button data-location-type-role="utility-action"
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
          "h-4 w-4 transition-transform duration-150",
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

"use client";

/**
 * LiveShareStatusCard — the running clock at the top of the Location screen.
 *
 * Choosing "1 hour" is a promise the product makes to the person sharing, and
 * the screen has to keep showing that promise being kept. Before this card, the
 * Now screen reported "Active shares: 1" and nothing else: no time left, no
 * moving number, and nothing at all during the second or two after re-entering
 * the route while the server state reloaded. This card paints from the durable
 * local record on the first frame and counts down every second until the share
 * ends.
 *
 * PRESENTATION ONLY. The window comes from the page; stopping delegates to the
 * page's existing revoke handler.
 */

import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { OneLocationShareTimeSummary } from "@/lib/one-location/grant-lanes";
import {
  describeShareElapsed,
  describeShareRemaining,
  formatShareDuration,
  formatShareEndsAt,
  parseTimestamp,
} from "@/lib/one-location/share-countdown";
import { useShareClock } from "@/lib/one-location/use-share-clock";
import {
  LIVE_SHARE_ACTION_CLASSNAME,
  LIVE_SHARE_CARD_CLASSNAME,
  LIVE_SHARE_CLOCK_CLASSNAME,
  LIVE_SHARE_CLOCK_ROW_CLASSNAME,
  LIVE_SHARE_FOOTER_CLASSNAME,
  LIVE_SHARE_FOOTER_ROW_CLASSNAME,
  LIVE_SHARE_HEADER_CLASSNAME,
  LIVE_SHARE_PROGRESS_FILL_CLASSNAME,
  LIVE_SHARE_PROGRESS_TRACK_CLASSNAME,
  LIVE_SHARE_TITLE_CLASSNAME,
} from "./live-share-card-layout";
import { CARD_SURFACE } from "./tokens";

export type LiveShareStatus = {
  /** How many of your shares are live right now. */
  count: number;
  /** Raw grant count. Can be higher than the person count. */
  grantCount: number;
  /**
   * Display labels for the people who can see you. Empty while the server state
   * is still loading — the count still renders, names are never persisted.
   */
  names: string[];
  people?: Array<{
    displayName: string;
    photoUrl?: string | null;
  }>;
  startedAt: string;
  /** `null` when a share runs until you stop it. */
  endsAt: string | null;
  timeSummary?: OneLocationShareTimeSummary | null;
  singleGrantIsSms?: boolean;
  /** Set only when exactly one share is live, so one tap can end it. */
  stoppableGrantId: string | null;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * One share's remaining time, ticking — for the per-person rows on the Active
 * shares screen. Same clock as the hero card so the two never disagree.
 */
export function ShareCountdownText({
  expiresAt,
  className,
}: {
  expiresAt: string | null | undefined;
  className?: string;
}) {
  const endsAtMs = parseTimestamp(expiresAt ?? null);
  const rough = endsAtMs === null ? 0 : endsAtMs - Date.now();
  const nowMs = useShareClock(
    endsAtMs !== null,
    rough > HOUR_MS ? 15_000 : 1_000,
  );

  if (endsAtMs === null) return <span className={className}>Active</span>;
  const remainingMs = endsAtMs - nowMs;
  if (remainingMs <= 0) return <span className={className}>Stopping now</span>;

  return (
    <span className={className}>
      <span aria-hidden="true" className="tabular-nums">
        {formatShareDuration(remainingMs)} left
      </span>
      <span className="sr-only">{describeShareRemaining(remainingMs)}</span>
    </span>
  );
}

/** "Sharing with Rohan" / "Sharing with 3 people" — never a bare number. */
export function liveShareTitle(status: LiveShareStatus): string {
  const [only] = status.names;
  if (status.names.length === 1 && only) return `Sharing with ${only}`;
  const count = Math.max(status.names.length, status.count, 1);
  if (count === 1) return "Sharing with 1 person";
  return `Sharing with ${count} people`;
}

function initialsForName(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "1"
  );
}

function LiveShareIdentity({ status }: { status: LiveShareStatus }) {
  const people =
    status.people?.length
      ? status.people
      : status.names
          .filter(Boolean)
          .map((displayName) => ({ displayName, photoUrl: null }));
  const names = people.map((person) => person.displayName).filter(Boolean);
  if (status.count > 1 || people.length > 1) {
    const visiblePeople = people.slice(0, 3);
    const fallbackCount = Math.min(status.count, 3);
    const slots = visiblePeople.length
      ? visiblePeople
      : Array.from({ length: fallbackCount }, (_, index) => ({
          displayName: `${index + 1}`,
          photoUrl: null,
        }));
    const remaining = Math.max(status.count - slots.length, 0);
    return (
      <span aria-hidden="true" className="flex h-10 w-14 shrink-0 items-center">
        {slots.map((person, index) => (
          <span
            key={`${person.displayName}-${index}`}
            className="-ml-2 first:ml-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[12px] font-semibold text-[color:var(--app-secondary-label)] ring-2 ring-[color:var(--app-primary-surface)]"
          >
            {person.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={person.photoUrl}
                alt=""
                className="h-full w-full rounded-full object-cover"
              />
            ) : (
              initialsForName(person.displayName)
            )}
          </span>
        ))}
        {remaining > 0 ? (
          <span className="-ml-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[11px] font-semibold text-[color:var(--app-secondary-label)] ring-2 ring-[color:var(--app-primary-surface)]">
            +{remaining}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-secondary-surface)] text-[13px] font-semibold text-[color:var(--app-secondary-label)] ring-1 ring-inset ring-[color:var(--app-separator)]"
    >
      {people[0]?.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={people[0].photoUrl}
          alt=""
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        initialsForName(names[0] ?? "1")
      )}
    </span>
  );
}

function liveShareTimeSummary(status: LiveShareStatus): string | null {
  if (status.grantCount === 1) return null;
  if (status.count === 1) {
    return `${status.grantCount} active shares`;
  }
  if (status.timeSummary?.kind === "same_timed") {
    const endsAtMs = parseTimestamp(status.timeSummary.endsAt);
    return endsAtMs === null ? "Different end times" : `All end at ${formatShareEndsAt(endsAtMs)}`;
  }
  if (status.timeSummary?.kind === "all_open_ended") return "Until you stop";
  return "Different end times";
}

export function LiveShareStatusCard({
  status,
  onManage,
  onStop,
  stopBusy,
  onChangeDuration,
  onShareMore,
  onEnded,
}: {
  status: LiveShareStatus;
  /** Opens the Active shares screen. */
  onManage: () => void;
  /** Ends the single live share. Omitted when more than one is running. */
  onStop?: () => void;
  stopBusy?: boolean;
  /**
   * Opens the editor for a new end time. Same single-share gate as `onStop`:
   * with several running there is no one share to change.
   *
   * Stop used to be the only thing this card offered. Choosing 30 minutes and
   * then wanting 45 meant ending the share and starting it again, which is a
   * different share to the person watching.
   */
  onChangeDuration?: (trigger: HTMLButtonElement) => void;
  /** Opens the existing share composer while a share is already live. */
  onShareMore?: () => void;
  /** Fired once when the countdown reaches zero, so the page can reconcile. */
  onEnded?: () => void;
}) {
  const startedAtMs = parseTimestamp(status.startedAt);
  const endsAtMs = parseTimestamp(status.endsAt);
  const openEnded = endsAtMs === null;
  const singleGrant = status.grantCount === 1 && Boolean(status.stoppableGrantId);
  const canChangeDuration =
    singleGrant && !status.singleGrantIsSms && Boolean(onChangeDuration);

  // Seconds only matter inside the last hour. Above that they are noise, and a
  // once-a-second re-render for a 24-hour share is waste.
  const rough = endsAtMs !== null ? endsAtMs - Date.now() : 0;
  const nowMs = useShareClock(
    true,
    !openEnded && rough > HOUR_MS ? 15_000 : 1_000,
  );

  const remainingMs = endsAtMs === null ? null : endsAtMs - nowMs;
  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  const ended = remainingMs !== null && remainingMs <= 0;
  const progress =
    startedAtMs !== null && endsAtMs !== null && endsAtMs > startedAtMs
      ? Math.min(
          1,
          Math.max(0, (nowMs - startedAtMs) / (endsAtMs - startedAtMs)),
        )
      : null;

  // Fires once per share window. The page reconciles against the server from
  // here, so a share that runs out while the screen is open clears itself
  // instead of sitting at "00:00".
  const endedRef = useRef(false);
  useEffect(() => {
    if (!ended) {
      endedRef.current = false;
      return;
    }
    if (endedRef.current) return;
    endedRef.current = true;
    onEnded?.();
  }, [ended, onEnded]);

  const clock = openEnded
    ? formatShareDuration(elapsedMs)
    : formatShareDuration(Math.max(0, remainingMs ?? 0));
  const spoken = openEnded
    ? describeShareElapsed(elapsedMs)
    : describeShareRemaining(remainingMs ?? 0);

  const title = liveShareTitle(status);
  /*
   * `endsAt` is the LATEST end across every running share (see
   * summarizeLiveShareEntries), which is the right number for one card: listing
   * ten end times on the hub would be a crowd, and the last one is the moment
   * after which nobody can see you.
   *
   * But "Ends 10:38 AM" over "Sharing with 2 people" reads as ONE window when
   * the first of those two shares may stop in 29 minutes. One word fixes it,
   * and only when there is more than one share to be last of.
   */
  const foldedSummary = liveShareTimeSummary(status);
  const footer =
    foldedSummary ??
    (openEnded
      ? "Until you stop"
      : endsAtMs !== null
        ? `Ends ${formatShareEndsAt(endsAtMs)}`
        : null);
  const showClock = singleGrant;

  const runChildAction =
    (action?: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action?.();
    };
  const cardManageEnabled = !singleGrant;
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!cardManageEnabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onManage();
  };
  return (
    <section
      aria-label="Your live location share"
      data-testid="one-location-live-share"
      data-ui-contract="control-group"
      data-ui-id="location-live-share"
      role={cardManageEnabled ? "button" : undefined}
      tabIndex={cardManageEnabled ? 0 : undefined}
      onClick={cardManageEnabled ? onManage : undefined}
      onKeyDown={handleCardKeyDown}
      className={cn(CARD_SURFACE, LIVE_SHARE_CARD_CLASSNAME)}
    >
      <div className={LIVE_SHARE_HEADER_CLASSNAME}>
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
          />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-emerald-700 dark:text-emerald-300">
            Sharing
          </span>
        </span>

        {singleGrant && onStop ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={runChildAction(onStop)}
            disabled={stopBusy}
            className={cn(
              LIVE_SHARE_ACTION_CLASSNAME,
              "text-destructive hover:text-destructive",
            )}
            data-ui-contract="occlusion-sensitive"
            data-ui-role="control"
            data-ui-id="location-live-share-stop"
          >
            {stopBusy ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : null}
            Stop sharing
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={runChildAction(onManage)}
            className={cn(
              LIVE_SHARE_ACTION_CLASSNAME,
              "text-[color:var(--app-accent)]",
            )}
            data-ui-contract="occlusion-sensitive"
            data-ui-role="control"
            data-ui-id="location-live-share-manage"
          >
            Manage sharing
          </Button>
        )}
      </div>

      <div className="mt-3 flex items-start gap-3">
        <LiveShareIdentity status={status} />
        <div className="min-w-0 flex-1">
          <p
            data-ui-contract="required-copy"
            data-ui-id="location-live-share-title"
            data-ui-truncation="forbid"
            data-ui-role="label"
            className={LIVE_SHARE_TITLE_CLASSNAME}
          >
            {title}
          </p>

          <p className={LIVE_SHARE_CLOCK_ROW_CLASSNAME}>
            {showClock ? (
              <>
                <span
                  // The visible clock changes every second; a live region here would
                  // announce it every second too. The sentence below carries the value
                  // for assistive tech instead, at a pace a person can follow.
                  aria-hidden="true"
                  data-ui-contract="required-copy"
                  data-ui-id="location-live-share-countdown"
                  data-ui-truncation="forbid"
                  data-testid="one-location-live-share-countdown"
                  className={LIVE_SHARE_CLOCK_CLASSNAME}
                >
                  {clock}
                </span>
                <span aria-hidden="true" className="shrink-0">
                  {openEnded ? "so far" : "left"}
                </span>
              </>
            ) : null}
            {footer ? (
              <>
                {showClock ? (
                  <span
                    aria-hidden="true"
                    className="text-[color:var(--app-tertiary-label)]"
                  >
                    ·
                  </span>
                ) : null}
                <span
                  data-ui-contract="required-copy"
                  data-ui-id="location-live-share-ends"
                  data-ui-truncation="forbid"
                  data-ui-role="description"
                  className={LIVE_SHARE_FOOTER_CLASSNAME}
                >
                  {footer}
                </span>
              </>
            ) : null}
            {showClock ? <span className="sr-only">{spoken}</span> : null}
          </p>
        </div>
      </div>

      {singleGrant && progress !== null ? (
        <div aria-hidden="true" className={LIVE_SHARE_PROGRESS_TRACK_CLASSNAME}>
          <div
            data-testid="one-location-live-share-progress"
            className={LIVE_SHARE_PROGRESS_FILL_CLASSNAME}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      ) : null}

      {onShareMore ? (
        <Button
          type="button"
          onClick={runChildAction(onShareMore)}
          className="mt-4 min-h-[48px] w-full rounded-[14px] bg-[color:var(--app-secondary-surface)] px-5 font-[family-name:var(--font-app-body)] text-[16px] font-semibold leading-[22px] tracking-normal text-[color:var(--app-primary-label)] ring-1 ring-inset ring-[color:var(--app-separator)] transition-[background-color,transform] hover:bg-[color:var(--app-neutral-fill)] active:scale-[0.99]"
          data-ui-contract="occlusion-sensitive"
          data-ui-role="control"
          data-ui-id="location-live-share-more"
          data-testid="one-location-live-share-more"
        >
          Share with more
        </Button>
      ) : null}

      {canChangeDuration ? (
        <div className={LIVE_SHARE_FOOTER_ROW_CLASSNAME}>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onChangeDuration?.(event.currentTarget);
            }}
            className={cn(
              LIVE_SHARE_ACTION_CLASSNAME,
              "mx-auto text-[color:var(--app-accent)]",
            )}
            data-ui-contract="occlusion-sensitive"
            data-ui-role="control"
            data-ui-id="location-live-share-duration"
            data-testid="one-location-live-share-change-time"
          >
            {openEnded ? "Set end time" : "Change time"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

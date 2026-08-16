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

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  describeShareElapsed,
  describeShareRemaining,
  formatShareDuration,
  formatShareEndsAt,
  parseTimestamp,
  shareProgressRatio,
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
import { CARD_SURFACE, MUTED_TEXT } from "./tokens";

export type LiveShareStatus = {
  /** How many of your shares are live right now. */
  count: number;
  /**
   * Display labels for the people who can see you. Empty while the server state
   * is still loading — the count still renders, names are never persisted.
   */
  names: string[];
  startedAt: string;
  /** `null` when a share runs until you stop it. */
  endsAt: string | null;
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
  const nowMs = useShareClock(endsAtMs !== null, rough > HOUR_MS ? 15_000 : 1_000);

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

export function LiveShareStatusCard({
  status,
  onManage,
  onStop,
  stopBusy,
  onChangeDuration,
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
  onChangeDuration?: () => void;
  /** Fired once when the countdown reaches zero, so the page can reconcile. */
  onEnded?: () => void;
}) {
  const startedAtMs = parseTimestamp(status.startedAt);
  const endsAtMs = parseTimestamp(status.endsAt);
  const openEnded = endsAtMs === null;

  // Seconds only matter inside the last hour. Above that they are noise, and a
  // once-a-second re-render for a 24-hour share is waste.
  const rough = endsAtMs !== null ? endsAtMs - Date.now() : 0;
  const nowMs = useShareClock(true, !openEnded && rough > HOUR_MS ? 15_000 : 1_000);

  const remainingMs = endsAtMs === null ? null : endsAtMs - nowMs;
  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
  const ended = remainingMs !== null && remainingMs <= 0;

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

  const progress = shareProgressRatio(startedAtMs, endsAtMs, nowMs);
  const clock = openEnded
    ? formatShareDuration(elapsedMs)
    : formatShareDuration(Math.max(0, remainingMs ?? 0));
  const spoken = openEnded
    ? describeShareElapsed(elapsedMs)
    : describeShareRemaining(remainingMs ?? 0);

  const title = liveShareTitle(status);
  const footer = openEnded
    ? "Until you stop"
    : endsAtMs !== null
      ? `Ends ${formatShareEndsAt(endsAtMs)}`
      : null;

  return (
    <section
      aria-label="Your live location share"
      data-testid="one-location-live-share"
      data-ui-contract="control-group"
      data-ui-id="location-live-share"
      className={cn(CARD_SURFACE, LIVE_SHARE_CARD_CLASSNAME)}
    >
      <div className={LIVE_SHARE_HEADER_CLASSNAME}>
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
          />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-emerald-700 dark:text-emerald-300">
            Live
          </span>
        </span>

        {onStop ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onStop}
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
            Stop
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onManage}
            className={cn(
              LIVE_SHARE_ACTION_CLASSNAME,
              "text-[color:var(--app-accent)]",
            )}
            data-ui-contract="occlusion-sensitive"
            data-ui-role="control"
            data-ui-id="location-live-share-manage"
          >
            Manage
          </Button>
        )}
      </div>

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
        <span aria-hidden="true" className={cn(MUTED_TEXT, "shrink-0")}>
          {openEnded ? "so far" : "left"}
        </span>
        <span className="sr-only">{spoken}</span>
      </p>

      {progress !== null ? (
        <div
          aria-hidden="true"
          className={LIVE_SHARE_PROGRESS_TRACK_CLASSNAME}
        >
          <div
            data-testid="one-location-live-share-progress"
            className={LIVE_SHARE_PROGRESS_FILL_CLASSNAME}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      ) : null}

      {footer || onChangeDuration ? (
        <div className={LIVE_SHARE_FOOTER_ROW_CLASSNAME}>
          {footer ? (
            <p
              data-ui-contract="required-copy"
              data-ui-id="location-live-share-ends"
              data-ui-truncation="forbid"
              data-ui-role="description"
              className={cn(MUTED_TEXT, LIVE_SHARE_FOOTER_CLASSNAME)}
            >
              {footer}
            </p>
          ) : null}

          {onChangeDuration ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onChangeDuration}
              className={cn(
                LIVE_SHARE_ACTION_CLASSNAME,
                "text-[color:var(--app-accent)]",
              )}
              data-ui-contract="occlusion-sensitive"
              data-ui-role="control"
              data-ui-id="location-live-share-duration"
              data-testid="one-location-live-share-change-time"
            >
              Change time
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

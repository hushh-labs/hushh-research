"use client";

import { useEffect, useRef } from "react";

import {
  FEED_STATE_CHANGED_EVENT,
  feedStateChangeReason,
} from "@/lib/feed/feed-events";

/**
 * How often a Feed surface re-checks the server while the user is looking at it.
 *
 * One constant for every Feed surface on purpose. The unread badge used to own a
 * private 45s poll while the Feed list itself refreshed only when it mounted, so
 * the badge could say "4 new" over a list that had not asked the server anything
 * since the app opened — the tab and the page disagreeing about the same facts.
 */
export const FEED_LIVE_POLL_INTERVAL_MS = 45_000;

/**
 * Runs `refresh` whenever the Feed's data could have changed:
 *
 * - on a timer, while the tab is actually being looked at;
 * - the moment the tab is looked at again (`visibilitychange` / `focus`), which
 *   is when a phone comes back from the lock screen or another app;
 * - on `FEED_STATE_CHANGED`, but only when something was actually acted on.
 *   Marking rows read also fires that event, and re-fetching a list in response
 *   to having just read it is a request that can only return what is already on
 *   screen.
 *
 * The timer is stopped while the tab is hidden. A backgrounded tab polling every
 * 45 seconds spends battery and mobile data redrawing something nobody is
 * reading; returning to the foreground refreshes immediately anyway, so nothing
 * is lost by going quiet.
 *
 * `refresh` is read through a ref, so a caller may pass an inline closure without
 * tearing down and rebuilding the listeners on every render.
 */
export function useFeedLiveRefresh(
  refresh: () => void,
  enabled: boolean = true,
): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const run = () => refreshRef.current();

    let timer: number | null = null;
    const startPolling = () => {
      if (timer !== null) return;
      timer = window.setInterval(run, FEED_LIVE_POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        run();
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") startPolling();

    document.addEventListener("visibilitychange", onVisibilityChange);
    // iOS webviews do not always pair `focus` with a `visibilitychange`, so both
    // are listened for. A duplicate refresh is harmless: `useStaleResource`
    // de-dupes concurrent loads of the same cache key onto one request.
    window.addEventListener("focus", run);

    const onFeedStateChanged = (event: Event) => {
      if (feedStateChangeReason(event) === "read") return;
      run();
    };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onFeedStateChanged);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", run);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, onFeedStateChanged);
    };
  }, [enabled]);
}

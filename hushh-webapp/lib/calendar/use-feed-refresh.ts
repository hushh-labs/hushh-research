import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { FEED_STATE_CHANGED_EVENT, feedStateChangeReason } from "@/lib/feed/feed-events";

// Minimum spacing between Feed-triggered refreshes; a burst yields one trailing refresh.
const FEED_REFRESH_SPACING_MS = 5_000;

/**
 * Refresh when the Feed changes (files were shared, a request was answered).
 * Events can arrive in bursts, and the one that matters may be the last, so an
 * event inside the spacing window is deferred to one trailing refresh rather
 * than dropped.
 */
export function useFeedRefresh(refresh: () => void, view: RefObject<string>, budget: MutableRefObject<number>) {
  const lastRun = useRef(0);
  useEffect(() => {
    let trailing: number | null = null;
    const run = () => {
      lastRun.current = Date.now();
      budget.current = 5;
      refresh();
    };
    const onFeed = (event: Event) => {
      if (feedStateChangeReason(event) === "read" || view.current === "overview") return;
      const wait = FEED_REFRESH_SPACING_MS - (Date.now() - lastRun.current);
      if (wait <= 0) { run(); return; }
      if (trailing !== null) return;
      trailing = window.setTimeout(() => {
        trailing = null;
        if (view.current !== "overview") run();
      }, wait);
    };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
    return () => {
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, onFeed);
      if (trailing !== null) window.clearTimeout(trailing);
    };
  }, [refresh, view, budget]);
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { FEED_STATE_CHANGED_EVENT } from "@/lib/feed/feed-events";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { FeedService } from "@/lib/services/feed-service";

/**
 * Returns `null` until the count has resolved. Consumers must treat that as
 * unknown, never as zero: zero is a meaningful statement that Feed has no
 * unread items.
 */
export function useFeedUnreadCount(): number | null {
  const { user } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(
    async (force = false) => {
      if (!user?.uid) return;
      try {
        const idToken = await user.getIdToken();
        const next = await FeedService.unreadCount({
          idToken,
          userId: user.uid,
          force,
        });
        if (!cancelledRef.current) setCount(next);
      } catch {
        // Unread count is presentation-only; a transient failure just keeps
        // the last known value instead of surfacing an error state.
      }
    },
    [user],
  );

  useEffect(() => {
    cancelledRef.current = false;
    if (!user?.uid) {
      setCount(null);
      return;
    }
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [user, load]);

  // Shares the Feed's live signal rather than keeping a private timer, so the
  // badge and the Feed list re-check on the same tick and cannot drift into
  // saying different things about the same unread rows.
  useFeedLiveRefresh(
    useCallback(() => void load(true), [load]),
    Boolean(user?.uid),
  );

  // The badge additionally recounts on a read-only change — that shared signal
  // skips those, precisely so a list does not re-fetch rows it just marked read.
  // For the badge it is the whole point: it is the number that has to drop.
  useEffect(() => {
    if (!user?.uid) return;
    const recount = () => void load(true);
    window.addEventListener(FEED_STATE_CHANGED_EVENT, recount);
    return () => window.removeEventListener(FEED_STATE_CHANGED_EVENT, recount);
  }, [user?.uid, load]);

  return count;
}

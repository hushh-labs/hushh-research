"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { FEED_STATE_CHANGED_EVENT } from "@/lib/feed/feed-events";
import { FeedService } from "@/lib/services/feed-service";

const POLL_INTERVAL_MS = 45_000;

/**
 * Returns `null` until the count has resolved. Consumers must treat that as
 * unknown, never as zero: zero is a meaningful statement that Feed has no
 * unread items.
 */
export function useFeedUnreadCount(): number | null {
  const { user } = useAuth();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!user?.uid) {
      setCount(null);
      return;
    }
    let cancelled = false;

    const load = async (force = false) => {
      try {
        const idToken = await user.getIdToken();
        const next = await FeedService.unreadCount({
          idToken,
          userId: user.uid,
          force,
        });
        if (!cancelled) setCount(next);
      } catch {
        // Unread count is presentation-only; a transient failure just keeps
        // the last known value instead of surfacing an error state.
      }
    };

    void load();
    const interval = setInterval(() => void load(true), POLL_INTERVAL_MS);
    const handleStateChanged = () => void load(true);
    window.addEventListener(FEED_STATE_CHANGED_EVENT, handleStateChanged);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, handleStateChanged);
    };
  }, [user]);

  return count;
}

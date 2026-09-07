"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  FEED_STATE_CHANGED_EVENT,
  feedStateChangeReason,
} from "@/lib/feed/feed-events";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { FeedService } from "@/lib/services/feed-service";

/**
 * Returns `null` until the count has resolved. Consumers must treat that as
 * unknown, never as zero: zero is a meaningful statement that Feed has no
 * unread items.
 */
export function useFeedUnreadCount(options?: { enabled?: boolean }): number | null {
  const { user } = useAuth();
  const currentUserId = user?.uid ?? null;
  // Object identity distinguishes separate sessions even when an A -> B -> A
  // account cycle returns to the same uid. State from the first A session is
  // never considered current for the second.
  const session = useMemo(() => ({ userId: currentUserId }), [currentUserId]);
  // Same reason as the consent badge: a hidden badge that still fetches spends a
  // connection from a pool of four while a first-run person waits on the gate.
  const enabled = options?.enabled ?? true;
  const [countState, setCountState] = useState<{
    session: typeof session;
    count: number | null;
  }>({ session, count: null });
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<{
    session: typeof session;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    (force = false): Promise<void> => {
      if (!user?.uid) return Promise.resolve();
      const existing = inFlightRef.current;
      if (existing?.session === session) return existing.promise;

      const requestedUserId = user.uid;
      const requestId = ++requestSequenceRef.current;
      const isLatestRequest = () => requestSequenceRef.current === requestId;
      const promise = (async () => {
        try {
          const idToken = await user.getIdToken();
          if (!isLatestRequest()) return;
          const next = await FeedService.unreadCount({
            idToken,
            userId: requestedUserId,
            force,
          });
          if (mountedRef.current && isLatestRequest()) {
            setCountState((current) =>
              current.session === session ? { session, count: next } : current,
            );
          }
        } catch {
          // Unread count is presentation-only; a transient failure just keeps
          // the last known value instead of surfacing an error state.
        }
      })();
      const request = { session, promise };
      inFlightRef.current = request;
      void promise.finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
      return promise;
    },
    [session, user],
  );

  useEffect(() => {
    requestSequenceRef.current += 1;
    inFlightRef.current = null;
    setCountState({ session, count: null });
    // A hidden badge does not fetch: the reset above already cleared the count,
    // so a disabled consumer simply reads null without spending a connection.
    if (!user?.uid || !enabled) {
      return;
    }
    void load();
  }, [user, load, session, enabled]);

  // Shares the Feed's live signal rather than keeping a private timer, so the
  // badge and the Feed list re-check on the same tick and cannot drift into
  // saying different things about the same unread rows.
  useFeedLiveRefresh(
    useCallback(() => void load(true), [load]),
    Boolean(user?.uid) && enabled,
  );

  // The badge additionally recounts on a read-only change — that shared signal
  // skips those, precisely so a list does not re-fetch rows it just marked read.
  // For the badge it is the whole point: it is the number that has to drop.
  useEffect(() => {
    if (!user?.uid) return;
    const recount = (event: Event) => {
      const reason = feedStateChangeReason(event);
      if (reason === "read") {
        const cached = CacheService.getInstance().get<number>(
          CACHE_KEYS.FEED_UNREAD_COUNT(user.uid),
        );
        if (cached != null) {
          // An optimistic read count is newer than any outstanding recount.
          // Retire those requests so a late pre-read response cannot restore
          // the badge the user just cleared by opening Feed.
          requestSequenceRef.current += 1;
          if (inFlightRef.current?.session === session) {
            inFlightRef.current = null;
          }
          setCountState((current) =>
            current.session === session ? { session, count: cached } : current,
          );
          return;
        }
      }
      void load(true);
    };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, recount);
    return () => window.removeEventListener(FEED_STATE_CHANGED_EVENT, recount);
  }, [user?.uid, load, session]);

  return countState.session === session ? countState.count : null;
}

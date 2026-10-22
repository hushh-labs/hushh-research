"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { subscribeToDirectMessagesUpdated } from "@/lib/direct-messages/direct-message-events";
import { FEED_STATE_CHANGED_EVENT } from "@/lib/feed/feed-events";
import { FEED_LIVE_POLL_INTERVAL_MS } from "@/lib/feed/use-feed-live-refresh";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { markPeriodicTaskRan, registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";

type MessageCountUser = { uid: string; getIdToken: () => Promise<string> };

/** Server unread messages, independent of setup status or inbox pagination. */
export function useDirectMessagesUnreadCount(user: MessageCountUser | null): number | null {
  // A new session also fences an A -> B -> A account cycle using the same user object.
  const session = useMemo(() => ({ user }), [user]);
  const [snapshot, setSnapshot] = useState<{ session: typeof session; count: number } | null>(null);
  const taskId = `messages-unread:${useId()}`;

  useEffect(() => {
    if (!user) return;
    let active = true;
    let inFlight = false;
    let queued = false;
    let revision = 0;

    const refresh = async () => {
      const requestedRevision = ++revision;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const idToken = await user.getIdToken();
        if (!active) return;
        const count = await DirectMessagesService.unreadCount({ idToken });
        if (active && requestedRevision === revision) {
          setSnapshot({ session, count });
        }
      } catch {
        // Keep the last verified count; an unavailable inbox is not empty.
      } finally {
        inFlight = false;
        if (active && queued) {
          queued = false;
          refreshVisible();
        }
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState !== "visible" || appInteractionCoordinator.getLifecycleSnapshot().state !== "active") return;
      markPeriodicTaskRan(taskId);
      return refresh();
    };

    const unsubscribe = subscribeToDirectMessagesUpdated((detail) => {
      if (detail.userId === user.uid) refreshVisible();
    });
    // The global Feed stream already publishes message arrivals/deletions.
    // Recount after read-only changes too, without opening another SSE.
    window.addEventListener(FEED_STATE_CHANGED_EVENT, refreshVisible);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(refreshVisible);
    const unregister = registerPeriodicTask({
      id: taskId,
      intervalMs: FEED_LIVE_POLL_INTERVAL_MS,
      run: refreshVisible,
    });
    void refreshVisible();

    return () => {
      active = false;
      unsubscribe();
      unsubscribeLifecycle();
      unregister();
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, refreshVisible);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [session, taskId, user]);

  return snapshot?.session === session ? snapshot.count : null;
}

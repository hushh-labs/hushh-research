"use client";

import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import type { FeedListResponse } from "@/lib/services/feed-service";

/** The lifecycle row the backend writes when a person's pod comes up. */
export const PERSONAL_AGENT_READY_EVENT = "personal_agent_ready";

/**
 * Whether this person's private agent has already reported ready.
 *
 * Reads only the feed page the app has ALREADY loaded this session. Onboarding
 * is a flow every single person walks, so it must not grow a new network
 * dependency for one line of copy — an unknown answer stays an unknown answer,
 * and the screen says the honest thing either way.
 */
export function isPersonalAgentReadyFromCachedFeed(userId: string): boolean {
  if (!userId) return false;
  const cached = CacheService.getInstance().get<FeedListResponse>(
    CACHE_KEYS.FEED_LIST(userId),
  );
  return (cached?.items ?? []).some(
    (item) => item.event_type === PERSONAL_AGENT_READY_EVENT,
  );
}

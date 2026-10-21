"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { currentFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import { getAppScrollRoot, scrollAppToTop } from "@/lib/navigation/use-scroll-reset";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import type { FeedListResponse } from "@/lib/services/feed-service";
import { createFeedPaginationState, reconcileFeedFirstPage, type FeedPaginationState } from "@/lib/feed/feed-pagination";

type HistoryPresentation = { generation: number | null; revision: number; page: FeedListResponse; pagination: FeedPaginationState; scrollTop: number };

/** One bounded, memory-only return position. It never authorizes a Feed action. */
export function useFeedHistoryPresentation(userId: string | undefined, data: FeedListResponse | null) {
  const generation = getAuthSessionGeneration();
  const [revision, setRevision] = useState(() => userId ? currentFeedPresentationRevision(userId) : 0);
  const [saved] = useState(() => {
    if (!userId) return null;
    const cached = CacheService.getInstance().get<HistoryPresentation>(CACHE_KEYS.FEED_PRESENTATION(userId));
    return cached?.generation === generation && cached.revision === revision ? cached : null;
  });
  const [pagination, setPagination] = useState(saved?.pagination ?? createFeedPaginationState);
  const [page, setPage] = useState<FeedListResponse | null>(saved?.page ?? data);
  const [pending, setPending] = useState<FeedListResponse | null>(null);
  const scrollTop = useRef(saved?.scrollTop ?? 0);
  const restoring = useRef(Boolean(saved));
  const latest = useRef({ page, pagination });
  useLayoutEffect(() => { latest.current = { page, pagination }; }, [page, pagination]);

  useEffect(() => {
    if (!data) return;
    let currentRevision = userId ? currentFeedPresentationRevision(userId) : 0;
    const previous = latest.current.page;
    if (userId && previous && typeof data.history_revision === "string"
      && data.history_revision !== previous.history_revision && currentRevision === revision) {
      // A hidden tab or disconnected stream may have missed the deletion hint.
      CacheSyncService.onFeedHistoryMutated(userId);
      currentRevision = currentFeedPresentationRevision(userId);
    }
    if (currentRevision !== revision) {
      // A deletion invalidates omitted/loaded rows; ordinary arrivals retain
      // the reader's position and continue through the existing new-history path.
      setRevision(currentRevision);
      setPage(data);
      setPending(null);
      setPagination(reconcileFeedFirstPage(createFeedPaginationState(), data));
      restoring.current = false;
      return;
    }
    const known = new Set(previous?.items.map((item) => item.id));
    if (previous && scrollTop.current > 100 && data.items.some((item) => !known.has(item.id))) {
      setPending(data);
      // Existing statuses may settle immediately; newly prepended history waits
      // for the reader. Live emergency/actionable lanes have their own owner.
      const updates = new Map(data.items.map((item) => [item.id, item]));
      setPage({ ...previous, items: previous.items.map((item) => updates.get(item.id) ?? item) });
      return;
    }
    setPage(data);
    setPending(null);
    setPagination((current) => reconcileFeedFirstPage(current, data));
  }, [data, userId, revision]);

  useEffect(() => {
    const root = getAppScrollRoot();
    if (!root) return;
    const track = () => { if (!restoring.current) scrollTop.current = root.scrollTop; };
    const cancelRestore = () => { restoring.current = false; scrollTop.current = root.scrollTop; };
    root.addEventListener("scroll", track, { passive: true });
    root.addEventListener("wheel", cancelRestore, { passive: true });
    root.addEventListener("touchstart", cancelRestore, { passive: true });
    root.addEventListener("keydown", cancelRestore);
    return () => {
      root.removeEventListener("scroll", track);
      root.removeEventListener("wheel", cancelRestore);
      root.removeEventListener("touchstart", cancelRestore);
      root.removeEventListener("keydown", cancelRestore);
      const value = latest.current;
      if (userId && value.page && getAuthSessionGeneration() === generation
        && currentFeedPresentationRevision(userId) === revision
        && value.pagination.additionalItems.length <= 500) {
        CacheService.getInstance().set(CACHE_KEYS.FEED_PRESENTATION(userId), {
          ...value, generation, revision, scrollTop: scrollTop.current,
        }, CACHE_TTL.MEDIUM);
      }
    };
  }, [userId, generation, revision]);

  useEffect(() => {
    if (!saved || !page || !restoring.current) return;
    let second = 0;
    // The route shell owns its initial reset. Restore after that first layout,
    // inside the existing transition, and yield if the person starts scrolling.
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (!restoring.current) return;
      const root = getAppScrollRoot();
      if (root) root.scrollTop = saved.scrollTop;
      restoring.current = false;
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [saved, page]);

  const showNew = () => {
    if (!pending) return;
    setPage(pending);
    setPagination((current) => reconcileFeedFirstPage(current, pending));
    setPending(null);
    scrollAppToTop();
    scrollTop.current = 0;
  };
  return { page, pagination, setPagination, hasNew: pending !== null, showNew };
}

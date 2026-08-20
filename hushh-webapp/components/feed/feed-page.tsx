"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";

import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CACHE_KEYS, CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { FeedRow } from "@/components/feed/feed-row";
import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { useFeedActionables } from "@/lib/feed/use-feed-actionables";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import {
  FeedService,
  type FeedItem,
  type FeedListResponse,
} from "@/lib/services/feed-service";
import { daysSinceToday } from "@/lib/feed/feed-timestamp";

function dayLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const diffDays = daysSinceToday(date);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function groupItemsByDay(items: FeedItem[]): Array<{ label: string; items: FeedItem[] }> {
  const groups: Array<{ label: string; items: FeedItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.created_at);
    const current = groups[groups.length - 1];
    if (current && current.label === label) current.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function FeedPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [additionalItems, setAdditionalItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // The newest item id this visit has already reported as read. A live refresh
  // brings genuinely new rows in while the page is open, and those must clear
  // the tab badge too — a boolean latch marked read exactly once and then let
  // the badge count up over a list the user was looking straight at.
  const markedReadUpToRef = useRef<string | null>(null);
  const paginationInitializedRef = useRef(false);
  // Ids that arrived unread at any point during this visit.
  //
  // The Feed marks itself read on open but deliberately keeps those rows styled
  // unread until the next visit (see the mark-read effect below). Now that the
  // list actually re-fetches, the server would return those same rows as read
  // and the accent tint would drain out from under the reader mid-scroll.
  // Remembering them preserves the intended behaviour through a live refresh.
  const visitUnreadIdsRef = useRef<Set<string>>(new Set());
  // Durable clear. There is no backend feed-delete endpoint yet, so "Clear"
  // (a) marks everything read (which the server persists) and (b) records a
  // per-user "cleared up to this timestamp" watermark in localStorage. Every
  // load then hides items at or older than that watermark, so the cleared state
  // survives tab switches and refreshes — anything genuinely NEWER than the last
  // clear still shows. Replaces the old session-only boolean that reset on
  // remount (the bug: switching tabs and back re-showed cleared notifications).
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const clearedStorageKey = user?.uid
    ? `hushh:feed-cleared-at:${user.uid}`
    : null;

  // Hydrate the persisted watermark once the signed-in user is known. Reading in
  // an effect (not the initializer) avoids any SSR/hydration mismatch, since the
  // feed only renders meaningfully after auth resolves client-side.
  useEffect(() => {
    if (!clearedStorageKey) return;
    try {
      setClearedAt(window.localStorage.getItem(clearedStorageKey));
    } catch {
      // Storage can be disabled; fall back to no persisted clear.
    }
  }, [clearedStorageKey]);


  const { actionables, hasClearableSmsEmergencies, clearSmsEmergencies } =
    useFeedActionables();

  const {
    data,
    loading,
    error: resourceError,
    refresh,
  } = useStaleResource<FeedListResponse>({
    cacheKey: user?.uid ? CACHE_KEYS.FEED_LIST(user.uid) : "feed_list_signed_out",
    enabled: Boolean(user?.uid),
    resourceLabel: "feed_list",
    // `force` must reach FeedService: it keeps its own short-TTL cache in front
    // of the request, so dropping the flag here made a forced refresh return the
    // same page it already had and the list looked live without being live.
    load: async (options) => {
      const idToken = await user!.getIdToken();
      return FeedService.list({
        idToken,
        userId: user!.uid,
        limit: 20,
        force: options?.force,
      });
    },
  });

  // Keep the open list live. `force` is required: without it a cache entry that
  // is still inside its TTL short-circuits the load, which is exactly how the
  // Feed could sit open showing activity that had already been answered.
  useFeedLiveRefresh(
    useCallback(() => {
      void refresh({ force: true });
    }, [refresh]),
    Boolean(user?.uid),
  );

  useEffect(() => {
    if (!data || paginationInitializedRef.current) return;
    paginationInitializedRef.current = true;
    setNextCursor(data.next_cursor);
  }, [data]);

  const latestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (data?.items[0]?.id) {
      latestIdRef.current = data.items[0].id;
    }
  }, [data]);

  // Bulk mark unread notifications read when navigating away from the feed page
  // (unmount or tab visibility hidden), invalidating the feed list cache so the
  // next visit displays them as seen, and dispatching feed state change to
  // immediately refresh the tab badge count.
  useEffect(() => {
    const markSeen = () => {
      const latestId = latestIdRef.current;
      if (!user?.uid || !latestId || markedReadUpToRef.current === latestId) return;
      markedReadUpToRef.current = latestId;

      // Optimistic instant update (0ms): set cached unread count to 0 & update UI state immediately
      CacheService.getInstance().set(
        CACHE_KEYS.FEED_UNREAD_COUNT(user.uid),
        0,
        CACHE_TTL.SHORT,
      );
      CacheService.getInstance().invalidate(CACHE_KEYS.FEED_LIST(user.uid));
      dispatchFeedStateChanged("read");

      // Fire backend markRead call asynchronously in background
      void (async () => {
        try {
          const idToken = await user.getIdToken();
          await FeedService.markRead({
            idToken,
            upToId: latestId,
            userId: user.uid,
          });
        } catch (error) {
          markedReadUpToRef.current = null;
          console.warn(
            "[FeedPage] Failed to mark notifications read on navigate away:",
            error,
          );
        }
      })();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        markSeen();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      markSeen();
    };
  }, [user]);

  // Record every row that has been unread this visit, before the mark-read above
  // takes effect on the server. Covers paged-in rows too, which arrive unread on
  // their own request.
  useEffect(() => {
    for (const item of [...(data?.items ?? []), ...additionalItems]) {
      if (!item.read) visitUnreadIdsRef.current.add(item.id);
    }
  }, [data, additionalItems]);

  // A new signed-in user is a new visit: neither the read watermark nor the
  // unread set belongs to them.
  useEffect(() => {
    markedReadUpToRef.current = null;
    visitUnreadIdsRef.current = new Set();
  }, [user?.uid]);

  const items = useMemo(() => {
    // The cached first page can revalidate and shift after "load more" has
    // appended later pages; de-dupe by id so a boundary item never renders
    // twice (duplicate React keys) if it reappears across the seam.
    const seen = new Set<string>();
    const merged: FeedItem[] = [];
    // Drop anything at or older than the persisted "cleared" watermark so a
    // prior Clear survives tab switches and refreshes.
    const clearedMs = clearedAt ? new Date(clearedAt).getTime() : null;
    for (const item of [...(data?.items ?? []), ...additionalItems]) {
      if (seen.has(item.id)) continue;
      if (
        clearedMs !== null &&
        Number.isFinite(clearedMs) &&
        new Date(item.created_at).getTime() <= clearedMs
      ) {
        continue;
      }
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }, [data, additionalItems, clearedAt]);
  const error = resourceError
    ? "Couldn't load your feed."
    : loadMoreError;

  const loadMore = useCallback(async () => {
    if (!user || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const idToken = await user.getIdToken();
      const response = await FeedService.list({ idToken, cursor: nextCursor, limit: 20 });
      setAdditionalItems((current) => [...current, ...response.items]);
      setNextCursor(response.next_cursor);
    } catch {
      setLoadMoreError("Couldn't load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [user, nextCursor, loadingMore]);

  const openItem = useCallback(
    (item: FeedItem) => {
      const href = presentFeedItem(item).href;
      if (href) router.push(href);
    },
    [router],
  );

  const handleClearAll = useCallback(async () => {
    if (!user || clearing) return;
    setClearing(true);
    try {
      // Revoked/expired SOS cards have nothing left to act on — this is the
      // one "Needs you" actionable type Clear also reaches.
      if (hasClearableSmsEmergencies) clearSmsEmergencies();

      if (items.length > 0) {
        // Persist what the backend supports today: mark everything read so
        // the unread badge is cleared durably. Hiding the history rows is
        // session-scoped until a real feed-delete endpoint exists.
        const idToken = await user.getIdToken();
        const latestId = items[0]?.id;
        await FeedService.markRead({ idToken, upToId: latestId ?? null });
        dispatchFeedStateChanged("read");
        setAdditionalItems([]);
        setNextCursor(null);
        // Persist the clear as a timestamp watermark so it survives tab
        // switches and refreshes (the old session flag reset on remount).
        const nowIso = new Date().toISOString();
        setClearedAt(nowIso);
        if (clearedStorageKey) {
          try {
            window.localStorage.setItem(clearedStorageKey, nowIso);
          } catch {
            // Storage disabled: clear still applies for this session.
          }
        }
      }
      toast.success("Feed cleared");
    } catch {
      toast.error("Couldn't clear your feed.");
    } finally {
      setClearing(false);
    }
  }, [
    user,
    clearing,
    items,
    clearedStorageKey,
    hasClearableSmsEmergencies,
    clearSmsEmergencies,
  ]);


  // Present strictly newest-first by wall-clock time, then club into day
  // sections. The backend paginates by row id (append-only), which normally
  // equals created_at order; sorting here keeps the feed correct even when it
  // doesn't, so a day never appears split across the list.
  const dayGroups = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return groupItemsByDay(sorted);
  }, [items]);
  // A live SOS share gets its own "Live" section, pinned above "Needs you",
  // so a safety alert is never mistaken for a routine pending item, and two
  // live SOS cards never read as one merged block (each keeps its own
  // gapped, individually framed card). A revoked/expired SOS no longer
  // carries `emphasis: "emergency"` (see useFeedActionables) and falls
  // straight into the regular divide-y "Needs you" list like any other row.
  const liveActionables = actionables.filter(
    (item) => item.emphasis === "emergency",
  );
  const regularActionables = actionables.filter(
    (item) => item.emphasis !== "emergency",
  );
  const hasLiveActionables = liveActionables.length > 0;
  const hasRegularActionables = regularActionables.length > 0;
  const hasActionables = hasLiveActionables || hasRegularActionables;
  // Once cleared this session, the loaded history rows are hidden even though
  // `items` still holds them (no backend delete yet), so the empty state shows.
  const hasHistory = items.length > 0;
  const showEmpty = !loading && !hasActionables && !hasHistory && !error;
  // The Clear affordance only makes sense when there is dismissable history
  // showing. Actionables ("Needs you") are otherwise deliberately NOT
  // cleared — they're pending tasks the user must still act on — except a
  // revoked SOS card, which has nothing left to act on and is the one
  // actionable type Clear also removes.
  const canClear = hasHistory || hasClearableSmsEmergencies;


  return (
    <AppPageShell as="main" width="reading" className="!px-0 pb-24 sm:pb-28">
      <div className="mx-auto w-full max-w-[40rem]">
        {/* No in-body header: the shared top bar owns the "Feed" title + back
            arrow (see resolveTopShellBreadcrumb). Only the sticky day dividers
            below travel with the scroll. */}
        <AppPageContentRegion>
          {hasLiveActionables ? (
            <section aria-label="Live" className="bg-accent/[0.03]">
              <SectionLabel>Live</SectionLabel>
              <div className="flex flex-col gap-2 px-[6px] pb-2">
                {liveActionables.map((item) => (
                  <FeedActionableRow key={item.id} item={item} />
                ))}
              </div>
            </section>
          ) : null}

          {hasRegularActionables ? (
            <section aria-label="Needs you" className="bg-accent/[0.03]">
              <SectionLabel>Needs you</SectionLabel>
              <div className="divide-y divide-[color:var(--foundation-hairline)]">
                {regularActionables.map((item) => (
                  <FeedActionableRow key={item.id} item={item} />
                ))}
              </div>
            </section>
          ) : null}

          {loading && !hasHistory ? (
            <div role="status" className="px-4 py-16 text-center text-sm text-muted-foreground">
              Loading your feed…
            </div>
          ) : null}

          {error && !hasHistory ? (
            <div role="alert" className="px-4 py-16 text-center text-sm text-muted-foreground">
              {error}
            </div>
          ) : null}

          {showEmpty ? (
            <div role="status" className="px-4 py-16 text-center text-sm text-muted-foreground">
              {clearedAt ? "No notifications yet." : "You're all caught up."}
            </div>
          ) : null}

          {canClear ? (
            <div className="flex justify-end px-[6px] pt-2">
              <button
                type="button"
                onClick={() => void handleClearAll()}
                disabled={clearing}
                aria-label="Clear feed notifications"
                className="rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-60"
              >
                {clearing ? "Clearing…" : "Clear"}
              </button>
            </div>
          ) : null}

          {hasHistory
            ? dayGroups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <SectionLabel>{group.label}</SectionLabel>
                  <div className="divide-y divide-[color:var(--foundation-hairline)]">
                    {group.items.map((item) => (
                      <FeedRow
                        key={item.id}
                        item={item}
                        unread={
                          !item.read || visitUnreadIdsRef.current.has(item.id)
                        }
                        onOpen={openItem}
                      />
                    ))}
                  </div>
                </section>
              ))
            : null}

          {hasHistory && nextCursor ? (
            <div className="flex justify-center py-3">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </AppPageContentRegion>
      </div>
    </AppPageShell>
  );
}

/** Sticky day / section divider that follows the shared readable label scale. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <AppSectionLabel
      as="h2"
      className="sticky top-[var(--top-shell-live-height)] z-10 bg-background/85 px-[6px] pb-2 pt-7 backdrop-blur-md"
    >
      {children}
    </AppSectionLabel>
  );
}

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

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { FeedRow } from "@/components/feed/feed-row";
import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { useFeedActionables } from "@/lib/feed/use-feed-actionables";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import {
  FeedService,
  type FeedItem,
  type FeedListResponse,
} from "@/lib/services/feed-service";

function dayLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
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
  const markedReadRef = useRef(false);
  const paginationInitializedRef = useRef(false);

  const { actionables } = useFeedActionables();

  const {
    data,
    loading,
    error: resourceError,
  } = useStaleResource<FeedListResponse>({
    cacheKey: user?.uid ? CACHE_KEYS.FEED_LIST(user.uid) : "feed_list_signed_out",
    enabled: Boolean(user?.uid),
    resourceLabel: "feed_list",
    load: async () => {
      const idToken = await user!.getIdToken();
      return FeedService.list({ idToken, userId: user!.uid, limit: 20 });
    },
  });

  useEffect(() => {
    if (!data || paginationInitializedRef.current) return;
    paginationInitializedRef.current = true;
    setNextCursor(data.next_cursor);
  }, [data]);

  // Opening the feed clears the unread badge (Instagram/Twitter convention),
  // but we deliberately do NOT force-refresh the list: the rows the user is
  // looking at keep their unread styling for this visit, and only read as
  // "seen" on the next open. The badge (a separate unread-count) still clears
  // immediately via the dispatched event.
  useEffect(() => {
    if (!user || !data || markedReadRef.current) return;
    const latestId = data.items[0]?.id;
    if (!latestId) return;
    markedReadRef.current = true;
    void (async () => {
      const idToken = await user.getIdToken();
      await FeedService.markRead({ idToken, upToId: latestId });
      dispatchFeedStateChanged();
    })();
  }, [user, data]);

  const items = useMemo(() => {
    // The cached first page can revalidate and shift after "load more" has
    // appended later pages; de-dupe by id so a boundary item never renders
    // twice (duplicate React keys) if it reappears across the seam.
    const seen = new Set<string>();
    const merged: FeedItem[] = [];
    for (const item of [...(data?.items ?? []), ...additionalItems]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return merged;
  }, [data, additionalItems]);
  const error = resourceError
    ? "Feed could not be loaded right now."
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
      setLoadMoreError("Couldn't load more activity.");
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
  const hasActionables = actionables.length > 0;
  const hasHistory = items.length > 0;
  const showEmpty = !loading && !hasActionables && !hasHistory && !error;

  return (
    <AppPageShell as="main" width="reading" className="!px-0 pb-24 sm:pb-28">
      <div className="mx-auto w-full max-w-[40rem]">
        {/* No in-body header: the shared top bar owns the "Feed" title + back
            arrow (see resolveTopShellBreadcrumb). Only the sticky day dividers
            below travel with the scroll. */}
        <AppPageContentRegion>
          {hasActionables ? (
            <section aria-label="Needs you" className="bg-accent/[0.03]">
              <SectionLabel>Needs you</SectionLabel>
              <div className="divide-y divide-[color:var(--foundation-hairline)]">
                {actionables.map((item) => (
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
              You're all caught up.
            </div>
          ) : null}

          {hasHistory
            ? dayGroups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <SectionLabel>{group.label}</SectionLabel>
                  <div className="divide-y divide-[color:var(--foundation-hairline)]">
                    {group.items.map((item) => (
                      <FeedRow key={item.id} item={item} onOpen={openItem} />
                    ))}
                  </div>
                </section>
              ))
            : null}

          {nextCursor ? (
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

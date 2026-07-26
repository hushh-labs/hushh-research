"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { FeedItemRow } from "@/components/feed/feed-item-row";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { FeedService, type FeedItem } from "@/lib/services/feed-service";

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
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.label === label) {
      currentGroup.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

export function FeedPage() {
  const router = useRouter();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markedReadRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await FeedService.list({ idToken, limit: 20 });
      setItems(response.items);
      setNextCursor(response.next_cursor);
      const latestId = response.items[0]?.id;
      if (!markedReadRef.current && latestId) {
        markedReadRef.current = true;
        await FeedService.markRead({ idToken, upToId: latestId });
        dispatchFeedStateChanged();
      }
    } catch {
      setError("Feed could not be loaded right now.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!user || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const idToken = await user.getIdToken();
      const response = await FeedService.list({ idToken, cursor: nextCursor, limit: 20 });
      setItems((current) => [...current, ...response.items]);
      setNextCursor(response.next_cursor);
    } catch {
      setError("Couldn't load more activity.");
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

  return (
    <AppPageShell
      as="main"
      width="reading"
      className={cn("pb-24 sm:pb-28", isMobile && "!px-0")}
    >
      {isMobile ? null : (
        <AppPageHeaderRegion>
          <PageHeader
            title="Feed"
            description="Recent activity across consent, location, finance, KYC, connected systems, and connections."
            accent="neutral"
          />
        </AppPageHeaderRegion>
      )}

      <AppPageContentRegion>
        {loading ? (
          <div role="status" className="px-4 py-16 text-center text-sm text-muted-foreground">
            Loading your feed…
          </div>
        ) : error && items.length === 0 ? (
          <div role="alert" className="px-4 py-16 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div role="status" className="px-4 py-16 text-center text-sm text-muted-foreground">
            No activity yet.
          </div>
        ) : (
          <div aria-label="Activity feed" className="border-b border-border/70">
            {groupItemsByDay(items).map((group) => (
              <section key={group.label}>
                <h2 className="px-4 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80 first:pt-2">
                  {group.label}
                </h2>
                <div className="divide-y divide-border/70">
                  {group.items.map((item) => (
                    <FeedItemRow key={item.id} item={item} onOpen={openItem} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {nextCursor ? (
          <div className="flex justify-center py-4">
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
    </AppPageShell>
  );
}

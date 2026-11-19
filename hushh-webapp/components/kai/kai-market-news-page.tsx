"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCcw } from "@/components/icons";
import { useIndiaMarketHome } from "@/lib/kai/use-india-market-home";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { OneMarketNewsRow } from "@/components/kai/cards/market-news-briefing";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { KaiMarketNewsResourceService } from "@/lib/kai/kai-market-news-resource";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import {
  MarketNewsSnapshotChangedError,
  type KaiHomeNewsItem,
  type KaiMarketNewsPage,
} from "@/lib/services/api-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { useVault } from "@/lib/vault/vault-context";

const PAGE_SIZE = 12;

function dedupePages(pages: Array<KaiMarketNewsPage | null>): KaiHomeNewsItem[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page?.items || []).filter((item) => {
    const key = `${item.url}:${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Finite, cache-first Market News workspace. Cursor pagination addresses a
 * stable server snapshot, so a second page slices cached server data and never
 * issues a second provider fanout just because the person pressed Load more.
 */
export function KaiMarketNewsPage() {
  const params = useSearchParams();
  return params?.get("market") === "IN" ? <KaiIndiaMarketNewsPage /> : <UsMarketNewsPage />;
}

function UsMarketNewsPage() {
  const { user, userId: ownerId, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = ownerId ?? "";
  const trackedSymbols = useMemo(
    () => (userId ? KaiMarketHomeResourceService.resolveTrackedSymbols(userId).slice(0, 3) : []),
    [userId],
  );
  const mode = vaultOwnerToken && trackedSymbols.length > 0 ? "personalized" : "baseline";
  const scope = mode === "personalized" ? `personalized:${trackedSymbols.join("-")}` : "baseline";
  const cacheKey = userId
    ? CACHE_KEYS.KAI_MARKET_NEWS(userId, scope, null, PAGE_SIZE, 7)
    : "kai_market_news_guest";
  const [paging, setPaging] = useState<{ feedKey: string; pages: KaiMarketNewsPage[] }>({ feedKey: "", pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [resyncMessage, setResyncMessage] = useState<string | null>(null);

  const firstPageResource = useStaleResource({
    cacheKey,
    refreshKey: `${scope}:${vaultOwnerToken ? "owner" : "baseline"}`,
    enabled: Boolean(userId),
    resourceLabel: "kai_market_news",
    load: async (options) =>
      await KaiMarketNewsResourceService.getStaleFirst({
        userId,
        mode,
        vaultOwnerToken,
        symbols: trackedSymbols,
        limit: PAGE_SIZE,
        forceRefresh: Boolean(options?.force),
        backgroundRefresh: !options?.force,
      }),
  });

  const feedKey = JSON.stringify([cacheKey, firstPageResource.data?.snapshot_id]);
  const feedLifecycle = useRef({ key: feedKey, generation: 0 });
  if (feedLifecycle.current.key !== feedKey) {
    feedLifecycle.current = { key: feedKey, generation: feedLifecycle.current.generation + 1 };
  }
  useEffect(() => {
    const generation = feedLifecycle.current.generation;
    setPaging({ feedKey, pages: [] });
    setLoadingMore(false);
    setResyncMessage(null);
    return () => {
      if (feedLifecycle.current.generation === generation) feedLifecycle.current.generation += 1;
    };
  }, [feedKey]);

  const allPages = useMemo(
    () => [firstPageResource.data, ...(paging.feedKey === feedKey ? paging.pages : [])],
    [feedKey, paging, firstPageResource.data],
  );
  const rows = useMemo(() => dedupePages(allPages), [allPages]);
  const lastPage = allPages.at(-1) ?? null;

  const loadMore = useCallback(async () => {
    if (!userId || loadingMore || !lastPage?.has_more || !lastPage.next_cursor) return;
    const generation = feedLifecycle.current.generation;
    const isCurrentFeed = () => feedLifecycle.current.generation === generation;
    setLoadingMore(true);
    setResyncMessage(null);
    try {
      const nextPage = await KaiMarketNewsResourceService.getStaleFirst({
        userId,
        mode,
        vaultOwnerToken,
        symbols: trackedSymbols,
        cursor: lastPage.next_cursor,
        limit: PAGE_SIZE,
        backgroundRefresh: true,
      });
      if (!isCurrentFeed() || !nextPage) return;
      setPaging((current) => {
        if (!isCurrentFeed()) return current;
        const snapshotId = firstPageResource.data?.snapshot_id;
        if (!snapshotId || nextPage.snapshot_id !== snapshotId) return current;
        const pages = current.feedKey === feedKey ? current.pages : [];
        if (pages.some((page) => page.next_cursor === nextPage.next_cursor)) return current;
        return { feedKey, pages: [...pages, nextPage] };
      });
    } catch (error) {
      if (!isCurrentFeed()) return;
      if (error instanceof MarketNewsSnapshotChangedError) {
        setPaging({ feedKey, pages: [] });
        setResyncMessage("The market news feed refreshed. Showing the latest headlines.");
        await firstPageResource.refresh({ force: true });
        return;
      }
      setResyncMessage("Couldn’t load more headlines just now. Please try again.");
    } finally {
      if (isCurrentFeed()) setLoadingMore(false);
    }
  }, [
    firstPageResource,
    feedKey,
    lastPage?.has_more,
    lastPage?.next_cursor,
    loadingMore,
    mode,
    trackedSymbols,
    userId,
    vaultOwnerToken,
  ]);

  const dataState = authLoading || firstPageResource.loading ? "loading" : firstPageResource.error ? "error" : "loaded";

  if (authLoading || !user) return null;

  return (
    <AppPageShell
      width="reading"
      className="app-type-compact pb-32"
      nativeTest={{
        routeId: ROUTES.KAI_NEWS,
        marker: "native-route-kai-news",
        authState: "authenticated",
        dataState,
      }}
    >
      <KaiWorkspaceHeader
        workspace="market"
        title="Market news"
        description={
          mode === "personalized"
            ? "Headlines for your holdings."
            : "Unlock your vault for headlines about your holdings."
        }
        actions={
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="sm"
            loading={firstPageResource.refreshing}
            onClick={() => void firstPageResource.refresh({ force: true })}
            icon={{ icon: RefreshCcw }}
          >
            Refresh
          </Button>
        }
      />

      <AppPageContentRegion>
        <section
          aria-label="Market headlines"
          className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-card shadow-[var(--app-card-shadow-soft)]"
        >
          {firstPageResource.loading && !rows.length ? (
            <div className="space-y-3 px-4 py-5 sm:px-5" aria-label="Loading market news">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="h-16 animate-pulse rounded-xl bg-muted/60" />
              ))}
            </div>
          ) : rows.length ? (
            <div>{rows.map((item) => <OneMarketNewsRow key={`${item.url}:${item.title}`} row={item} />)}</div>
          ) : (
            <div className="px-4 py-6 text-center sm:px-5">
              <p className="text-sm font-medium text-foreground">No market headlines are available yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Try refreshing in a moment.</p>
            </div>
          )}

          {resyncMessage ? (
            <p role="status" className="border-t border-[color:var(--app-card-border-standard)] px-4 py-3 text-sm text-muted-foreground sm:px-5">
              {resyncMessage}
            </p>
          ) : null}

          {lastPage?.has_more ? (
            <div className="flex justify-center border-t border-[color:var(--app-card-border-standard)] px-4 py-3 sm:px-5">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </section>

        {(firstPageResource.error || firstPageResource.data?.stale) && rows.length ? (
          <p className="mt-3 text-sm text-muted-foreground">Showing saved headlines. Refresh for the latest coverage.</p>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

/**
 * All India headlines. The India view has no cursor-paged feed, so this lists the
 * newest headlines from the shared India market payload.
 */
function KaiIndiaMarketNewsPage() {
  const { user, userId, loading: authLoading } = useAuth();
  const india = useIndiaMarketHome(userId, true);
  const rows = Array.isArray(india.data?.news_tape) ? india.data.news_tape : [];
  const dataState = authLoading || india.loading ? "loading" : india.error ? "error" : "loaded";

  if (authLoading || !user) return null;

  return (
    <AppPageShell
      width="reading"
      className="app-type-compact pb-32"
      nativeTest={{ routeId: ROUTES.KAI_NEWS, marker: "native-route-kai-news", authState: "authenticated", dataState }}
    >
      <KaiWorkspaceHeader
        workspace="market"
        title="Market news"
        description="Latest India market headlines."
        actions={
          <Button type="button" variant="none" effect="fade" size="sm" loading={india.refreshing}
            onClick={() => void india.refresh({ force: true })} icon={{ icon: RefreshCcw }}>
            Refresh
          </Button>
        }
      />
      <AppPageContentRegion>
        <section aria-label="India headlines"
          className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-card shadow-[var(--app-card-shadow-soft)]">
          {india.loading && !rows.length ? (
            <div className="space-y-3 px-4 py-5 sm:px-5" aria-label="Loading market news">
              {[0, 1, 2, 3].map((slot) => <div key={slot} className="h-16 animate-pulse rounded-xl bg-muted/60" />)}
            </div>
          ) : rows.length ? (
            <div>{rows.map((item) => <OneMarketNewsRow key={`${item.url}:${item.title}`} row={item} />)}</div>
          ) : (
            <div className="px-4 py-6 text-center sm:px-5">
              <p className="text-sm font-medium text-foreground">No India headlines are available yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Try refreshing in a moment.</p>
            </div>
          )}
        </section>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

"use client";

import { marketNewsArticleUrl } from "@/lib/kai/market-news-diversity";
import { Browser } from "@capacitor/browser";
import { usePathname } from "next/navigation";
import { useNativeWorkspaceImages } from "@/components/app-ui/use-native-workspace-portraits";
import { validNativeMarketNewsStory } from "@/lib/capacitor/native-workspace";
import type { NativeMarketNewsStory } from "@/lib/capacitor/native-drawers";
import { prepareNativeSymbolArtwork } from "@/lib/services/native-public-image-service";
import { NativeWorkspaceRoute, type NativeWorkspaceSurfaceSection } from "@/lib/capacitor/native-workspace-surface";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCcw } from "@/components/icons";
import { useIndiaMarketHome } from "@/lib/kai/use-india-market-home";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { getCompanyLogoUrl, symbolAvatarFallback } from "@/components/kai/shared/symbol-avatar";
import { OneMarketNewsRow } from "@/components/kai/cards/market-news-briefing";
import { useAuth } from "@/hooks/use-auth";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { KaiMarketNewsResourceService } from "@/lib/kai/kai-market-news-resource";
import { Button } from "@/lib/morphy-ux/button";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import {
  MarketNewsSnapshotChangedError,
  type KaiHomeNewsItem,
  type KaiMarketNewsPage,
} from "@/lib/services/api-service";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { useVault } from "@/lib/vault/vault-context";

const PAGE_SIZE = 12;

function formatPublishedAt(value: string | null | undefined): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "Recent";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dedupePages(pages: Array<KaiMarketNewsPage | null>): KaiHomeNewsItem[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page?.items || []).filter((item) => {
    const key = `${item.url}:${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const KNOWN_TICKER_ALIASES: Record<string, string[]> = {
  AAPL: ["apple"],
  NVDA: ["nvidia"],
  MSFT: ["microsoft"],
  AMZN: ["amazon"],
  GOOGL: ["google", "alphabet"],
  META: ["meta", "facebook", "instagram"],
  TSLA: ["tesla"],
  NFLX: ["netflix"],
  BA: ["boeing"],
  AMD: ["amd", "advanced micro devices"],
  INTC: ["intel"],
  DIS: ["disney"],
  JPM: ["jpmorgan", "chase"],
  BAC: ["bank of america"],
  WMT: ["walmart"],
  UNH: ["unitedhealth"],
};

function extractNewsSymbols(item: KaiHomeNewsItem): string[] {
  const rawSymbol = String(item.symbol || "").trim().toUpperCase();
  const rawSymbols = rawSymbol
    .split(/[,;\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && s !== "MARKET" && s !== "GENERAL" && s !== "MACRO" && s !== "NEWS");

  const titleLower = String(item.title || "").toLowerCase();
  const matchedFromTitle: string[] = [];

  for (const [ticker, aliases] of Object.entries(KNOWN_TICKER_ALIASES)) {
    if (rawSymbols.includes(ticker)) continue;
    const allMatches = [ticker.toLowerCase(), ...aliases];
    const found = allMatches.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(titleLower);
    });
    if (found) {
      matchedFromTitle.push(ticker);
    }
  }

  return Array.from(new Set([...rawSymbols, ...matchedFromTitle]));
}

function nativeStory(item: KaiHomeNewsItem, symbols: readonly string[], png?: string): NativeMarketNewsStory {
  const sentiment = String(item.sentiment_hint || "").toLowerCase();
  return { publisher: String(item.source_name || "Market news").trim() || "Market news", publishedAt: formatPublishedAt(item.published_at),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(sentiment.includes("positive") ? { sentiment: "positive" } : sentiment.includes("negative") ? { sentiment: "risk" } : {}),
    symbols, ...(symbols[0] ? { artwork: { ...symbolAvatarFallback(symbols[0]), ...(png ? { png } : {}) } } : {}),
  };
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
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const nativeFrame = useRef<HTMLDivElement | null>(null);
  const [nativeWindow, setNativeWindow] = useState({ key: "", page: 0 });
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
  const page = nativeWindow.key === feedKey ? Math.min(nativeWindow.page, Math.max(0, Math.ceil(rows.length / 40) - 1)) : 0;
  const nativeStories = rows.slice(page * 40, (page + 1) * 40).map(item => ({ item, key: `article:${item.url}:${item.title}`, symbols: extractNewsSymbols(item) }));
  const nativeSupported = nativeStories.every(({ item, symbols }) => validNativeMarketNewsStory(item.title, nativeStory(item, symbols)));
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const artwork = useNativeWorkspaceImages(ownerId, Boolean(nativeSupported && isVaultUnlocked && customNativePresentationEnabled() && pathname === ROUTES.KAI_NEWS),
    nativeStories.map(({ key, symbols }) => ({ key, source: symbols[0] ? getCompanyLogoUrl({ symbol: symbols[0] }) : null })), prepareNativeSymbolArtwork);


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

  const content = (
    <AppPageShell ref={nativeFrame}
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
  if (!isVaultUnlocked || !customNativePresentationEnabled()) return content;
  const description = mode === "personalized" ? "Latest reporting around the holdings currently available in your private workspace." : "A current market briefing. Unlock your vault to tailor this to your holdings.";
  const sections: NativeWorkspaceSurfaceSection[] = [{ key: "news-controls", rows: [
    { key: "scope", label: description },
    { key: "refresh", label: "Refresh", pending: firstPageResource.refreshing, enabled: !firstPageResource.refreshing, run: () => firstPageResource.refresh({ force: true }) },
  ] }];
  if (firstPageResource.loading && !rows.length) sections.push({ key: "loading", rows: [{ key: "loading", label: "Loading market news", pending: true }] });
  else if (!rows.length) sections.push({ key: "empty", rows: [{ key: "empty", label: "No market headlines are available yet.", detail: "Try refreshing in a moment." }] });
  else sections.push({ key: "headlines", title: "Headlines", rows: nativeStories.map(({ item, key, symbols }) => {
    const href = marketNewsArticleUrl(item.url);
    return { key, label: item.title, enabled: Boolean(href), marketNews: nativeStory(item, symbols, artwork.get(key)),
      run: () => href ? Browser.open({ url: href }) : undefined };
  }) });
  const controls = [];
  if (page > 0) controls.push({ key: "previous", label: "Previous headlines", run: () => setNativeWindow({ key: feedKey, page: page - 1 }) });
  if ((page + 1) * 40 < rows.length) controls.push({ key: "next", label: "Next headlines", run: () => setNativeWindow({ key: feedKey, page: page + 1 }) });
  if (lastPage?.has_more) controls.push({ key: "load-more", label: "Load more", enabled: !loadingMore, pending: loadingMore, run: loadMore });
  if (controls.length) sections.push({ key: "news-paging", rows: controls });
  if (resyncMessage) sections.push({ key: "news-resync", rows: [{ key: "resync", label: resyncMessage }] });
  if ((firstPageResource.error || firstPageResource.data?.stale) && rows.length) sections.push({ key: "news-stale", rows: [{ key: "stale", label: "Showing saved headlines. Refresh for the latest coverage." }] });
  return <NativeWorkspaceRoute contentPresentation={nativeSupported && sections.every(section => section.rows.every(row => !row.marketNews || validNativeMarketNewsStory(row.label, row.marketNews))) ? "native" : "rich"} owner={ownerId} workspace="finance" viewKey={`${feedKey}:${page}`} path={ROUTES.KAI_NEWS} title="Market news" active frame={nativeFrame} sections={sections}>{content}</NativeWorkspaceRoute>;
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

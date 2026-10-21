"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, RefreshCcw } from "@/components/icons";

import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { KaiWorkspaceHeader } from "@/components/kai/kai-workspace-header";
import { SectionHeader } from "@/components/app-ui/page-sections";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { OneMarketNewsCover } from "@/components/kai/cards/market-news-briefing";
import marketStyles from "@/components/kai/shared/market-briefing.module.css";
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
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
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

function validArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
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

function MarketNewsRow({ item }: { item: KaiHomeNewsItem }) {
  const href = validArticleUrl(item.url);
  const source = String(item.source_name || "Market news").trim() || "Market news";
  const linkedSymbols = extractNewsSymbols(item);
  const sentiment = String(item.sentiment_hint || "").toLowerCase();

  return (
    <article className="min-w-0 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        disabled={!href}
        onClick={() => href && openExternalUrl(href)}
        className={cn(
          "group/news flex min-h-[100px] w-full flex-col items-stretch py-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          href
            ? "hover:bg-muted/35 focus-visible:bg-muted/45 disabled:cursor-default"
            : "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-start gap-4">
          <span className="min-w-0 flex-1">
            <span className={cn(marketStyles.newsTitle, "text-foreground transition-colors group-hover/news:text-[color:var(--app-accent)]")}>
              {item.title}
            </span>
            <span className={marketStyles.newsMetadata}>
              {source}<span aria-hidden="true"> · </span>{formatPublishedAt(item.published_at)}
              {href ? <ExternalLink className="ml-1 inline-block h-3 w-3 align-baseline" aria-label="Opens publisher article" /> : null}
            </span>
          </span>
          <OneMarketNewsCover row={item} index={0} thumbnail className="mt-0.5 h-16 w-16 shrink-0 rounded-lg [&_img]:!h-full [&_img]:!w-full [&_img]:object-cover sm:h-20 sm:w-20" />
        </span>
        {item.summary ? (
          <span className={cn(marketStyles.newsSummary, "mt-2 block break-words text-muted-foreground")}>
            {item.summary}
          </span>
        ) : null}
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-[18px] text-muted-foreground">
          <span className="font-medium">{linkedSymbols.length ? linkedSymbols.join(" · ") : "Market"}</span>
          {sentiment.includes("positive") ? (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              Positive
            </span>
          ) : sentiment.includes("negative") ? (
            <span className="font-medium text-rose-600 dark:text-rose-400">
              Risk
            </span>
          ) : null}
        </span>
      </button>
    </article>
  );
}

/**
 * Finite, cache-first Market News workspace. Cursor pagination addresses a
 * stable server snapshot, so a second page slices cached server data and never
 * issues a second provider fanout just because the person pressed Load more.
 */
export function KaiMarketNewsPage() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = user?.uid ?? "";
  const trackedSymbols = useMemo(
    () => (userId ? KaiMarketHomeResourceService.resolveTrackedSymbols(userId).slice(0, 3) : []),
    [userId],
  );
  const mode = vaultOwnerToken && trackedSymbols.length > 0 ? "personalized" : "baseline";
  const scope = mode === "personalized" ? `personalized:${trackedSymbols.join("-")}` : "baseline";
  const cacheKey = userId
    ? CACHE_KEYS.KAI_MARKET_NEWS(userId, scope, null, PAGE_SIZE, 7)
    : "kai_market_news_guest";
  const [additionalPages, setAdditionalPages] = useState<KaiMarketNewsPage[]>([]);
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

  useEffect(() => {
    setAdditionalPages([]);
    setResyncMessage(null);
  }, [scope, firstPageResource.data?.snapshot_id]);

  const allPages = useMemo(
    () => [firstPageResource.data, ...additionalPages],
    [additionalPages, firstPageResource.data],
  );
  const rows = useMemo(() => dedupePages(allPages), [allPages]);
  const lastPage = allPages.at(-1) ?? null;

  const loadMore = useCallback(async () => {
    if (!userId || loadingMore || !lastPage?.has_more || !lastPage.next_cursor) return;
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
      if (!nextPage) return;
      setAdditionalPages((current) => {
        const snapshotId = firstPageResource.data?.snapshot_id;
        if (!snapshotId || nextPage.snapshot_id !== snapshotId) return [];
        if (current.some((page) => page.next_cursor === nextPage.next_cursor)) return current;
        return [...current, nextPage];
      });
    } catch (error) {
      if (error instanceof MarketNewsSnapshotChangedError) {
        setAdditionalPages([]);
        setResyncMessage("The market news feed refreshed. Showing the latest headlines.");
        await firstPageResource.refresh({ force: true });
        return;
      }
      setResyncMessage("Couldn’t load more headlines just now. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }, [
    firstPageResource,
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
      fitContent
      headerContentSpacing="compact"
      className={marketStyles.typography}
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
        actionsInlineMobile
        description={
          mode === "personalized"
            ? "News for your holdings."
            : "Latest market headlines."
        }
        actions={
          <ShellActionSurface
            type="button"
            aria-label="Refresh market news"
            disabled={firstPageResource.refreshing}
            className="h-11 w-11"
            onClick={() => void firstPageResource.refresh({ force: true })}
          >
            {firstPageResource.refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCcw className="h-4 w-4" aria-hidden="true" />}
          </ShellActionSurface>
        }
      />

      <AppPageContentRegion>
        <section
          aria-labelledby="market-news-list-title"
          className="min-w-0"
        >
          <SectionHeader title={<span id="market-news-list-title">Headlines</span>} className={marketStyles.sectionHeader} actions={firstPageResource.refreshing ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating
              </span>
            ) : undefined} />
          <SurfaceCard>
          <SurfaceCardContent className={marketStyles.cardBody}>

          {firstPageResource.loading && !rows.length ? (
            <div className="space-y-3 py-2" aria-label="Loading market news">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="h-16 animate-pulse rounded-xl bg-muted/60" />
              ))}
            </div>
          ) : rows.length ? (
            <div className="min-w-0">{rows.map((item) => <MarketNewsRow key={`${item.url}:${item.title}`} item={item} />)}</div>
          ) : (
            <div className="py-8 text-center">
              <p className="text-sm font-medium text-foreground">No market headlines are available yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Try refreshing in a moment.</p>
            </div>
          )}

          {resyncMessage ? (
            <p className="border-t border-border/60 py-3 text-sm text-muted-foreground" role="status">
              {resyncMessage}
            </p>
          ) : null}

          {lastPage?.has_more ? (
            <div className="flex justify-center border-t border-border/60 pt-4">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                className="min-h-11"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            </div>
          ) : null}
          </SurfaceCardContent>
          </SurfaceCard>
        </section>

        {firstPageResource.error && rows.length ? (
          <p className="mt-3 text-sm text-muted-foreground">Showing saved headlines while the latest refresh is unavailable.</p>
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

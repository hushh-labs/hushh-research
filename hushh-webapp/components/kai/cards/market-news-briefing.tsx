"use client";
import { useEffect, useState } from "react";
import { getCompanyLogoUrl } from "@/components/kai/shared/symbol-avatar";
import type { KaiHomeNewsItem } from "@/lib/services/api-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";
function normalizeMarketSymbol(value: unknown) { return String(value || "").trim().toUpperCase(); }
function validArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function formatHeadlinePublished(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const NEWS_SYMBOL_ALIASES: Record<string, readonly string[]> = {
  AAPL: ["apple"],
  AMZN: ["amazon"],
  BA: ["boeing"],
  GOOGL: ["google", "alphabet"],
  META: ["meta", "facebook", "instagram"],
  MSFT: ["microsoft"],
  NFLX: ["netflix"],
  NVDA: ["nvidia"],
  TSLA: ["tesla"],
};

export function shouldShowNewsCompanyLogo(row: KaiHomeNewsItem): boolean {
  const symbol = normalizeMarketSymbol(row.symbol);
  const title = String(row.title || "").toLowerCase();
  if (!symbol || symbol === "MARKET" || !title) return false;

  const aliases = [
    symbol.toLowerCase(),
    ...(NEWS_SYMBOL_ALIASES[symbol] || []),
  ];
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(title);
  });
}

export function marketNewsImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.hostname === "s.yimg.com" && url.pathname === "/rz/stage/p/yahoo_finance_en-US_h_p_finance_2.png") return null;
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function marketNewsCoverSources(row: KaiHomeNewsItem, thumbnail = false): string[] {
  const articleImage = marketNewsImageUrl(row.image_url);
  const thumbnailImage = marketNewsImageUrl(row.image_thumbnail_url);
  const photos = thumbnail ? [thumbnailImage, articleImage] : [articleImage, thumbnailImage];
  const publisherLogo = marketNewsImageUrl(row.source_logo_url);
  const logo = shouldShowNewsCompanyLogo(row) ? getCompanyLogoUrl({ symbol: normalizeMarketSymbol(row.symbol) }) : null;
  return [...new Set([...photos, publisherLogo, logo].filter((url): url is string => Boolean(url)))];
}

export function OneMarketNewsCover({ row, className, thumbnail = false }: { row: KaiHomeNewsItem; index: number; className?: string; thumbnail?: boolean }) {
  const articleImage = marketNewsImageUrl(row.image_url);
  const thumbnailImage = marketNewsImageUrl(row.image_thumbnail_url);
  const logo = shouldShowNewsCompanyLogo(row) ? getCompanyLogoUrl({ symbol: normalizeMarketSymbol(row.symbol) }) : null;
  const publisherLogo = marketNewsImageUrl(row.source_logo_url);
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const source = marketNewsCoverSources(row, thumbnail).find((url) => !failedUrls.includes(url));
  const isLogo = source === publisherLogo || source === logo;
  const publisherWords = row.source_name?.match(/[\p{L}\p{N}]+/gu) ?? [];
  const initials = publisherWords.slice(0, 2).map(word => Array.from(word)[0]).join("").toLocaleUpperCase() || "MN";
  useEffect(() => { setFailedUrls([]); }, [articleImage, thumbnailImage, logo, publisherLogo]);
  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden bg-muted text-muted-foreground", className || "h-[140px]")}>
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
          data-publisher-logo={isLogo ? "true" : undefined}
          className={isLogo ? "h-12 w-12 object-contain" : "h-full w-full object-cover"}
          onError={() => setFailedUrls((current) => [...current, source])} />
      ) : <span aria-hidden="true" className="text-base font-semibold tracking-wide">{initials}</span>}
    </div>
  );
}

export function OneMarketNewsRow({ row, showSummary = false, className }: {
  row: KaiHomeNewsItem;
  showSummary?: boolean;
  className?: string;
}) {
  const href = validArticleUrl(row.url);
  const published = formatHeadlinePublished(row.published_at);

  return (
    <article className={cn(marketBriefingStyles.typography, "min-w-0 border-b border-border/60 last:border-b-0", className)}>
      <button
        type="button"
        disabled={!href}
        onClick={() => { if (href) openExternalUrl(href); }}
        className="group/news relative isolate flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-sm px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <span className="min-w-0 flex-1">
          <span className={cn(marketBriefingStyles.newsTitle, "text-foreground transition-colors group-hover/news:text-[color:var(--one-link)]")}>{row.title}</span>
          <span className={cn(marketBriefingStyles.newsMetadata, "truncate")}>
            {row.source_name?.trim() || "Market news"}
            {published && <><span aria-hidden="true"> · </span><time dateTime={row.published_at ?? undefined}>{published}</time></>}
          </span>
          {showSummary ? <span className="mt-1 hidden h-5 text-xs leading-5 text-muted-foreground sm:line-clamp-1">{row.summary}</span> : null}
        </span>
        <OneMarketNewsCover row={row} index={0} thumbnail className="h-14 w-14 shrink-0 rounded-lg [&_img]:!h-full [&_img]:!w-full [&_img]:object-cover [&_img[data-publisher-logo]]:!object-contain [&_img[data-publisher-logo]]:!p-3 sm:h-16 sm:w-16" />
        <MaterialRipple variant="none" effect="fade" className="z-10" />
      </button>
    </article>
  );
}

export function OneMarketNewsBriefing({ rows, loading = false }: { rows: KaiHomeNewsItem[]; loading?: boolean }) {
  const stories = rows.slice(0, 4);
  const showSummaries = stories.some((story) => Boolean(story.summary));
  if (!stories.length && loading) return (
    <div className={cn(marketBriefingStyles.typography, "grid sm:grid-cols-2 sm:gap-x-6")} role="status" aria-label="Loading market news" aria-busy="true">
      {[0, 1, 2, 3].map((slot) => (
        <div key={slot} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
            <div className="h-3 w-7/12 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-lg bg-muted sm:h-16 sm:w-16" />
        </div>
      ))}
    </div>
  );
  if (!stories.length) return <p className="py-4 text-sm text-muted-foreground">Headlines will appear here when a market source is available.</p>;
  return (
    <div className={cn(marketBriefingStyles.typography, "grid sm:grid-cols-2 sm:gap-x-6")}>
      {stories.map((row) => (
        <OneMarketNewsRow key={row.url} row={row} showSummary={showSummaries} className="sm:[&:nth-last-child(2)]:border-b-0" />
      ))}
    </div>
  );
}

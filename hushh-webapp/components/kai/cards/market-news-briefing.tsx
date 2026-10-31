"use client";
import { useEffect, useState } from "react";
import { Newspaper } from "@/components/icons";
import { getCompanyLogoUrl } from "@/components/kai/shared/symbol-avatar";
import type { KaiHomeNewsItem } from "@/lib/services/api-service";
import { openExternalUrl, requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";
function normalizeMarketSymbol(value: unknown) { return String(value || "").trim().toUpperCase(); }
function openOneMarketHref(href: string) {
  if (/^https?:\/\//i.test(href)) { openExternalUrl(href); return; }
  requestInternalAppNavigation({ href, scroll: false });
}

function formatHeadlinePublished(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "Recent";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "Recent";
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
  if (!symbol || !title) return false;

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

export function OneMarketNewsCover({ row, className, thumbnail = false }: { row: KaiHomeNewsItem; index: number; className?: string; thumbnail?: boolean }) {
  const articleImage = marketNewsImageUrl(thumbnail ? row.image_thumbnail_url || row.image_url : row.image_url);
  const fallbackImage = marketNewsImageUrl(thumbnail ? row.image_url : row.image_thumbnail_url);
  const logo = shouldShowNewsCompanyLogo(row) ? getCompanyLogoUrl({ symbol: normalizeMarketSymbol(row.symbol) }) : null;
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const source = [articleImage, fallbackImage, logo].find((url) => url && !failedUrls.includes(url));
  useEffect(() => { setFailedUrls([]); }, [articleImage, fallbackImage, logo]);
  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden bg-muted text-muted-foreground", className || "h-[140px]")}>
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
          className={source !== logo ? "h-full w-full object-cover" : "h-12 w-12 object-contain"}
          onError={() => setFailedUrls((current) => [...current, source])} />
      ) : <Newspaper className="h-7 w-7" aria-hidden="true" />}
    </div>
  );
}

export function OneMarketNewsBriefing({ rows }: { rows: KaiHomeNewsItem[] }) {
  const stories = rows.slice(0, 4);
  if (!stories.length) return <p className="py-4 text-sm text-muted-foreground">Headlines will appear here when a market source is available.</p>;
  return (
    <div className={cn(marketBriefingStyles.typography, "grid sm:grid-cols-2 sm:gap-x-6")}>
      {stories.map((row, index) => (
        <article key={row.url} className="min-w-0 border-b border-border/60 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
          <button type="button" onClick={() => openOneMarketHref(row.url)}
            className="group/news relative isolate flex min-h-[100px] w-full items-center gap-4 overflow-hidden rounded-sm py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <span className="min-w-0 flex-1">
              <span className={cn(marketBriefingStyles.newsTitle, "text-foreground transition-colors group-hover/news:text-[color:var(--one-link)]")}>{row.title}</span>
              <span className={marketBriefingStyles.newsMetadata}>{row.source_name || "Market news"} <span aria-hidden="true"> · </span> {formatHeadlinePublished(row.published_at)}</span>
              {row.summary ? <span className="mt-1 hidden text-xs leading-5 text-muted-foreground sm:line-clamp-1">{row.summary}</span> : null}
            </span>
            <OneMarketNewsCover row={row} index={index} thumbnail className="h-14 w-14 shrink-0 rounded-lg [&_img]:!h-full [&_img]:!w-full [&_img]:object-cover sm:h-16 sm:w-16" />
            <MaterialRipple variant="none" effect="fade" className="z-10" />
          </button>
        </article>
      ))}
    </div>
  );
}

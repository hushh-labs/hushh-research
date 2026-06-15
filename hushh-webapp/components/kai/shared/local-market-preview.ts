"use client";

import type { KaiHomeInsightsV2 } from "@/lib/services/api-service";

const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1"]);

type SearchParamsLike = {
  get(name: string): string | null;
};

type LocalKaiPreviewKind = "market" | "analysis" | "connect";

function normalizeHost(hostname?: string | null): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function isAllowedLocalPreviewRuntime(hostname?: string | null): boolean {
  const appEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
  const nodeEnvironment = process.env.NODE_ENV;
  const localRuntime =
    appEnvironment === "development" || nodeEnvironment !== "production";
  const host = normalizeHost(hostname);
  const localHostAllowed = host ? LOCAL_PREVIEW_HOSTS.has(host) : localRuntime;
  return localRuntime && localHostAllowed;
}

function localPreviewKind(searchParams?: SearchParamsLike | null): LocalKaiPreviewKind | null {
  const preview = searchParams?.get("preview");
  return preview === "market" || preview === "analysis" || preview === "connect" ? preview : null;
}

export function isLocalKaiPreviewRequest({
  pathname,
  searchParams,
  hostname,
}: {
  pathname?: string | null;
  searchParams?: SearchParamsLike | null;
  hostname?: string | null;
}): boolean {
  if (!isAllowedLocalPreviewRuntime(hostname)) return false;
  const path = String(pathname || "").trim();
  const preview = localPreviewKind(searchParams);
  if (path === "/kai" && preview) return true;
  if (path === "/kai/analysis" && preview === "analysis") return true;
  return false;
}

export function isLocalMarketPreviewRequest({
  pathname,
  searchParams,
  hostname,
}: {
  pathname?: string | null;
  searchParams?: SearchParamsLike | null;
  hostname?: string | null;
}): boolean {
  return (
    isAllowedLocalPreviewRuntime(hostname) &&
    String(pathname || "").trim() === "/kai" &&
    searchParams?.get("preview") === "market"
  );
}

export function isLocalAnalysisPreviewRequest({
  pathname,
  searchParams,
  hostname,
}: {
  pathname?: string | null;
  searchParams?: SearchParamsLike | null;
  hostname?: string | null;
}): boolean {
  if (!isAllowedLocalPreviewRuntime(hostname)) return false;
  const path = String(pathname || "").trim();
  return (
    searchParams?.get("preview") === "analysis" &&
    (path === "/kai" || path === "/kai/analysis")
  );
}

export function getLocalMarketPreviewPayload(): KaiHomeInsightsV2 {
  const now = new Date().toISOString();
  const sourceTags = ["local preview", "design review"];

  return {
    layout_version: "local-preview.v1",
    user_id: "local-market-preview",
    generated_at: now,
    stale: false,
    cache_age_seconds: 42,
    provider_status: {
      preview: "ready",
    },
    hero: {
      total_value: 487_240,
      day_change_value: 6_420,
      day_change_pct: 1.34,
      sparkline_points: [],
      as_of: now,
      source_tags: sourceTags,
      degraded: false,
      holdings_count: 12,
      portfolio_value_bucket: "premium-preview",
    },
    meta: {
      stale: false,
      cache_age_seconds: 42,
      cache_tier: "memory",
      warm_source: "request",
      market_mode: "personalized",
      provider_status: {
        preview: "ready",
      },
    },
    market_overview: [
      {
        label: "Market Status",
        value: "Open",
        delta_pct: null,
        as_of: now,
        source: "Preview schedule",
        degraded: false,
      },
      {
        label: "S&P 500",
        value: "725.43",
        delta_pct: -1.58,
        as_of: now,
        source: "Preview benchmark",
        degraded: false,
      },
      {
        label: "NASDAQ 100",
        value: "693.69",
        delta_pct: -2,
        as_of: now,
        source: "Preview benchmark",
        degraded: false,
      },
      {
        label: "DOW 30",
        value: "389.12",
        delta_pct: -1.12,
        as_of: now,
        source: "Preview benchmark",
        degraded: false,
      },
      {
        label: "RUSSELL 2000",
        value: "198.45",
        delta_pct: -0.85,
        as_of: now,
        source: "Preview benchmark",
        degraded: false,
      },
    ],
    pick_sources: [
      {
        id: "default",
        label: "Kai default list",
        kind: "default",
        state: "ready",
        is_default: true,
      },
      {
        id: "advisor-preview",
        label: "Advisor preview",
        kind: "ria",
        state: "ready",
        is_default: false,
      },
    ],
    active_pick_source: "default",
    pick_rows: [
      {
        symbol: "AAPL",
        quote_symbol: "AAPL",
        company_name: "Apple",
        sector: "Technology",
        tier: "ACE",
        tier_rank: 1,
        conviction_weight: 0.92,
        recommendation_bias: "quality compounder",
        investment_thesis:
          "Services durability and device ecosystem strength keep Apple in the core watchlist.",
        fcf_billions: 108.8,
        price: 189.2,
        change_pct: 1.1,
        volume: 84_200_000,
        market_cap: 3_290_000_000_000,
        source_tags: sourceTags,
        degraded: false,
        as_of: now,
      },
      {
        symbol: "NVDA",
        quote_symbol: "NVDA",
        company_name: "NVIDIA",
        sector: "Semiconductors",
        tier: "ACE",
        tier_rank: 2,
        conviction_weight: 0.89,
        recommendation_bias: "ai infrastructure",
        investment_thesis:
          "AI infrastructure demand keeps NVIDIA central to the current market leadership board.",
        fcf_billions: 28.1,
        price: 121.4,
        change_pct: -0.8,
        volume: 312_400_000,
        market_cap: 3_520_000_000_000,
        source_tags: sourceTags,
        degraded: false,
        as_of: now,
      },
      {
        symbol: "TSLA",
        quote_symbol: "TSLA",
        company_name: "Tesla",
        sector: "Consumer Discretionary",
        tier: "QUEEN",
        tier_rank: 3,
        conviction_weight: 0.68,
        recommendation_bias: "high beta",
        investment_thesis:
          "Tesla remains a volatile setup where position sizing matters as much as direction.",
        fcf_billions: 4.4,
        price: 248.5,
        change_pct: 5.2,
        volume: 198_700_000,
        market_cap: 589_000_000_000,
        source_tags: sourceTags,
        degraded: false,
        as_of: now,
      },
      {
        symbol: "AMZN",
        quote_symbol: "AMZN",
        company_name: "Amazon",
        sector: "Consumer Discretionary",
        tier: "KING",
        tier_rank: 4,
        conviction_weight: 0.78,
        recommendation_bias: "consumer platform",
        investment_thesis:
          "Amazon remains a high-quality platform name with marketplace, cloud, and logistics leverage.",
        fcf_billions: 48.2,
        price: 238,
        change_pct: 1.9,
        volume: 61_500_000,
        market_cap: 2_500_000_000_000,
        source_tags: sourceTags,
        degraded: false,
        as_of: now,
      },
    ],
    renaissance_list: [],
    movers: {
      gainers: [
        {
          symbol: "TSLA",
          company_name: "Tesla",
          price: 248.5,
          change_pct: 5.2,
          volume: 198_700_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "PG",
          company_name: "Procter & Gamble",
          price: 164.8,
          change_pct: 2.77,
          volume: 28_400_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "AMZN",
          company_name: "Amazon",
          price: 238,
          change_pct: 1.9,
          volume: 61_500_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "AAPL",
          company_name: "Apple",
          price: 189.2,
          change_pct: 1.1,
          volume: 84_200_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
      ],
      losers: [
        {
          symbol: "META",
          company_name: "Meta Platforms",
          price: 486.3,
          change_pct: -2.4,
          volume: 38_800_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "GOOGL",
          company_name: "Alphabet",
          price: 172.1,
          change_pct: -1.6,
          volume: 42_900_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "NVDA",
          company_name: "NVIDIA",
          price: 121.4,
          change_pct: -0.8,
          volume: 312_400_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "BUD",
          company_name: "Anheuser-Busch",
          price: 81.26,
          change_pct: -0.6,
          volume: 18_200_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
      ],
      active: [
        {
          symbol: "NVDA",
          company_name: "NVIDIA",
          price: 121.4,
          change_pct: -0.8,
          volume: 312_400_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "TSLA",
          company_name: "Tesla",
          price: 248.5,
          change_pct: 5.2,
          volume: 198_700_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "AAPL",
          company_name: "Apple",
          price: 189.2,
          change_pct: 1.1,
          volume: 84_200_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
        {
          symbol: "AMZN",
          company_name: "Amazon",
          price: 238,
          change_pct: 1.9,
          volume: 61_500_000,
          source_tags: sourceTags,
          degraded: false,
          as_of: now,
        },
      ],
      as_of: now,
      source_tags: sourceTags,
      degraded: false,
    },
    sector_rotation: [
      {
        sector: "Semiconductors",
        change_pct: 1.92,
        as_of: now,
        source_tags: sourceTags,
        degraded: false,
      },
      {
        sector: "Technology",
        change_pct: 1.08,
        as_of: now,
        source_tags: sourceTags,
        degraded: false,
      },
      {
        sector: "Consumer Discretionary",
        change_pct: -0.36,
        as_of: now,
        source_tags: sourceTags,
        degraded: false,
      },
    ],
    spotlights: [
      {
        symbol: "NVDA",
        company_name: "NVIDIA",
        price: 121.4,
        change_pct: -0.8,
        recommendation: "BUY",
        recommendation_detail:
          "AI infrastructure demand is still leading the tape.",
        recommendation_source: "Kai preview",
        story:
          "Strong semiconductor leadership keeps NVIDIA at the center of the current market read.",
        confidence: 0.84,
        headline: "AI infrastructure names lead the session",
        headline_url: "/kai/analysis?symbol=NVDA",
        headline_source: "Preview coverage",
        source_tags: sourceTags,
        as_of: now,
        degraded: false,
      },
      {
        symbol: "AAPL",
        company_name: "Apple",
        price: 189.2,
        change_pct: 1.1,
        recommendation: "HOLD",
        recommendation_detail:
          "Quality remains strong while near-term valuation needs discipline.",
        recommendation_source: "Kai preview",
        story:
          "Apple remains a core quality name with a steadier setup than the high-beta leaders.",
        confidence: 0.76,
        headline: "Quality tech stays bid as market breadth improves",
        headline_url: "/kai/analysis?symbol=AAPL",
        headline_source: "Preview coverage",
        source_tags: sourceTags,
        as_of: now,
        degraded: false,
      },
    ],
    themes: [
      {
        title: "AI infrastructure",
        subtitle: "Semiconductors and cloud leaders are carrying the strongest tape.",
        symbol: "NVDA",
        change_pct: 2.46,
        headline: "AI infrastructure leads",
        source_tags: sourceTags,
        degraded: false,
      },
      {
        title: "Quality compounders",
        subtitle: "Mega-cap balance sheets are anchoring the premium watchlist.",
        symbol: "AAPL",
        change_pct: 1.12,
        headline: "Quality stays resilient",
        source_tags: sourceTags,
        degraded: false,
      },
      {
        title: "Volatility watch",
        subtitle: "High-beta consumer names need tighter entry discipline.",
        symbol: "TSLA",
        change_pct: -0.84,
        headline: "High beta cools",
        source_tags: sourceTags,
        degraded: false,
      },
    ],
    news_tape: [
      {
        symbol: "YHOO",
        title: "IBM Thinks Your Data Is Too Stubborn to Move (and AI Can Fix That)",
        url: "/kai/analysis?symbol=IBM",
        published_at: now,
        source_name: "Yahoo Finance",
        provider: "local-preview",
        sentiment_hint: "positive",
        degraded: false,
      },
      {
        symbol: "BUD",
        title: "Anheuser-Busch Inbev SA Stock (BUD) Closed Up on Defensive Rotation",
        url: "/kai/analysis?symbol=BUD",
        published_at: now,
        source_name: "TradingKey",
        provider: "local-preview",
        sentiment_hint: "neutral",
        degraded: false,
      },
      {
        symbol: "KAI",
        title: "Defensives lead as indices slip - what it means for your portfolio",
        url: "/kai/analysis",
        published_at: now,
        source_name: "Kai Wrap",
        provider: "local-preview",
        sentiment_hint: "negative",
        degraded: false,
      },
    ],
    signals: [
      {
        id: "preview-ai-leadership",
        title: "Markets are soft today",
        summary: "Markets are soft today - defensives leading. Two of your holdings are in the red.",
        confidence: 0.82,
        source_tags: sourceTags,
        supporting_items: [
          { symbol: "NVDA", company_name: "NVIDIA" },
          { symbol: "MSFT", company_name: "Microsoft" },
        ],
        degraded: false,
      },
    ],
  };
}

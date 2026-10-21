import { getLocalMarketPreviewPayload } from "../../components/kai/shared/local-market-preview";
import type { KaiMarketNewsPage } from "../../lib/services/api-service";

// Only information, identity and transport are synthetic. The Market page,
// cards, shared typography and controls render their production components.
const payload = getLocalMarketPreviewPayload();
// Deliberately uneven name lengths expose rank drift between the two columns.
if (payload.movers) {
  payload.movers.degraded = true;
  for (const row of [...payload.movers.gainers, ...payload.movers.losers]) {
    row.degraded = true;
    row.as_of = "2026-10-21T14:00:00Z";
  }
  if (payload.movers.gainers[0]) payload.movers.gainers[0].company_name = "Tesla International Automotive and Energy Corporation";
}

payload.news_tape = [
  {
    symbol: "TEST",
    title: "A longer market headline stays readable on a narrow phone screen",
    source_name: "An unusually long market news publisher name",
    provider: "fixture",
    degraded: false,
    published_at: "2026-10-19T05:30:00Z",
    url: "https://example.com/market-news",
    summary: "Market context wraps inside the card without changing the surrounding page width.",
  },
  ...(payload.news_tape ?? []),
];

const isNewsFixture = () => window.location.pathname === "/finance-market-news-fixture";
const newsPage: KaiMarketNewsPage = {
  items: [
    {
      ...payload.news_tape![0],
      symbol: "NVDA MSFT",
      summary: "The full article summary remains readable without clipping, even when it takes several lines on a narrow phone screen.",
      sentiment_hint: "positive",
      image_url: "https://images.example.test/large.png",
      image_thumbnail_url: "https://images.example.test/small.png",
    },
    {
      ...payload.news_tape![0],
      symbol: "MARKET",
      title: "A second market story with a fallback photo",
      url: "https://example.com/market-news-fallback",
      sentiment_hint: "negative",
      image_thumbnail_url: "https://images.example.test/broken.png",
      image_url: "https://images.example.test/large.png",
    },
  ],
  next_cursor: "next-news-page",
  has_more: true,
  snapshot_id: "market-news-layout",
  generated_at: "2026-10-20T20:00:00Z",
  stale: false,
  cache: { tier: "memory", age_seconds: 20, hit: true },
  provider_status: {},
};

export function useAuth() { return { user: isNewsFixture() ? { uid: "market-news-layout" } : null, loading: false }; }
export function useVault() { return { vaultKey: null, vaultOwnerToken: null }; }
export function useStaleResource() {
  return { data: isNewsFixture() ? newsPage : payload, loading: false, refreshing: false, error: null,
    refresh: async () => { document.body.dataset.newsRefreshed = "true"; },
  };
}
export function useKaiFinancialResource() { return { data: null }; }
export const KaiFinancialResourceService = {};
export const KaiMarketHomeResourceService = { resolveTrackedSymbols: () => [] };
export const KaiMarketNewsResourceService = {
  getStaleFirst: async () => ({ ...newsPage, has_more: false, next_cursor: null, items: [{
    ...newsPage.items[0], title: "More headlines from the same snapshot", url: "https://example.com/market-news-more",
  }] }),
};
export class MarketNewsSnapshotChangedError extends Error {}
export function usePublishVoiceSurfaceMetadata() {}
export function useVoiceSurfaceControlTracking() {
  return { activeControlId: null, lastInteractedControlId: null };
}
export function usePathname() { return isNewsFixture() ? "/one/kai/news" : "/one/kai"; }
export function useSearchParams() { return new URLSearchParams(); }
export function useRouter() {
  return { push(href: string) { document.body.dataset.routerPush = href; } };
}
export async function ensureKaiVaultOwnerToken() {
  throw new Error("The Market layout fixture must not request owner authority.");
}

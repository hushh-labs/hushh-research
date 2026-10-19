import { getLocalMarketPreviewPayload } from "../../components/kai/shared/local-market-preview";

// Only information, identity and transport are synthetic. The Market page,
// cards, shared typography and controls render their production components.
const payload = getLocalMarketPreviewPayload();
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

export function useAuth() { return { user: null, loading: false }; }
export function useVault() { return { vaultKey: null, vaultOwnerToken: null }; }
export function useStaleResource() {
  return { data: payload, loading: false, refreshing: false, error: null };
}
export function useKaiFinancialResource() { return { data: null }; }
export const KaiFinancialResourceService = {};
export const KaiMarketHomeResourceService = {};
export function usePublishVoiceSurfaceMetadata() {}
export function useVoiceSurfaceControlTracking() {
  return { activeControlId: null, lastInteractedControlId: null };
}
export function usePathname() { return "/one/kai"; }
export function useSearchParams() { return new URLSearchParams(); }
export function useRouter() {
  return { push(href: string) { document.body.dataset.routerPush = href; } };
}
export async function ensureKaiVaultOwnerToken() {
  throw new Error("The Market layout fixture must not request owner authority.");
}

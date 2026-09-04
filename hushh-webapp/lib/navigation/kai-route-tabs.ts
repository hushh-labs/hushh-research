import {
  KAI_MARKET_PATH,
  ROUTES,
  buildKaiMarketRoute,
} from "@/lib/navigation/routes";

export const KAI_ROUTE_TABS = [
  {
    id: "market",
    label: "Market",
    href: buildKaiMarketRoute("market"),
    prefetchHref: buildKaiMarketRoute("market"),
  },
  {
    id: "dashboard",
    label: "Portfolio",
    href: buildKaiMarketRoute("portfolio"),
    prefetchHref: buildKaiMarketRoute("portfolio"),
  },
  {
    id: "analysis",
    label: "Analysis",
    href: buildKaiMarketRoute("analysis"),
    prefetchHref: buildKaiMarketRoute("analysis"),
  },
] as const;

export type KaiRouteTabId = (typeof KAI_ROUTE_TABS)[number]["id"];

export function activeKaiRouteTabFromPath(pathname: string): KaiRouteTabId {
  const [basePath, rawQuery = ""] = pathname.split("?", 2);
  const tab = new URLSearchParams(rawQuery).get("tab");
  if (basePath === KAI_MARKET_PATH) {
    if (tab === "portfolio") return "dashboard";
    if (tab === "analysis") return "analysis";
    return "market";
  }
  if (
    pathname === ROUTES.LEGACY_KAI_HOME ||
    pathname.startsWith(`${ROUTES.LEGACY_KAI_HOME}?`)
  ) {
    return "market";
  }
  if (
    pathname.startsWith(ROUTES.LEGACY_KAI_ANALYSIS) ||
    pathname.startsWith("/kai/dashboard/analysis") ||
    pathname.startsWith("/one/kai/dashboard/analysis")
  ) {
    return "analysis";
  }
  if (
    pathname.startsWith(ROUTES.LEGACY_KAI_PORTFOLIO) ||
    pathname.startsWith("/kai/dashboard") ||
    pathname.startsWith("/one/kai/dashboard")
  ) {
    return "dashboard";
  }
  return "market";
}

export function getAdjacentKaiRouteHref(
  pathname: string,
  direction: "next" | "prev",
): string | null {
  const activeTab = activeKaiRouteTabFromPath(pathname);
  const currentIndex = KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab);
  if (currentIndex < 0) return null;
  const targetIndex =
    direction === "next" ? currentIndex + 1 : currentIndex - 1;
  const target = KAI_ROUTE_TABS[targetIndex];
  return target ? target.href : null;
}

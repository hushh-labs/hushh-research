import { ROUTES } from "@/lib/navigation/routes";

export const KAI_ROUTE_TABS = [
  { id: "market", label: "Market", href: ROUTES.KAI_HOME, prefetchHref: ROUTES.KAI_HOME },
  {
    id: "dashboard",
    label: "Portfolio",
    href: ROUTES.KAI_DASHBOARD,
    prefetchHref: ROUTES.KAI_DASHBOARD,
  },
  {
    id: "connect",
    label: "Connect",
    href: ROUTES.MARKETPLACE,
    prefetchHref: ROUTES.MARKETPLACE,
  },
  {
    id: "analysis",
    label: "Analysis",
    href: `${ROUTES.KAI_ANALYSIS}?tab=history`,
    prefetchHref: ROUTES.KAI_ANALYSIS,
  },
] as const;

export type KaiRouteTabId = (typeof KAI_ROUTE_TABS)[number]["id"];

export function activeKaiRouteTabFromPath(pathname: string): KaiRouteTabId {
  if (pathname.startsWith(ROUTES.MARKETPLACE)) return "connect";
  if (pathname === ROUTES.KAI_HOME || pathname.startsWith(`${ROUTES.KAI_HOME}?`)) return "market";
  if (pathname.startsWith(ROUTES.KAI_ANALYSIS) || pathname.startsWith("/kai/dashboard/analysis")) {
    return "analysis";
  }
  if (
    pathname.startsWith(ROUTES.KAI_DASHBOARD) ||
    pathname.startsWith(ROUTES.KAI_INVESTMENTS) ||
    pathname.startsWith(ROUTES.KAI_FUNDING_TRADE) ||
    pathname.startsWith("/kai/dashboard") ||
    pathname.startsWith(ROUTES.KAI_OPTIMIZE)
  ) {
    return "dashboard";
  }
  return "market";
}

export function getAdjacentKaiRouteHref(
  pathname: string,
  direction: "next" | "prev"
): string | null {
  const activeTab = activeKaiRouteTabFromPath(pathname);
  const currentIndex = KAI_ROUTE_TABS.findIndex((tab) => tab.id === activeTab);
  if (currentIndex < 0) return null;
  const targetIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  const target = KAI_ROUTE_TABS[targetIndex];
  return target ? target.href : null;
}

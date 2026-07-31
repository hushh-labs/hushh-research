import { ROUTES } from "@/lib/navigation/routes";

export const RIA_ROUTE_TABS = [
  { id: "home", label: "Home", href: ROUTES.RIA_HOME },
  { id: "clients", label: "Clients", href: ROUTES.RIA_CLIENTS },
  { id: "connect", label: "Connect", href: ROUTES.MARKETPLACE },
  { id: "picks", label: "Picks", href: ROUTES.RIA_PICKS },
] as const;

export type RiaRouteTabId = (typeof RIA_ROUTE_TABS)[number]["id"];

export function activeRiaRouteTabFromPath(pathname: string): RiaRouteTabId {
  if (pathname.startsWith(ROUTES.MARKETPLACE)) return "connect";
  if (pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}?`)) return "home";
  if (pathname.startsWith(ROUTES.RIA_CLIENTS) || pathname === ROUTES.RIA_WORKSPACE) {
    return "clients";
  }
  if (pathname.startsWith(ROUTES.RIA_PICKS)) {
    return "picks";
  }
  return "home";
}

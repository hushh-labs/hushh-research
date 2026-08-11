import { ROUTES } from "@/lib/navigation/routes";

export const RIA_ROUTE_TABS = [
  { id: "profile", label: "Profile", href: ROUTES.RIA_PROFILE },
  { id: "clients", label: "Clients", href: ROUTES.RIA_CLIENTS },
  { id: "picks", label: "Picks", href: ROUTES.RIA_PICKS },
] as const;

export type RiaRouteTabId = (typeof RIA_ROUTE_TABS)[number]["id"];

export function activeRiaRouteTabFromPath(pathname: string): RiaRouteTabId {
  if (
    pathname === ROUTES.RIA_HOME ||
    pathname.startsWith(`${ROUTES.RIA_HOME}?`) ||
    pathname === ROUTES.RIA_PROFILE ||
    pathname.startsWith(`${ROUTES.RIA_PROFILE}?`)
  )
    return "profile";
  if (
    pathname.startsWith(ROUTES.RIA_CLIENTS) ||
    pathname === ROUTES.RIA_WORKSPACE
  ) {
    return "clients";
  }
  if (pathname.startsWith(ROUTES.RIA_PICKS)) {
    return "picks";
  }
  return "profile";
}

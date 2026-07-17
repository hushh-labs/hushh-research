import {
  activeKaiRouteTabFromPath,
  KAI_ROUTE_TABS,
} from "@/lib/navigation/kai-route-tabs";
import {
  activeRiaRouteTabFromPath,
  RIA_ROUTE_TABS,
} from "@/lib/navigation/ria-route-tabs";
import { ROUTES } from "@/lib/navigation/routes";

export type WorkspaceTopTab = {
  id: string;
  label: string;
  href: string;
};

export type WorkspaceTopTabSet = {
  label: "Finance" | "RIA";
  tabs: readonly WorkspaceTopTab[];
  activeId: string;
};

function belongsTo(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function resolveWorkspaceTopTabs(
  pathname: string | null | undefined,
): WorkspaceTopTabSet | null {
  const normalized = pathname?.split(/[?#]/, 1)[0] || "";

  if (
    belongsTo(normalized, ROUTES.KAI_HOME) ||
    belongsTo(normalized, ROUTES.LEGACY_KAI_HOME)
  ) {
    return {
      label: "Finance",
      tabs: KAI_ROUTE_TABS,
      activeId: activeKaiRouteTabFromPath(normalized || ROUTES.KAI_HOME),
    };
  }

  if (belongsTo(normalized, ROUTES.RIA_HOME)) {
    return {
      label: "RIA",
      tabs: RIA_ROUTE_TABS,
      activeId: activeRiaRouteTabFromPath(normalized || ROUTES.RIA_HOME),
    };
  }

  return null;
}

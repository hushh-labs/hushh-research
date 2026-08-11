export interface TopShellTab {
  value: string;
  label: string;
  href: string;
}

import {
  buildKaiMarketRoute,
  KAI_MARKET_PATH,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  activeRiaRouteTabFromPath,
  RIA_ROUTE_TABS,
} from "@/lib/navigation/ria-route-tabs";

export type TopShellTabSetId =
  "location" | "finance" | "consent" | "ria" | "public";

export interface TopShellTabDefinition {
  id: TopShellTabSetId;
  label: string;
  queryParam: "view" | "tab" | null;
  defaultValue: string;
  tabs: readonly TopShellTab[];
}

export interface TopShellTabSet {
  id: TopShellTabSetId;
  label: string;
  queryParam: "view" | "tab" | null;
  activeValue: string;
  tabs: readonly TopShellTab[];
}

const RIA_TOP_SHELL_TABS: readonly TopShellTab[] = RIA_ROUTE_TABS.map(
  ({ id, label, href }) => ({ value: id, label, href }),
);

/**
 * Returns the preceding route-owned tab, if the current tab has one. This is
 * intentionally derived from the shared tab registry rather than browser
 * history so a deep-linked workspace still has deterministic back behavior.
 */
export type PublicKnowledgeTab = "research" | "blog" | "developers";
export type ConsentCenterTab =
  "requests" | "active" | "history" | "connections";

export function buildPublicKnowledgeRoute(tab: PublicKnowledgeTab): string {
  return `${ROUTES.WELCOME}?tab=${tab}`;
}

/**
 * A Consent Center tab switch deliberately drops list/search/detail state.
 * Keep only the route-owned advisor context and a verified in-app return link.
 */
export function buildConsentCenterTabRoute(
  tab: ConsentCenterTab,
  searchParams: URLSearchParams,
): string {
  const params = new URLSearchParams({ tab });
  if (
    searchParams.get("actor") === "ria" &&
    searchParams.get("view") === "outgoing"
  ) {
    params.set("actor", "ria");
    params.set("view", "outgoing");
  }
  const from = searchParams.get("from");
  if (from?.startsWith("/") && !from.startsWith("//")) {
    params.set("from", from);
  }
  return `${ROUTES.CONSENTS}?${params.toString()}`;
}

/**
 * The only authored contextual-tab registry. The fixed top shell and the
 * corresponding route bodies consume these same definitions so labels,
 * values, query parameters, and destinations cannot drift apart.
 */
export const TOP_SHELL_TAB_REGISTRY = {
  location: {
    id: "location",
    label: "Location",
    queryParam: "view",
    defaultValue: "now",
    tabs: [
      { value: "now", label: "Now", href: "/one/location" },
      {
        value: "people",
        label: "People",
        href: "/one/location?view=people",
      },
      { value: "links", label: "Links", href: "/one/location?view=links" },
    ],
  },
  finance: {
    id: "finance",
    label: "Finance",
    queryParam: "tab",
    defaultValue: "market",
    tabs: [
      {
        value: "market",
        label: "Market",
        href: buildKaiMarketRoute("market"),
      },
      {
        value: "portfolio",
        label: "Portfolio",
        href: buildKaiMarketRoute("portfolio"),
      },
      {
        value: "analysis",
        label: "Analysis",
        href: buildKaiMarketRoute("analysis"),
      },
    ],
  },
  consent: {
    id: "consent",
    label: "Consent Center",
    queryParam: "tab",
    defaultValue: "requests",
    tabs: [
      {
        value: "requests",
        label: "Requests",
        href: `${ROUTES.CONSENTS}?tab=requests`,
      },
      {
        value: "active",
        label: "Active",
        href: `${ROUTES.CONSENTS}?tab=active`,
      },
      {
        value: "history",
        label: "History",
        href: `${ROUTES.CONSENTS}?tab=history`,
      },
      {
        value: "connections",
        label: "Connections",
        href: `${ROUTES.CONSENTS}?tab=connections`,
      },
    ],
  },
  ria: {
    id: "ria",
    label: "RIA workspace",
    queryParam: null,
    // `/ria` is a compatibility redirect; Profile is the actual first tab.
    defaultValue: "profile",
    tabs: RIA_TOP_SHELL_TABS,
  },
  public: {
    id: "public",
    label: "Explore",
    queryParam: "tab",
    defaultValue: "research",
    tabs: [
      {
        value: "research",
        label: "Research",
        href: buildPublicKnowledgeRoute("research"),
      },
      { value: "blog", label: "Blog", href: buildPublicKnowledgeRoute("blog") },
      {
        value: "developers",
        label: "Developers",
        href: buildPublicKnowledgeRoute("developers"),
      },
    ],
  },
} as const satisfies Record<TopShellTabSetId, TopShellTabDefinition>;

export function resolveRegisteredTopShellTabValue(
  definition: TopShellTabDefinition,
  value: string | null | undefined,
): string {
  return resolveSelection(
    definition.tabs,
    value ?? null,
    definition.defaultValue,
  );
}

function splitRouteKey(routeKey: string): {
  pathname: string;
  searchParams: URLSearchParams;
} {
  const [pathnameWithHash, query = ""] = String(routeKey ?? "").split("?", 2);
  const rawPathname = (pathnameWithHash ?? "").split("#", 1)[0] || "/";
  // Capacitor's static export serves directory routes with a trailing slash.
  // Normalize before matching the authored registry so iOS/Android resolve the
  // same fixed tab shell as Next's non-static web router.
  const pathname =
    rawPathname === "/" ? "/" : rawPathname.replace(/\/+$/, "") || "/";
  return {
    pathname,
    searchParams: new URLSearchParams(query.split("#", 1)[0]),
  };
}

function resolveSelection(
  tabs: readonly TopShellTab[],
  value: string | null,
  fallback: string,
): string {
  return tabs.some((tab) => tab.value === value) ? (value as string) : fallback;
}

/**
 * Resolves the one route-owned contextual tab group for the shared top shell.
 * Direct links, shell clicks, and page swipes converge on this same selection.
 */
export function resolveTopShellTabSet(routeKey: string): TopShellTabSet | null {
  const { pathname, searchParams } = splitRouteKey(routeKey);

  if (pathname === "/one/location" && !searchParams.get("action")) {
    const definition = TOP_SHELL_TAB_REGISTRY.location;
    return {
      ...definition,
      activeValue: resolveRegisteredTopShellTabValue(
        definition,
        searchParams.get(definition.queryParam),
      ),
    };
  }

  if (pathname === KAI_MARKET_PATH) {
    const definition = TOP_SHELL_TAB_REGISTRY.finance;
    return {
      ...definition,
      activeValue: resolveRegisteredTopShellTabValue(
        definition,
        searchParams.get(definition.queryParam),
      ),
    };
  }

  if (pathname === ROUTES.CONSENTS) {
    const definition = TOP_SHELL_TAB_REGISTRY.consent;
    return {
      ...definition,
      activeValue: resolveRegisteredTopShellTabValue(
        definition,
        searchParams.get(definition.queryParam),
      ),
      tabs: definition.tabs.map((tab) => ({
        ...tab,
        href: buildConsentCenterTabRoute(
          tab.value as ConsentCenterTab,
          searchParams,
        ),
      })),
    };
  }

  if (
    pathname === ROUTES.RIA_HOME ||
    pathname === ROUTES.RIA_PROFILE ||
    pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`) ||
    pathname === ROUTES.RIA_CLIENTS ||
    pathname.startsWith(`${ROUTES.RIA_PICKS}/`) ||
    pathname === ROUTES.RIA_PICKS
  ) {
    const definition = TOP_SHELL_TAB_REGISTRY.ria;
    return {
      ...definition,
      activeValue: activeRiaRouteTabFromPath(pathname),
    };
  }

  return resolvePublicKnowledgeTopShellTabSet(routeKey);
}

/**
 * Public knowledge routes use the same fixed AppTopShell tab contract as
 * Location and Finance. Their standalone route policy still suppresses the
 * signed-in bottom shell; this only gives the top tab row one owner.
 */
export function resolvePublicKnowledgeTopShellTabSet(
  routeKey: string,
): TopShellTabSet | null {
  const { pathname: normalizedPathname, searchParams } =
    splitRouteKey(routeKey);
  const definition = TOP_SHELL_TAB_REGISTRY.public;
  const requestedHomeTab = searchParams.get(definition.queryParam);
  const activeValue =
    normalizedPathname === ROUTES.WELCOME &&
    definition.tabs.some((tab) => tab.value === requestedHomeTab)
      ? requestedHomeTab
      : normalizedPathname === ROUTES.RESEARCH ||
          normalizedPathname.startsWith(`${ROUTES.RESEARCH}/`)
        ? "research"
        : normalizedPathname === ROUTES.BLOG ||
            normalizedPathname.startsWith(`${ROUTES.BLOG}/`)
          ? "blog"
          : normalizedPathname === ROUTES.DEVELOPERS ||
              normalizedPathname.startsWith(`${ROUTES.DEVELOPERS}/`)
            ? "developers"
            : null;

  return activeValue ? { ...definition, activeValue } : null;
}

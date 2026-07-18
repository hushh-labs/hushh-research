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

export type TopShellTabSetId = "location" | "finance" | "public";

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

/**
 * Returns the preceding route-owned tab, if the current tab has one. This is
 * intentionally derived from the shared tab registry rather than browser
 * history so a deep-linked workspace still has deterministic back behavior.
 */
export type PublicKnowledgeTab = "research" | "blog" | "developers";

export function buildPublicKnowledgeRoute(tab: PublicKnowledgeTab): string {
  return `${ROUTES.WELCOME}?tab=${tab}`;
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
      { value: "inbox", label: "Inbox", href: "/one/location?view=inbox" },
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
  const pathname = (pathnameWithHash ?? "").split("#", 1)[0] || "/";
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

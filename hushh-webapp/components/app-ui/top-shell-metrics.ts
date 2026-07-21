import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";
import {
  resolveTopShellTabSet,
  type TopShellTabSet,
} from "@/lib/navigation/top-shell-tabs";
import { ROUTES } from "@/lib/navigation/routes";

export type TopContentOffsetMode = "normal" | "fullscreen-flow";
export type TopShellRouteProfileId =
  "hidden" | "fullscreen-flow" | "redirect" | "standard";

export interface TopShellMetrics {
  shellVisible: boolean;
  hasTabs: boolean;
  contentOffsetMode: TopContentOffsetMode;
}

export interface TopShellNavigationConfig {
  pathname: string;
  routeKey: string;
}

type VisibleTopShellRouteModelBase = {
  profileId: Exclude<TopShellRouteProfileId, "hidden">;
  brand?: "one";
  navigation: TopShellNavigationConfig;
  contentOffsetMode: TopContentOffsetMode;
};

export type TopShellRouteModel =
  | {
      mode: "hidden";
      profileId: "hidden";
      contentOffsetMode: "normal";
    }
  | (VisibleTopShellRouteModelBase & {
      mode: "bar";
    })
  | (VisibleTopShellRouteModelBase & {
      mode: "bar-with-tabs";
      tabs: TopShellTabSet;
    });

export interface TopShellRouteProfile {
  id: TopShellRouteProfileId;
  model: TopShellRouteModel;
  metrics: TopShellMetrics;
}

const HIDDEN_METRICS: TopShellMetrics = {
  shellVisible: false,
  hasTabs: false,
  contentOffsetMode: "normal",
};

const FULLSCREEN_METRICS: TopShellMetrics = {
  shellVisible: true,
  hasTabs: false,
  contentOffsetMode: "fullscreen-flow",
};

const DEFAULT_VISIBLE_METRICS: TopShellMetrics = {
  shellVisible: true,
  hasTabs: false,
  contentOffsetMode: "normal",
};

export function shouldHideTopShell(pathname: string): boolean {
  return resolveTopShellRouteProfile(pathname).id === "hidden";
}

export function isTopShellFullscreenFlowRoute(pathname: string): boolean {
  return resolveTopShellRouteProfile(pathname).id === "fullscreen-flow";
}

function splitRouteKey(routeKey: string): {
  pathname: string;
  normalizedRouteKey: string;
} {
  const [pathnameWithHash, query = ""] = String(routeKey ?? "").split("?", 2);
  const rawPathname = (pathnameWithHash ?? "").split("#", 1)[0] || "/";
  // Capacitor's static export resolves index routes with a trailing slash
  // (`/one/`). Shell identity must use the same canonical pathname as web so
  // the One brand and every route-derived chrome decision remain identical.
  const pathname =
    rawPathname === "/" ? "/" : rawPathname.replace(/\/+$/, "") || "/";
  const normalizedQuery = query.split("#", 1)[0];
  return {
    pathname,
    normalizedRouteKey: normalizedQuery
      ? `${pathname}?${normalizedQuery}`
      : pathname,
  };
}

export function shouldShowKaiTabsInTopShell(routeKey: string): boolean {
  return resolveTopShellTabSet(routeKey) !== null;
}

export function resolveTopShellRouteProfile(
  routeKey: string,
): TopShellRouteProfile {
  const { pathname, normalizedRouteKey } = splitRouteKey(routeKey);
  const tabs = resolveTopShellTabSet(normalizedRouteKey);
  const mode = resolveAppRouteLayoutMode(pathname);
  const navigation: TopShellNavigationConfig = {
    pathname,
    routeKey: normalizedRouteKey,
  };
  const brand = pathname === ROUTES.ONE_HOME ? ("one" as const) : undefined;

  switch (mode) {
    case "hidden":
      return {
        id: "hidden",
        model: {
          mode: "hidden",
          profileId: "hidden",
          contentOffsetMode: "normal",
        },
        metrics: HIDDEN_METRICS,
      };
    case "flow":
      return visibleProfile(
        "fullscreen-flow",
        navigation,
        tabs,
        brand,
        "fullscreen-flow",
      );
    case "redirect":
      return visibleProfile("redirect", navigation, tabs, brand);
    case "standard":
    default:
      return visibleProfile("standard", navigation, tabs, brand);
  }
}

function visibleProfile(
  id: Exclude<TopShellRouteProfileId, "hidden">,
  navigation: TopShellNavigationConfig,
  tabs: TopShellTabSet | null,
  brand?: "one",
  contentOffsetMode: TopContentOffsetMode = "normal",
): TopShellRouteProfile {
  const model: TopShellRouteModel = tabs
    ? {
        mode: "bar-with-tabs",
        profileId: id,
        navigation,
        contentOffsetMode,
        tabs,
        ...(brand ? { brand } : {}),
      }
    : {
        mode: "bar",
        profileId: id,
        navigation,
        contentOffsetMode,
        ...(brand ? { brand } : {}),
      };
  return {
    id,
    model,
    metrics: {
      ...(contentOffsetMode === "fullscreen-flow"
        ? FULLSCREEN_METRICS
        : DEFAULT_VISIBLE_METRICS),
      hasTabs: Boolean(tabs),
    },
  };
}

export function resolveTopShellMetrics(routeKey: string): TopShellMetrics {
  return resolveTopShellRouteProfile(routeKey).metrics;
}

export function resolveTopShellHeight(routeKey: string): string {
  return resolveTopShellMetrics(routeKey).shellVisible
    ? "var(--top-shell-reserved-height)"
    : "0px";
}

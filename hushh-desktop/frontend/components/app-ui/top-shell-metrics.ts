import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

export type TopContentOffsetMode = "normal" | "fullscreen-flow";
export type TopShellRouteProfileId =
  | "hidden"
  | "fullscreen-flow"
  | "redirect"
  | "standard";

export interface TopShellMetrics {
  shellVisible: boolean;
  hasTabs: boolean;
  contentOffsetMode: TopContentOffsetMode;
}

interface TopShellRouteProfile {
  id: TopShellRouteProfileId;
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

export function shouldShowKaiTabsInTopShell(_pathname: string): boolean {
  return false;
}

export function resolveTopShellRouteProfile(pathname: string): TopShellRouteProfile {
  const mode = resolveAppRouteLayoutMode(pathname);

  switch (mode) {
    case "hidden":
      return { id: "hidden", metrics: HIDDEN_METRICS };
    case "flow":
      return { id: "fullscreen-flow", metrics: FULLSCREEN_METRICS };
    case "redirect":
      return { id: "redirect", metrics: DEFAULT_VISIBLE_METRICS };
    case "standard":
    default:
      return { id: "standard", metrics: DEFAULT_VISIBLE_METRICS };
  }
}

export function resolveTopShellMetrics(pathname: string): TopShellMetrics {
  return resolveTopShellRouteProfile(pathname).metrics;
}

export function resolveTopShellHeight(pathname: string): string {
  return resolveTopShellMetrics(pathname).shellVisible
    ? "var(--top-shell-reserved-height)"
    : "0px";
}

// hushh-webapp/lib/navigation/top-shell-utils.ts
import { resolveAppRouteLayoutMode } from "@/lib/navigation/app-route-layout";

export type TopContentOffsetMode = "normal" | "fullscreen-flow";
export type TopShellRouteProfileId =
  | "hidden"
  | "fullscreen-flow"
  | "redirect"
  | "standard";

export interface TopShellMetrics {
  readonly shellVisible: boolean;
  readonly hasTabs: boolean;
  readonly contentOffsetMode: TopContentOffsetMode;
}

interface TopShellRouteProfile {
  id: TopShellRouteProfileId;
  metrics: TopShellMetrics;
}

/**
 * Core metrics are frozen to prevent accidental mutation 
 * within the Hushh UI layer.
 */
const HIDDEN_METRICS: TopShellMetrics = Object.freeze({
  shellVisible: false,
  hasTabs: false,
  contentOffsetMode: "normal",
});

const FULLSCREEN_METRICS: TopShellMetrics = Object.freeze({
  shellVisible: true,
  hasTabs: false,
  contentOffsetMode: "fullscreen-flow",
});

const DEFAULT_VISIBLE_METRICS: TopShellMetrics = Object.freeze({
  shellVisible: true,
  hasTabs: false,
  contentOffsetMode: "normal",
});

/**
 * Simple resolution cache to prevent redundant path-parsing 
 * during a single render cycle.
 */
const resolutionCache = new Map<string, TopShellRouteProfile>();

/**
 * Resolves the profile and metrics for a given pathname.
 * Includes a small cache-management strategy to keep memory usage low.
 */
export function resolveTopShellRouteProfile(pathname: string): TopShellRouteProfile {
  if (resolutionCache.has(pathname)) {
    return resolutionCache.get(pathname)!;
  }

  const mode = resolveAppRouteLayoutMode(pathname);
  let profile: TopShellRouteProfile;

  switch (mode) {
    case "hidden":
      profile = { id: "hidden", metrics: HIDDEN_METRICS };
      break;
    case "flow":
      profile = { id: "fullscreen-flow", metrics: FULLSCREEN_METRICS };
      break;
    case "redirect":
      profile = { id: "redirect", metrics: DEFAULT_VISIBLE_METRICS };
      break;
    default:
      profile = { id: "standard", metrics: DEFAULT_VISIBLE_METRICS };
  }

  // Prevent memory leaks: Keep the cache small (e.g., last 50 unique paths)
  if (resolutionCache.size > 50) {
    resolutionCache.clear();
  }

  resolutionCache.set(pathname, profile);
  return profile;
}

export function shouldHideTopShell(pathname: string): boolean {
  return resolveTopShellRouteProfile(pathname).id === "hidden";
}

export function isTopShellFullscreenFlowRoute(pathname: string): boolean {
  return resolveTopShellRouteProfile(pathname).id === "fullscreen-flow";
}

/**
 * Dynamically resolves tab visibility based on the route profile.
 */
export function shouldShowKaiTabsInTopShell(pathname: string): boolean {
  return resolveTopShellRouteProfile(pathname).metrics.hasTabs;
}

export function resolveTopShellMetrics(pathname: string): TopShellMetrics {
  return resolveTopShellRouteProfile(pathname).metrics;
}

/**
 * Resolves height for CSS layout. 
 * Includes a fallback to 64px to ensure the Hushh web app doesn't 
 * collapse if CSS variables are undefined.
 */
export function resolveTopShellHeight(pathname: string): string {
  const { shellVisible } = resolveTopShellMetrics(pathname);
  return shellVisible
    ? "var(--top-shell-reserved-height, 64px)"
    : "0px";
}
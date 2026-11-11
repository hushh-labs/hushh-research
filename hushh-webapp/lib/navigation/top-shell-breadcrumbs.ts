// lib/navigation/top-shell-breadcrumbs.ts
//
// Public entry point for resolving the top-shell's back target + breadcrumb
// trail for a given pathname+searchParams. The actual per-route resolution
// lives in the declarative graph at lib/navigation/back-navigation-graph.ts —
// this file is now a thin wrapper: it resolves against that graph, then
// applies the one cross-cutting policy that isn't itself a graph node (the
// "setupDismissed" rewrite below, which can apply to ANY route's answer).

import { isOneSetupSurfaceRoute, ROUTES } from "@/lib/navigation/routes";
import {
  normalizeBreadcrumbPathname,
  walkBackNavigationGraph,
} from "@/lib/navigation/back-navigation-graph";

export { resolveSmsContactsBackAction } from "@/lib/navigation/back-navigation-graph";

export type TopShellBreadcrumbItem = {
  label: string;
  href?: string;
};

export type TopShellBreadcrumbConfig = {
  backHref: string;
  backLabel?: string;
  items: TopShellBreadcrumbItem[];
  width?: "content" | "profile" | "mutuals";
  align?: "start" | "center";
  /**
   * Keep an agent-owned page heading out of the compact top bar even after a
   * scroll observer offers a fallback chip.
   */
  suppressFallbackTitle?: boolean;
  /**
   * Suppress the top-bar back button for this route while keeping the rest of
   * the breadcrumb/title chrome. Used by the onboarding entry screen: until the
   * user has explicitly skipped or continued into a step, there is no confirmed
   * "previous" destination (back-before-/one would be logically wrong), so we
   * show no back affordance at all.
   */
  hideBack?: boolean;
};

/**
 * Keep the visible top-bar trail to immediate context only.
 *
 * Resolvers retain their complete hierarchy for deterministic back navigation,
 * but rendering more than the parent and current page crowds the compact app
 * bar and turns every ancestor into a truncated fragment. The app root remains
 * implicit on inner One routes, matching the existing top-shell convention.
 */
export function visibleTopShellBreadcrumbItems(
  items: TopShellBreadcrumbItem[],
): TopShellBreadcrumbItem[] {
  const cleaned = items.filter(
    (item) => typeof item.label === "string" && item.label.trim().length > 0,
  );
  const withoutImplicitRoot =
    cleaned[0]?.label === "One" ? cleaned.slice(1) : cleaned;
  return withoutImplicitRoot.slice(-2);
}

export type TopShellTitleSlot<TTitle> =
  | { kind: "trail"; items: TopShellBreadcrumbItem[] }
  | { kind: "title"; title: TTitle }
  | { kind: "none" };

/**
 * Decides what fills the top bar's title slot.
 *
 * A route with a visible breadcrumb trail is a nested route: it shows its back
 * arrow with the trail beside it, and nothing replaces that trail, at rest or
 * scrolled. The shell's fallback title (the scroll-collapsed chip) only fills a
 * bar that has no trail of its own.
 *
 * It used to be the other way round. Scrolling a nested route's page header out
 * of view swapped "Memory" beside the back arrow for a centred folder-and-Memory
 * chip, and on Profile > Memory for a "Profile" chip, while Feed and Connect,
 * which have no page header to scroll away, never changed. One screen, one
 * title, and the trail's last crumb is that title
 * (docs/reference/quality/app-surface-design-system.md).
 */
export function resolveTopShellTitleSlot<TTitle>(
  breadcrumb:
    | Pick<TopShellBreadcrumbConfig, "items" | "suppressFallbackTitle">
    | null
    | undefined,
  fallbackTitle: TTitle | null,
): TopShellTitleSlot<TTitle> {
  const items = visibleTopShellBreadcrumbItems(breadcrumb?.items ?? []);
  if (items.length > 0) return { kind: "trail", items };
  if (breadcrumb?.suppressFallbackTitle) return { kind: "none" };
  if (fallbackTitle) return { kind: "title", title: fallbackTitle };
  return { kind: "none" };
}

export interface ResolveTopShellBreadcrumbOptions {
  /**
   * True once the user has dismissed onboarding (finished/skipped setup, or the
   * backend/latch reports it). When set, a product/agent surface must never send
   * BACK into the setup funnel — stale `?from=/one/setup` markers and hardcoded
   * setup defaults are rewritten to ONE_HOME. Setup-internal pages keep their
   * retrace to the hub so the first onboarding pass is unchanged.
   */
  setupDismissed?: boolean;
  /** Public display metadata supplied by the loaded CRM registry. */
  connectedSystemLabel?: string | null;
}

export function resolveTopShellBreadcrumb(
  pathname: string,
  searchParams?: URLSearchParams | { get(name: string): string | null } | null,
  options?: ResolveTopShellBreadcrumbOptions,
): TopShellBreadcrumbConfig | null {
  const config = walkBackNavigationGraph(pathname, searchParams, {
    connectedSystemLabel: options?.connectedSystemLabel,
  });
  if (!config) return config;
  // One's Finance tile carries its origin, so Back works before a local setup
  // hint hydrates. A bare first-run setup entry must still retrace to the hub.
  const here = normalizeBreadcrumbPathname(pathname);
  if (here === ROUTES.ONE_SETUP_FINANCE || here === ROUTES.ONE_SETUP_KAI) {
    const backPath = normalizeBreadcrumbPathname(config.backHref);
    if (backPath === ROUTES.ONE_HOME || options?.setupDismissed) {
      return {
        ...config,
        backHref: isOneSetupSurfaceRoute(backPath) ? ROUTES.ONE_HOME : config.backHref,
        // Re-entry can briefly cross this admission route before the Finance
        // workspace. Keep the same back-only chrome through that handoff.
        suppressFallbackTitle: true,
        items: [],
      };
    }
    return config;
  }
  if (!options?.setupDismissed) return config;
  // Once onboarding is dismissed, other product/agent surfaces must not send
  // Back into the setup funnel. Setup-internal pages retain their retrace.
  if (isOneSetupSurfaceRoute(here)) return config;
  const backPath = config.backHref
    ? normalizeBreadcrumbPathname(config.backHref)
    : null;
  if (backPath && isOneSetupSurfaceRoute(backPath)) {
    return { ...config, backHref: ROUTES.ONE_HOME };
  }
  return config;
}

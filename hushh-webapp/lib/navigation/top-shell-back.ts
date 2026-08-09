import {
  consumeSectionOrigin,
  isSectionRoot,
  readSectionOrigin,
} from "@/lib/navigation/section-back-origin";
import {
  resolveTopShellBreadcrumb,
  type TopShellBreadcrumbConfig,
} from "@/lib/navigation/top-shell-breadcrumbs";
import { ROUTES } from "@/lib/navigation/routes";

type SearchParamsLike = { get(name: string): string | null } | null | undefined;

export type TopShellBackAction = {
  href: string;
  mode: "push" | "replace";
};

/**
 * The one deterministic back action shared by the visible top-bar control and
 * native edge gestures. It still never uses browser history: that stack carries
 * external origins (on iOS it would eject the person out of the app, and
 * WKWebView has no native stack for Next routes at all), and query-only flows
 * must close in place without becoming re-openable OS-back entries.
 *
 * Inside a section the authored parent is already correct and needs no memory:
 * Analysis climbs to Kai, Kai climbs to One, exactly as declared. The one
 * thing the hierarchy cannot know is which section the person crossed in from,
 * and that is where back used to strand them -- One home is what *contains*
 * Location, so entering Location from Finance and pressing back landed on
 * home. `?from=` was the only origin signal and almost nothing wrote it, so
 * whether back retraced depended on the entry point.
 *
 * So a section root leaves for its recorded origin, and every other route
 * climbs. See lib/navigation/section-back-origin.ts.
 */
export function resolveTopShellBackAction(params: {
  pathname: string;
  searchParams?: SearchParamsLike;
  breadcrumb?: TopShellBreadcrumbConfig | null;
  /**
   * Override the recorded section origin. `undefined` reads it, `null` forces
   * the authored parent. A test seam; production callers pass nothing.
   */
  sectionOrigin?: string | null;
}): TopShellBackAction | null {
  const breadcrumb =
    params.breadcrumb ??
    resolveTopShellBreadcrumb(params.pathname, params.searchParams);
  // Unchanged on purpose: the iOS edge-back gesture enables itself from whether
  // this returns an action, so when back exists must not shift.
  if (!breadcrumb || breadcrumb.hideBack) return null;

  const profilePanelOpen =
    params.pathname === ROUTES.PROFILE &&
    Boolean(
      params.searchParams?.get("panel") || params.searchParams?.get("detail"),
    );
  const locationActionOpen =
    params.pathname === ROUTES.ONE_LOCATION &&
    Boolean(params.searchParams?.get("action")?.trim());

  // An open panel or action sheet closes in place. It is a query-only state on
  // the same screen, never a step in the trail, so it must not retrace.
  if (profilePanelOpen || locationActionOpen) {
    return { href: breadcrumb.backHref, mode: "replace" };
  }

  // Only the section root leaves the section. Everywhere else the declared
  // parent already climbs the hierarchy correctly, which is why nothing is
  // stored for moves inside a section.
  if (!isSectionRoot(params.pathname)) {
    return { href: breadcrumb.backHref, mode: "push" };
  }

  const origin =
    params.sectionOrigin === undefined
      ? readSectionOrigin(params.pathname)
      : params.sectionOrigin;

  return { href: origin || breadcrumb.backHref, mode: "push" };
}

export function navigateTopShellBack(params: {
  pathname: string;
  searchParams?: SearchParamsLike;
  breadcrumb?: TopShellBreadcrumbConfig | null;
  sectionOrigin?: string | null;
  navigate: (action: TopShellBackAction) => void;
}): boolean {
  const action = resolveTopShellBackAction(params);
  if (!action) return false;
  // Leaving a section spends its origin, so a later return records a fresh
  // one instead of retracing to a route the person has long left. Closing an
  // overlay is a `replace` on the same screen and spends nothing.
  if (action.mode === "push" && isSectionRoot(params.pathname)) {
    consumeSectionOrigin(params.pathname);
  }
  params.navigate(action);
  return true;
}

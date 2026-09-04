import {
  consumeDestinationOrigin,
  isDestinationRoot,
  readDestinationOrigin,
} from "@/lib/navigation/section-back-origin";
import {
  resolveTopShellBreadcrumb,
  type TopShellBreadcrumbConfig,
} from "@/lib/navigation/top-shell-breadcrumbs";
import { isFocusedConnectCircleTask } from "@/lib/navigation/connect-routes";
import { ROUTES } from "@/lib/navigation/routes";

type SearchParamsLike = { get(name: string): string | null } | null | undefined;

export type TopShellBackAction = {
  href: string;
  mode: "push" | "replace";
  /**
   * `full` crossfades the whole app shell; `contextual` commits in place.
   *
   * Leaving a Location flow (`?action=…` → the hub) never changes the
   * pathname — it is the same screen with a different query, which the route
   * transition driver already refuses to fade for links and history writes.
   * Sending it through the full envelope made back cost a 300ms exit beat
   * before the router was even called, and any navigation that arrived inside
   * that window superseded the back and dropped it. So the rule that decides
   * whether a href is a screen switch lives here, next to the rule that
   * decides where back goes.
   */
  transitionMode: "full" | "contextual";
};

function pathnameOf(href: string): string {
  const path = href.split("#")[0]?.split("?")[0] ?? href;
  return path || href;
}

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
  // The same shape, on Connect. Circles moved there (#5458) and brought their
  // `?action=` flows with them, but this test named one pathname literally --
  // so on Connect the flow fell through to the section-root branch below and
  // the back arrow returned to wherever the person had entered Connect FROM,
  // throwing them out of the workspace instead of closing the Circle. There is
  // no other way out: `CreateCircleFlow` and `JoinCircleFlow` pass no `onBack`
  // to their header, so the shell's arrow is the only control on the screen.
  const connectCircleFlowOpen =
    params.pathname === ROUTES.CONNECT &&
    isFocusedConnectCircleTask(
      params.searchParams?.get("tab") ?? null,
      params.searchParams?.get("action") ?? null,
      params.searchParams?.get("circleId") ?? null,
    );

  const action = (
    href: string,
    mode: TopShellBackAction["mode"],
  ): TopShellBackAction => ({
    href,
    mode,
    transitionMode:
      pathnameOf(href) === params.pathname ? "contextual" : "full",
  });

  // An open panel or action sheet closes in place. It is a query-only state on
  // the same screen, never a step in the trail, so it must not retrace.
  if (profilePanelOpen || locationActionOpen || connectCircleFlowOpen) {
    return action(breadcrumb.backHref, "replace");
  }

  // Only the section root leaves the section. Everywhere else the declared
  // parent already climbs the hierarchy correctly, which is why nothing is
  // stored for moves inside a section.
  if (!isDestinationRoot(params.pathname)) {
    return action(breadcrumb.backHref, "push");
  }

  const origin =
    params.sectionOrigin === undefined
      ? readDestinationOrigin(params.pathname)
      : params.sectionOrigin;

  return action(origin || breadcrumb.backHref, "push");
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
  if (action.mode === "push" && isDestinationRoot(params.pathname)) {
    consumeDestinationOrigin(params.pathname);
  }
  params.navigate(action);
  return true;
}

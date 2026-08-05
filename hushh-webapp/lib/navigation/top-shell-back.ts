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
 * native edge gestures. It intentionally does not use browser history: a
 * nested route's authored parent is more reliable than a transient route
 * stack, and query-only flows must close in place without becoming re-openable
 * OS-back entries.
 */
export function resolveTopShellBackAction(params: {
  pathname: string;
  searchParams?: SearchParamsLike;
  breadcrumb?: TopShellBreadcrumbConfig | null;
}): TopShellBackAction | null {
  const breadcrumb =
    params.breadcrumb ??
    resolveTopShellBreadcrumb(params.pathname, params.searchParams);
  if (!breadcrumb || breadcrumb.hideBack) return null;

  const profilePanelOpen =
    params.pathname === ROUTES.PROFILE &&
    Boolean(
      params.searchParams?.get("panel") || params.searchParams?.get("detail"),
    );
  const locationActionOpen =
    params.pathname === ROUTES.ONE_LOCATION &&
    Boolean(params.searchParams?.get("action")?.trim());

  return {
    href: breadcrumb.backHref,
    mode: profilePanelOpen || locationActionOpen ? "replace" : "push",
  };
}

export function navigateTopShellBack(params: {
  pathname: string;
  searchParams?: SearchParamsLike;
  breadcrumb?: TopShellBreadcrumbConfig | null;
  navigate: (action: TopShellBackAction) => void;
}): boolean {
  const action = resolveTopShellBackAction(params);
  if (!action) return false;
  params.navigate(action);
  return true;
}

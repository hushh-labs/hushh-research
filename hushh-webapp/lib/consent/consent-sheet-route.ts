import { ROUTES } from "@/lib/navigation/routes";
import type { ConsentCenterActor, ConsentCenterView } from "@/lib/services/consent-center-service";

export const CONSENT_SHEET_QUERY_KEY = "sheet";
export const CONSENT_SHEET_QUERY_VALUE = "consents";
export const CONSENT_SHEET_VIEW_QUERY_KEY = "consentView";
export const CONSENT_REQUEST_QUERY_KEY = "requestId";
export const CONSENT_BUNDLE_QUERY_KEY = "bundleId";
export const CONSENT_LEGACY_PANEL_QUERY_KEY = "panel";
export const CONSENT_LEGACY_PANEL_VALUE = "consents";
export const CONSENT_TAB_QUERY_KEY = "tab";

export type ConsentSheetView = "pending" | "active" | "previous";
export type ConsentCenterManagerView = Extract<ConsentCenterView, "incoming" | "outgoing">;
export type ConsentNavigationTarget =
  | {
      kind: "internal";
      href: string;
      pathname: string;
    }
  | {
      kind: "external";
      href: string;
    };

const INTERNAL_APP_ROUTE_PREFIXES = [
  ROUTES.HOME,
  ROUTES.CONSENTS,
  ROUTES.PROFILE,
  ROUTES.RIA_HOME,
  ROUTES.KAI_HOME,
  ROUTES.MARKETPLACE,
  ROUTES.DEVELOPERS,
  ROUTES.LOGIN,
  ROUTES.LOGOUT,
  "/portfolio",
  "/labs",
] as const;

export function normalizeConsentSheetView(value: string | null | undefined): ConsentSheetView {
  if (value === "active") return "active";
  if (value === "previous" || value === "history") return "previous";
  return "pending";
}

export function applyConsentSheetParams(
  params: URLSearchParams,
  options?: {
    view?: ConsentSheetView;
    ensurePrivacyTab?: boolean;
    requestId?: string;
    bundleId?: string;
  }
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  next.set(CONSENT_SHEET_QUERY_KEY, CONSENT_SHEET_QUERY_VALUE);
  next.delete(CONSENT_LEGACY_PANEL_QUERY_KEY);

  if (options?.ensurePrivacyTab) {
    next.set("tab", "privacy");
  }

  const normalizedView = normalizeConsentSheetView(options?.view);
  if (normalizedView === "pending") {
    next.delete(CONSENT_SHEET_VIEW_QUERY_KEY);
  } else {
    next.set(CONSENT_SHEET_VIEW_QUERY_KEY, normalizedView);
  }

  if (options?.requestId) {
    next.set(CONSENT_REQUEST_QUERY_KEY, options.requestId);
  } else {
    next.delete(CONSENT_REQUEST_QUERY_KEY);
  }

  if (options?.bundleId) {
    next.set(CONSENT_BUNDLE_QUERY_KEY, options.bundleId);
  } else {
    next.delete(CONSENT_BUNDLE_QUERY_KEY);
  }

  return next;
}

export function clearConsentSheetParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  next.delete(CONSENT_SHEET_QUERY_KEY);
  next.delete(CONSENT_SHEET_VIEW_QUERY_KEY);
  next.delete(CONSENT_REQUEST_QUERY_KEY);
  next.delete(CONSENT_BUNDLE_QUERY_KEY);
  if (next.get(CONSENT_LEGACY_PANEL_QUERY_KEY) === CONSENT_LEGACY_PANEL_VALUE) {
    next.delete(CONSENT_LEGACY_PANEL_QUERY_KEY);
  }
  return next;
}

export function buildConsentCenterHref(
  view: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
    from?: string;
    actor?: ConsentCenterActor;
    managerView?: ConsentCenterManagerView;
  }
): string {
  const params = new URLSearchParams();
  params.set(CONSENT_TAB_QUERY_KEY, normalizeConsentSheetView(view));
  if (options?.actor) {
    params.set("actor", options.actor);
  }
  if (options?.managerView) {
    params.set("view", options.managerView);
  }
  if (options?.requestId) {
    params.set(CONSENT_REQUEST_QUERY_KEY, options.requestId);
  }
  if (options?.bundleId) {
    params.set(CONSENT_BUNDLE_QUERY_KEY, options.bundleId);
  }
  if (options?.from) {
    params.set("from", options.from);
  }
  const query = params.toString();
  return query ? `${ROUTES.CONSENTS}?${query}` : ROUTES.CONSENTS;
}

function isKnownInternalAppPath(pathname: string): boolean {
  return INTERNAL_APP_ROUTE_PREFIXES.some((prefix) => {
    if (prefix === ROUTES.HOME) {
      return pathname === ROUTES.HOME;
    }
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

export function isInternalAppHref(href: string | null | undefined): boolean {
  const trimmed = String(href || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("/")) {
    return isKnownInternalAppPath(trimmed.split("?")[0] || trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    return isKnownInternalAppPath(parsed.pathname);
  } catch {
    return false;
  }
}

export function normalizeInternalAppHref(href: string | null | undefined): string | null {
  const trimmed = String(href || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && isKnownInternalAppPath(trimmed.split("?")[0] || trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!isKnownInternalAppPath(parsed.pathname)) {
      return trimmed;
    }
    const query = `${parsed.search || ""}${parsed.hash || ""}`;
    return `${parsed.pathname}${query}`;
  } catch {
    return trimmed;
  }
}

function appendFromIfNeeded(href: string, from: string | null | undefined): string {
  const safeFrom = normalizeInternalAppHref(from);
  if (!safeFrom || !href.startsWith(`${ROUTES.CONSENTS}`)) {
    return href;
  }
  const [rawPathPart = "", hashPart = ""] = href.split("#", 2);
  const pathPart = rawPathPart || href;
  const [pathname, queryPart = ""] = pathPart.split("?", 2);
  if (pathname !== ROUTES.CONSENTS) {
    return href;
  }
  const params = new URLSearchParams(queryPart);
  if (!params.get("from")) {
    params.set("from", safeFrom);
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hashPart ? `#${hashPart}` : ""}`;
}

export function resolveConsentRequestHref(
  href: string | null | undefined,
  fallbackView: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
    actor?: ConsentCenterActor;
    managerView?: ConsentCenterManagerView;
    from?: string;
  }
): string {
  const target =
    normalizeInternalAppHref(href) ||
    buildConsentCenterHref(fallbackView, {
      requestId: options?.requestId,
      bundleId: options?.bundleId,
      actor: options?.actor,
      managerView: options?.managerView,
      from: options?.from,
    });
  return appendFromIfNeeded(target, options?.from);
}

export function resolveConsentNavigationTarget(
  href: string | null | undefined,
  fallbackView: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
    actor?: ConsentCenterActor;
    managerView?: ConsentCenterManagerView;
    from?: string;
  }
): ConsentNavigationTarget {
  const nextHref = resolveConsentRequestHref(href, fallbackView, options);
  if (isInternalAppHref(nextHref)) {
    const [pathname] = nextHref.split("?", 1);
    return {
      kind: "internal",
      href: nextHref,
      pathname: pathname || ROUTES.HOME,
    };
  }
  return {
    kind: "external",
    href: nextHref,
  };
}

export function buildRiaConsentManagerHref(
  view: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
    from?: string;
  }
): string {
  return buildConsentCenterHref(view, {
    ...options,
    actor: "ria",
    managerView: "outgoing",
  });
}

export function buildConsentSheetProfileHref(
  view: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
  }
): string {
  return buildConsentCenterHref(view, options);
}

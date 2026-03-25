import { ROUTES } from "@/lib/navigation/routes";

export const CONSENT_SHEET_QUERY_KEY = "sheet";
export const CONSENT_SHEET_QUERY_VALUE = "consents";
export const CONSENT_SHEET_VIEW_QUERY_KEY = "consentView";
export const CONSENT_REQUEST_QUERY_KEY = "requestId";
export const CONSENT_BUNDLE_QUERY_KEY = "bundleId";
export const CONSENT_LEGACY_PANEL_QUERY_KEY = "panel";
export const CONSENT_LEGACY_PANEL_VALUE = "consents";

export type ConsentSheetView = "pending" | "active" | "previous";

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

export function buildConsentSheetProfileHref(
  view: ConsentSheetView = "pending",
  options?: {
    requestId?: string;
    bundleId?: string;
  }
): string {
  const params = applyConsentSheetParams(new URLSearchParams(), {
    ensurePrivacyTab: true,
    view,
    requestId: options?.requestId,
    bundleId: options?.bundleId,
  });
  const query = params.toString();
  return query ? `${ROUTES.PROFILE}?${query}` : ROUTES.PROFILE;
}

import { redirect } from "next/navigation";

import {
  buildConsentSheetProfileHref,
  CONSENT_BUNDLE_QUERY_KEY,
  CONSENT_REQUEST_QUERY_KEY,
  normalizeConsentSheetView,
} from "@/lib/consent/consent-sheet-route";

export default function ConsentsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const resolvedSearchParams = searchParams ?? {};
  const rawView = Array.isArray(resolvedSearchParams.view)
    ? resolvedSearchParams.view[0]
    : resolvedSearchParams.view;
  const requestId = Array.isArray(resolvedSearchParams[CONSENT_REQUEST_QUERY_KEY])
    ? resolvedSearchParams[CONSENT_REQUEST_QUERY_KEY]?.[0]
    : resolvedSearchParams[CONSENT_REQUEST_QUERY_KEY];
  const bundleId = Array.isArray(resolvedSearchParams[CONSENT_BUNDLE_QUERY_KEY])
    ? resolvedSearchParams[CONSENT_BUNDLE_QUERY_KEY]?.[0]
    : resolvedSearchParams[CONSENT_BUNDLE_QUERY_KEY];

  redirect(
    buildConsentSheetProfileHref(normalizeConsentSheetView(rawView), {
      requestId,
      bundleId,
    })
  );
}

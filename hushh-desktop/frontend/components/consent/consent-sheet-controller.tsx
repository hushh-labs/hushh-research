"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  buildConsentCenterHref,
  clearConsentSheetParams,
  CONSENT_LEGACY_PANEL_QUERY_KEY,
  CONSENT_LEGACY_PANEL_VALUE,
  CONSENT_SHEET_QUERY_KEY,
  CONSENT_SHEET_QUERY_VALUE,
  CONSENT_SHEET_VIEW_QUERY_KEY,
  normalizeConsentSheetView,
  type ConsentCenterManagerView,
  type ConsentSheetView,
} from "@/lib/consent/consent-sheet-route";
import type { ConsentCenterActor } from "@/lib/services/consent-center-service";
import { ROUTES } from "@/lib/navigation/routes";

type ConsentSheetContextValue = {
  isOpen: boolean;
  view: ConsentSheetView;
  openConsentSheet: (options?: { view?: ConsentSheetView }) => void;
  closeConsentSheet: () => void;
};

const ConsentSheetContext = createContext<ConsentSheetContextValue>({
  isOpen: false,
  view: "pending",
  openConsentSheet: () => {},
  closeConsentSheet: () => {},
});

function buildNextUrl(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function ConsentSheetProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  const isLegacyProfileConsentPanel =
    pathname === ROUTES.PROFILE &&
    searchParams.get(CONSENT_LEGACY_PANEL_QUERY_KEY) === CONSENT_LEGACY_PANEL_VALUE;
  const isOpen =
    searchParams.get(CONSENT_SHEET_QUERY_KEY) === CONSENT_SHEET_QUERY_VALUE ||
    isLegacyProfileConsentPanel;
  const view = normalizeConsentSheetView(
    searchParams.get(CONSENT_SHEET_VIEW_QUERY_KEY) ?? searchParams.get("view")
  );

  useEffect(() => {
    if (!isOpen) return;
    const requestId = searchParams.get("requestId") || undefined;
    const bundleId = searchParams.get("bundleId") || undefined;
    const actor: ConsentCenterActor | undefined =
      searchParams.get("actor") === "ria" || searchParams.get("actor") === "investor"
        ? (searchParams.get("actor") as ConsentCenterActor)
        : undefined;
    const managerView: ConsentCenterManagerView | undefined =
      searchParams.get("view") === "incoming" || searchParams.get("view") === "outgoing"
        ? (searchParams.get("view") as ConsentCenterManagerView)
        : undefined;
    const from = pathname === ROUTES.PROFILE ? `${ROUTES.PROFILE}?tab=privacy` : undefined;
    router.replace(
      buildConsentCenterHref(view, { requestId, bundleId, actor, managerView, from }),
      { scroll: false }
    );
  }, [isOpen, pathname, router, searchParams, view]);

  const openConsentSheet = useCallback(
    (options?: { view?: ConsentSheetView }) => {
      router.push(buildConsentCenterHref(options?.view), { scroll: false });
    },
    [router]
  );

  const closeConsentSheet = useCallback(() => {
    const params = clearConsentSheetParams(new URLSearchParams(searchParamsString));
    router.replace(buildNextUrl(pathname, params), { scroll: false });
  }, [pathname, router, searchParamsString]);

  const value = useMemo(
    () => ({
      isOpen,
      view,
      openConsentSheet,
      closeConsentSheet,
    }),
    [closeConsentSheet, isOpen, openConsentSheet, view]
  );

  return (
    <ConsentSheetContext.Provider value={value}>
      {children}
    </ConsentSheetContext.Provider>
  );
}

export function useConsentSheet() {
  return useContext(ConsentSheetContext);
}

"use client";

import dynamic from "next/dynamic";
import { useConsent } from "../../src/hooks/useConsent";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";

const PermissionGate = dynamic(
  () => import("../../src/components/privacy/permission-gate/PermissionGate"),
  { ssr: false }
);

const KaiMarketPreviewView = dynamic(
  () =>
    import("@/components/kai/views/kai-market-preview-view").then(
      (mod) => mod.KaiMarketPreviewView
    ),
  { ssr: false }
);

export default function KaiPage() {
  const { hasConsentFor, isLoading } = useConsent();

  return (
    <>
      <NativeRouteMarker
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <NativeTestBeacon
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <PermissionGate
        permission="portfolio_valuation"
        hasConsent={hasConsentFor("portfolio_valuation")}
        isLoading={isLoading}
      >
        <KaiMarketPreviewView />
      </PermissionGate>
    </>
  );
}
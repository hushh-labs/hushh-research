import { Suspense } from "react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function OneConsentPage() {
  return (
    <Suspense fallback={<div className="consent-presentation-surface contents"><RouteSuspenseFallback label="Loading access manager…" /></div>}>
      <>
        <NativeTestBeacon
          routeId="/one/consent"
          marker="native-route-consents"
          authState="authenticated"
          dataState="loaded"
        />
        <ConsentCenterPage />
      </>
    </Suspense>
  );
}

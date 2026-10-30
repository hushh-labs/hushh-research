import { Suspense } from "react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

export default function ConsentsPage() {
  return (
    <Suspense fallback={<RouteSuspenseFallback label="Loading consents…" />}>
      <>
        <NativeTestBeacon
          routeId="/consents"
          marker="native-route-consents"
          authState="authenticated"
          dataState="loaded"
        />
        <ConsentCenterPage />
      </>
    </Suspense>
  );
}
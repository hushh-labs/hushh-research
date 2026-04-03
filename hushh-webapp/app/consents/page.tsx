import { Suspense } from "react";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";

export default function ConsentsPage() {
  return (
    <Suspense fallback={<HushhLoader variant="inline" label="Loading consents…" />}>
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

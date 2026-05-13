"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { RouteSuspenseFallback } from "@/components/system/route-suspense-fallback";

function ConsentsContent() {
  // Access search params to ensure this client component is correctly 
  // associated with the Suspense boundary in static builds.
  const searchParams = useSearchParams();

  return (
    <>
      <NativeTestBeacon
        routeId="/consents"
        marker="native-route-consents"
        authState="authenticated"
        dataState="loaded"
      />
      <ConsentCenterPage />
    </>
  );
}

export default function ConsentsPage() {
  return (
    <Suspense fallback={<HushhLoader variant="inline" label="Loading consents…" />}>
      <ConsentsContent />
    </Suspense>
  );
}
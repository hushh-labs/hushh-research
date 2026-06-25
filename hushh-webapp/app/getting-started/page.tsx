"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { useAuth } from "@/lib/firebase/auth-context";
import { PreviewCarouselStep } from "@/components/onboarding/PreviewCarouselStep";
import { ROUTES } from "@/lib/navigation/routes";

function GettingStartedContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;

  const { user, loading } = useAuth();

  // Authenticated users skip the marketing carousel entirely.
  useEffect(() => {
    if (loading) return;
    if (user) {
      router.replace(ROUTES.ONE_HOME);
    }
  }, [loading, user, router]);

  if (loading || user) {
    return <HushhLoader label="Loading..." variant="fullscreen" />;
  }

  return (
    <>
      <NativeTestBeacon
        routeId={ROUTES.GETTING_STARTED}
        marker="native-route-getting-started"
        authState="anonymous"
        dataState="loaded"
      />
      <PreviewCarouselStep
        onContinue={() => router.push(loginUrl)}
        onBack={() => router.push(ROUTES.HOME)}
      />
    </>
  );
}

export default function GettingStartedPage() {
  return (
    <>
      <NativeRouteMarker
        routeId={ROUTES.GETTING_STARTED}
        marker="native-route-getting-started"
        authState="anonymous"
        dataState="loaded"
      />
      <Suspense
        fallback={<HushhLoader label="Loading..." variant="fullscreen" />}
      >
        <GettingStartedContent />
      </Suspense>
    </>
  );
}

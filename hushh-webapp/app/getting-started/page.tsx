"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { useAuth } from "@/lib/firebase/auth-context";
import { PreviewCarouselStep } from "@/components/onboarding/PreviewCarouselStep";
import { ROUTES } from "@/lib/navigation/routes";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

function GettingStartedContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;

  const { user, loading } = useAuth();

  // Publish screen context so the onboarding guide can welcome and orient a
  // brand-new, signed-out person before they have an account or a vault.
  usePublishVoiceSurfaceMetadata({
    screenId: "getting_started",
    title: "Welcome to One",
    purpose:
      "This is your welcome. Swipe through to see what One can do, then continue when you're ready.",
    actions: [
      { id: "continue", label: "Continue", purpose: "Move on to sign in and set up." },
    ],
  });

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
        // Returning visitors (marketing already seen) get bounced from "/" back
        // to this carousel, so routing back to "/" is a loop. Send back to the
        // sign-in screen, the same place Continue/Skip lead, to avoid a dead end.
        onBack={() => router.push(loginUrl)}
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

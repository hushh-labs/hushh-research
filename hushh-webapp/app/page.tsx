"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { JsonLd } from "@/components/seo/json-ld";
import { buildFaqGraph } from "@/lib/seo/structured-data";
import { HOME_FAQ } from "@/lib/seo/faq-data";
import { useAuth } from "@/lib/firebase/auth-context";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { IntroStep } from "@/components/onboarding/IntroStep";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveAppEnvironment } from "@/lib/app-env";

type HomeStep = "intro";

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;
  const gettingStartedUrl = redirectPath
    ? `${ROUTES.GETTING_STARTED}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.GETTING_STARTED;

  const { user, loading } = useAuth();
  const [step, setStep] = useState<HomeStep | null>(null);

  const forceOnboardingInDev = resolveAppEnvironment() === "development";

  // Debug helper (browser console): resets Steps 1-2 visibility flag.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (typeof window === "undefined") return;
     
    (window as any).resetOnboardingMarketing = async () => {
      await OnboardingLocalService.clearMarketingSeen();
      setStep("intro");
      router.replace("/");
    };

    return () => {
       
      delete (window as any).resetOnboardingMarketing;
    };
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    if (loading) return;

    if (user) {
      setStep(null);
      router.replace(ROUTES.ONE_HOME);
      return;
    }

    (async () => {
      if (forceOnboardingInDev) {
        setStep("intro");
        return;
      }

      const shouldForceIntro = await OnboardingLocalService.consumeForceIntroOnce();
      if (shouldForceIntro) {
        setStep("intro");
        return;
      }

      const hasSeen = await OnboardingLocalService.hasSeenMarketing();
      if (cancelled) return;
      // Returning visitors who already saw the intro skip straight to the
      // getting-started carousel route; first-timers see the intro.
      if (hasSeen) {
        router.replace(gettingStartedUrl);
        return;
      }
      setStep("intro");
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user, router, forceOnboardingInDev, gettingStartedUrl]);

  if (loading || (!user && step === null)) {
    return <HushhLoader label="Loading..." variant="fullscreen" />;
  }

  if (user) {
    return <HushhLoader label="Opening One..." variant="fullscreen" />;
  }

  if (step === "intro") {
    return (
      <>
        <NativeTestBeacon
          routeId="/"
          marker="native-route-home"
          authState={user ? "authenticated" : "anonymous"}
          dataState="loaded"
        />
        <IntroStep
          onNext={() => router.push(gettingStartedUrl)}
          onLogin={() => router.push(loginUrl)}
        />
      </>
    );
  }

  return null;
}

export default function Home() {
  return (
    <>
      <JsonLd data={buildFaqGraph(HOME_FAQ)} />
      <NativeRouteMarker
        routeId="/"
        marker="native-route-home"
        authState="anonymous"
        dataState="loaded"
      />
      <Suspense fallback={<HushhLoader label="Loading..." variant="fullscreen" />}>
        <HomeContent />
      </Suspense>
    </>
  );
}

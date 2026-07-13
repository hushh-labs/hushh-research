"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
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
    if (loading) return;

    if (user) {
      setStep(null);
      router.replace(ROUTES.ONE_HOME);
      return;
    }

    // The marketing carousel is disabled for now: every signed-out visitor
    // lands on the single welcome (intro) screen, which leads to sign-in. The
    // dev-only force-intro flag is consumed so it does not persist.
    void OnboardingLocalService.consumeForceIntroOnce();
    setStep("intro");
  }, [loading, user, router, forceOnboardingInDev]);

  if (loading || (!user && step === null)) {
    return <RouteLoadingState surface="ambient" label="Preparing welcome…" />;
  }

  if (user) {
    return <RouteLoadingState surface="ambient" label="Opening One…" />;
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
        <IntroStep onLogin={() => router.push(loginUrl)} />
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
      <Suspense
        fallback={
          <RouteLoadingState surface="ambient" label="Preparing welcome…" />
        }
      >
        <HomeContent />
      </Suspense>
    </>
  );
}

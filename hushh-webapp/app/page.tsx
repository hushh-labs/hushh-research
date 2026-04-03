"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { useAuth } from "@/lib/firebase/auth-context";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { IntroStep } from "@/components/onboarding/IntroStep";
import { PreviewCarouselStep } from "@/components/onboarding/PreviewCarouselStep";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveAppEnvironment } from "@/lib/app-env";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

type HomeStep = "intro" | "preview";

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";

  const { user, loading } = useAuth();
  const [step, setStep] = useState<HomeStep | null>(null);

  const forceOnboardingInDev = resolveAppEnvironment() === "development";

  // Debug helper (browser console): resets Steps 1-2 visibility flag.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (typeof window === "undefined") return;
     
    (window as any).resetOnboardingMarketing = async () => {
      await OnboardingLocalService.clearMarketingSeen();
      assignWindowLocation("/");
    };

    return () => {
       
      delete (window as any).resetOnboardingMarketing;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (loading) return;

    if (user) {
      void (async () => {
        try {
          const idToken = await user.getIdToken().catch(() => undefined);
          const nextPath = await PostAuthRouteService.resolveAfterLogin({
            userId: user.uid,
            redirectPath: ROUTES.KAI_HOME,
            idToken,
          });
          if (!cancelled) {
            router.push(nextPath);
          }
        } catch {
          if (!cancelled) {
            router.push(ROUTES.KAI_HOME);
          }
        }
      })();
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
      setStep(hasSeen ? "preview" : "intro");
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user, router, forceOnboardingInDev]);

  if (loading || step === null) {
    return <HushhLoader label="Loading..." variant="fullscreen" />;
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
        <IntroStep onNext={() => setStep("preview")} />
      </>
    );
  }

  if (step === "preview") {
    const loginUrl = redirectPath
      ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
      : ROUTES.LOGIN;
    return (
      <>
        <NativeTestBeacon
          routeId="/"
          marker="native-route-home"
          authState={user ? "authenticated" : "anonymous"}
          dataState="loaded"
        />
        <PreviewCarouselStep onContinue={() => router.push(loginUrl)} />
      </>
    );
  }
  return null;
}

export default function Home() {
  return (
    <>
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

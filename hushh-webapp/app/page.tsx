"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { JsonLd } from "@/components/seo/json-ld";
import { buildFaqGraph } from "@/lib/seo/structured-data";
import { HOME_FAQ } from "@/lib/seo/faq-data";
import { useAuth } from "@/lib/firebase/auth-context";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { IntroStep } from "@/components/onboarding/IntroStep";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveAppEnvironment } from "@/lib/app-env";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { AuthService } from "@/lib/services/auth-service";

type HomeStep = "intro";

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;

  const {
    user,
    loading,
    phoneNumber,
    sessionVerificationRequired,
    retrySessionVerification,
    signOut,
  } = useAuth();
  const [step, setStep] = useState<HomeStep | null>(null);
  const [routingError, setRoutingError] = useState(false);
  const [routingAttempt, setRoutingAttempt] = useState(0);
  const activeResolutionRef = useRef<string | null>(null);

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

    if (user) return;

    // The marketing carousel is disabled for now: every signed-out visitor
    // lands on the single welcome (intro) screen, which leads to sign-in. The
    // dev-only force-intro flag is consumed so it does not persist.
    void OnboardingLocalService.consumeForceIntroOnce();
    setStep("intro");
  }, [forceOnboardingInDev, loading, user, router]);

  useEffect(() => {
    if (loading || sessionVerificationRequired || !user?.uid) {
      if (!user?.uid) activeResolutionRef.current = null;
      return;
    }

    const userId = user.uid;
    const resolutionKey = `${userId}:${phoneNumber ?? ""}:${routingAttempt}`;
    if (activeResolutionRef.current === resolutionKey) return;
    activeResolutionRef.current = resolutionKey;
    setStep(null);
    setRoutingError(false);
    let cancelled = false;

    void (async () => {
      // A Firebase session can still be restoring a few frames after a fresh
      // sign-in or a referral redirect. A single null read here used to fail
      // this whole resolution hard ("Unable to verify setup progress"); wait
      // briefly and retry once before treating it as a genuine sign-out.
      const idToken = await AuthService.getIdTokenWithRetry();
      if (!idToken) {
        throw new Error("Native session did not provide an ID token.");
      }
      const nextPath = await PostAuthRouteService.resolveAfterLogin({
        userId,
        redirectPath: redirectPath || undefined,
        idToken,
        phoneNumber,
        enableFirstRunSetupGate: true,
      });
      if (cancelled || activeResolutionRef.current !== resolutionKey) return;
      router.replace(nextPath);
    })().catch((error) => {
      if (cancelled || activeResolutionRef.current !== resolutionKey) return;
      console.warn("[Home] Failed to resolve authenticated entry:", error);
      setRoutingError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [
    loading,
    phoneNumber,
    redirectPath,
    router,
    routingAttempt,
    sessionVerificationRequired,
    user?.uid,
  ]);

  if (loading || (!user && step === null && !sessionVerificationRequired)) {
    return <HushhLoader variant="fullscreen" label="Preparing welcome…" />;
  }

  if (sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (user) {
    if (routingError) {
      return (
        <SessionVerificationRecovery
          onRetry={() => {
            activeResolutionRef.current = null;
            setRoutingAttempt((attempt) => attempt + 1);
          }}
          onSignOut={() => void signOut()}
        />
      );
    }
    return <HushhLoader variant="fullscreen" label="Opening One…" />;
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
      <Suspense fallback={null}>
        <HomeContent />
      </Suspense>
    </>
  );
}

"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
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
import { useOnboardingEntry } from "@/lib/onboarding/onboarding-entry-context";
import { Button } from "@/lib/morphy-ux/button";

type HomeStep = "intro";

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const loginUrl = redirectPath
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(redirectPath)}`
    : ROUTES.LOGIN;

  const { user, loading, phoneNumber } = useAuth();
  const { entry } = useOnboardingEntry();
  const [step, setStep] = useState<HomeStep | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [routingAttempt, setRoutingAttempt] = useState(0);
  const activeResolutionRef = useRef<string | null>(null);
  const entryRedirectRef = useRef<string | null>(null);

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
    if (loading || !user?.uid) {
      if (!user?.uid) activeResolutionRef.current = null;
      return;
    }

    // Landing here signed in means somebody backed onto the one entry that
    // outlives the funnel. Without a deep link to honour there is nothing to
    // work out: the app-wide decision already knows where they belong, and it
    // knows it from the same durable record every guard reads.
    //
    // Re-deriving it here is what produced the phone screen at the end of three
    // back presses. This page passed only `phoneNumber`, which Firebase leaves
    // null for a Google sign-in, so whenever the backend's own phone claim came
    // back unknown the resolver failed closed and forward-replaced a fully
    // verified person onto phone verification.
    if (!redirectPath) {
      if (!entry.resolved) return;
      // Idempotent: the same destination is never sent twice, so a re-render
      // for any other reason cannot stack a second navigation on the first.
      if (entryRedirectRef.current === entry.destination) return;
      entryRedirectRef.current = entry.destination;
      activeResolutionRef.current = null;
      setStep(null);
      setRoutingError(null);
      router.replace(entry.destination);
      return;
    }

    const userId = user.uid;
    const resolutionKey = `${userId}:${phoneNumber ?? ""}:${routingAttempt}`;
    if (activeResolutionRef.current === resolutionKey) return;
    activeResolutionRef.current = resolutionKey;
    setStep(null);
    setRoutingError(null);
    let cancelled = false;

    void (async () => {
      const idToken = await AuthService.getIdToken();
      if (!idToken) {
        throw new Error("Native session did not provide an ID token.");
      }
      const nextPath = await PostAuthRouteService.resolveAfterLogin({
        userId,
        redirectPath,
        idToken,
        phoneNumber,
        // The authoritative claim, folded from Firebase, the durable record and
        // the identity read. Without it this call falls back to `phoneNumber`
        // alone and asks a verified person to verify again.
        phoneVerified: entry.step !== "phone_auth",
      // The one-time nudge into the setup hub is deliberately not requested
      // any more. It only ever fired for somebody whose setup was ALREADY
      // resolved, which is the exact thing the funnel is now closed to — the
      // guard would send them straight back out, so the nudge could only ever
      // be seen as a flash of the setup screen on the way to the app.
      });
      if (cancelled || activeResolutionRef.current !== resolutionKey) return;
      router.replace(nextPath);
    })().catch((error) => {
      if (cancelled || activeResolutionRef.current !== resolutionKey) return;
      console.warn("[Home] Failed to resolve authenticated entry:", error);
      setRoutingError("Unable to verify setup progress. Please retry.");
    });

    return () => {
      cancelled = true;
    };
  }, [
    entry.destination,
    entry.resolved,
    entry.step,
    loading,
    phoneNumber,
    redirectPath,
    router,
    routingAttempt,
    user?.uid,
  ]);

  if (loading || (!user && step === null)) {
    return <HushhLoader variant="fullscreen" label="Preparing welcome…" />;
  }

  if (user) {
    if (routingError) {
      return (
        <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-muted-foreground">{routingError}</p>
          <Button
            variant="muted"
            onClick={() => {
              activeResolutionRef.current = null;
              setRoutingAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </Button>
        </div>
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
        {/* Replace, not push. This is the only entry that used to survive the
            whole funnel — everything after it replaces forward over the same
            slot — so pushing left one live doorway back into onboarding under
            every signed-in session. */}
        <IntroStep onLogin={() => router.replace(loginUrl)} />
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

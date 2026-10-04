"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { JsonLd } from "@/components/seo/json-ld";
import { buildFaqGraph } from "@/lib/seo/structured-data";
import { HOME_FAQ } from "@/lib/seo/faq-data";
import { useAuth } from "@/lib/firebase/auth-context";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { IntroStep } from "@/components/onboarding/IntroStep";
import { INVITE_TO_ONE_PATH, ROUTES } from "@/lib/navigation/routes";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { AuthService } from "@/lib/services/auth-service";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { useVault } from "@/lib/vault/vault-context";

function HomeContent() {
  const router = useRouter();
  const { replace } = router;
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "";
  const inviteMarkers = searchParams.getAll("invite");
  const isOneInvitation =
    inviteMarkers.length === 1 && inviteMarkers[0] === "one" && !redirectPath;
  const loginReturnTo =
    redirectPath || (isOneInvitation ? INVITE_TO_ONE_PATH : "");
  const loginUrl = loginReturnTo
    ? `${ROUTES.LOGIN}?redirect=${encodeURIComponent(loginReturnTo)}`
    : ROUTES.LOGIN;

  const {
    user,
    loading,
    phoneNumber,
    sessionVerificationRequired,
    retrySessionVerification,
    signOut,
  } = useAuth();
  const { isVaultUnlocked } = useVault();
  const [routingError, setRoutingError] = useState(false);
  const [routingAttempt, setRoutingAttempt] = useState(0);
  const [authenticatedRootReady, setAuthenticatedRootReady] = useState(false);
  const activeResolutionRef = useRef<string | null>(null);
  const hasExplicitRedirect = Boolean(
    redirectPath && redirectPath !== ROUTES.HOME,
  );
  // The admission read remains authoritative and continues in the background,
  // but an already-unlocked owner does not need to stare at a full-screen
  // loader while that read settles. VaultLockGuard and PhoneMandateGuard still
  // wrap the workspace below, so this is only a paint fast path—not an access
  // bypass. Explicit deep links keep the blocking route-resolution behavior.
  const canRenderAuthenticatedChatImmediately = Boolean(
    user && isVaultUnlocked && !hasExplicitRedirect,
  );

  // Debug helper opens the public introduction with the One invitation context.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (typeof window === "undefined") return;

    (window as any).resetOnboardingMarketing = async () => {
      await OnboardingLocalService.clearMarketingSeen();
      router.replace(INVITE_TO_ONE_PATH);
    };

    return () => {
      delete (window as any).resetOnboardingMarketing;
    };
  }, [router]);

  useEffect(() => {
    if (loading || sessionVerificationRequired || !user?.uid) {
      if (!user?.uid) activeResolutionRef.current = null;
      return;
    }

    const userId = user.uid;
    const resolutionKey = JSON.stringify([
      userId,
      phoneNumber,
      redirectPath,
      routingAttempt,
    ]);
    if (activeResolutionRef.current === resolutionKey) return;
    activeResolutionRef.current = resolutionKey;
    setAuthenticatedRootReady(false);
    setRoutingError(false);
    let cancelled = false;
    let settled = false;

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
      settled = true;
      if (nextPath === ROUTES.HOME) {
        setAuthenticatedRootReady(true);
        return;
      }
      replace(nextPath);
    })().catch((error) => {
      if (cancelled || activeResolutionRef.current !== resolutionKey) return;
      settled = true;
      console.warn("[Home] Failed to resolve authenticated entry:", error);
      setRoutingError(true);
    });

    return () => {
      cancelled = true;
      // An interrupted attempt must be restartable, including StrictMode's
      // setup/cleanup replay. Only a settled resolution may be deduplicated.
      if (!settled && activeResolutionRef.current === resolutionKey) {
        activeResolutionRef.current = null;
      }
    };
  }, [
    loading,
    phoneNumber,
    redirectPath,
    replace,
    routingAttempt,
    sessionVerificationRequired,
    user?.uid,
  ]);

  if (loading) {
    return (
      <HushhLoader
        stage="session"
        label="Preparing welcome…"
      />
    );
  }

  if (sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
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
          onSignOut={() => void signOut({ skipFcmCleanup: true })}
        />
      );
    }
    if (!authenticatedRootReady && !canRenderAuthenticatedChatImmediately) {
      return <HushhLoader stage="workspace" label="Opening chat…" />;
    }
    return (
      <>
        <NativeTestBeacon
          routeId="/"
          marker="native-route-home"
          authState="authenticated"
          dataState="loaded"
        />
        <VaultLockGuard>
          <PhoneMandateGuard>
            <Suspense
              fallback={
                <HushhLoader stage="workspace" label="Loading chat…" />
              }
            >
              <AgentChatWorkspace />
            </Suspense>
          </PhoneMandateGuard>
        </VaultLockGuard>
      </>
    );
  }

  return (
      <>
        <NativeTestBeacon
          routeId="/"
          marker="native-route-home"
          authState="anonymous"
          dataState="loaded"
        />
        <IntroStep onLogin={() => router.push(loginUrl)} />
      </>
  );
}

export default function Home() {
  return (
    <>
      <JsonLd data={buildFaqGraph(HOME_FAQ)} />
      <Suspense fallback={<HushhLoader stage="session" label="Preparing welcome…" />}>
        <HomeContent />
      </Suspense>
    </>
  );
}

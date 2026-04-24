"use client";

import { type CSSProperties, Suspense, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";

const FLOW_SHELL_STYLE = {
  "--page-top-local-offset": "clamp(1.25rem, 4vh, 3rem)",
} as CSSProperties;

function requiresVaultUnlockForRedirect(path?: string | null): boolean {
  const normalizedPath = String(path ?? "").trim();
  if (!normalizedPath) {
    return false;
  }

  return (
    normalizedPath === ROUTES.KAI_HOME ||
    normalizedPath.startsWith(`${ROUTES.KAI_HOME}/`) ||
    normalizedPath === ROUTES.RIA_HOME ||
    normalizedPath.startsWith(`${ROUTES.RIA_HOME}/`) ||
    normalizedPath === ROUTES.CONSENTS ||
    normalizedPath.startsWith(`${ROUTES.CONSENTS}/`) ||
    normalizedPath === ROUTES.PROFILE_PKM_AGENT_LAB ||
    normalizedPath.startsWith(`${ROUTES.PROFILE_PKM_AGENT_LAB}/`)
  );
}

function PhoneMandatePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || undefined;
  const {
    user,
    loading,
    phoneNumber,
    startPhoneVerification,
    confirmPhoneVerification,
    refreshUser,
  } = useAuth();

  useEffect(() => {
    if (loading || user) {
      return;
    }

    const currentPath = redirectPath
      ? `${ROUTES.PHONE_MANDATE}?redirect=${encodeURIComponent(redirectPath)}`
      : ROUTES.PHONE_MANDATE;
    router.replace(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(currentPath)}`);
  }, [loading, redirectPath, router, user]);

  const continueToNextRoute = useCallback(
    async (resolvedUser = user) => {
      const activeUser = resolvedUser ?? (await refreshUser());
      if (!activeUser) {
        router.replace(ROUTES.LOGIN);
        return;
      }

      await AccountIdentityService.syncCurrentUser(activeUser);
      const idToken = await activeUser.getIdToken().catch(() => undefined);
      const nextPath = await PostAuthRouteService.resolveAfterLogin({
        userId: activeUser.uid,
        redirectPath,
        idToken,
        phoneNumber: activeUser.phoneNumber,
        hostname: window.location.hostname,
      });
      router.replace(nextPath);
    },
    [redirectPath, refreshUser, router, user]
  );

  const shouldBypassLocalPhoneMandate =
    !loading &&
    Boolean(user) &&
    !phoneNumber &&
    typeof window !== "undefined" &&
    shouldBypassPhoneMandateForLocalhost(window.location.hostname);

  useEffect(() => {
    if (!shouldBypassLocalPhoneMandate || !user) {
      return;
    }
    void continueToNextRoute(user);
  }, [continueToNextRoute, shouldBypassLocalPhoneMandate, user]);

  if (loading || !user) {
    return <HushhLoader label="Loading phone verification..." variant="fullscreen" />;
  }

  if (shouldBypassLocalPhoneMandate) {
    return <HushhLoader label="Continuing local session..." variant="fullscreen" />;
  }

  const shell = (
    <FullscreenFlowShell
      as="main"
      width="narrow"
      className="min-h-screen px-6 pb-10"
      style={FLOW_SHELL_STYLE}
    >
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />
      <div className="mx-auto w-full max-w-[28rem] pt-2 sm:pt-3">
        <div className="space-y-3">
          <h1 className="max-w-[18rem] text-[clamp(2.5rem,9vw,3.5rem)] font-black leading-[0.94] tracking-tight text-foreground">
            Verify your phone number
          </h1>
          <p className="max-w-sm text-[15px] leading-7 text-muted-foreground">
            Add your phone number to continue.
          </p>
        </div>
        <PhoneVerificationFlow
          mode="link"
          currentPhoneNumber={phoneNumber}
          startVerification={startPhoneVerification}
          confirmVerification={confirmPhoneVerification}
          onCompleted={continueToNextRoute}
          onContinueExisting={continueToNextRoute}
          confirmLabel="Verify and continue"
          className="mt-8 gap-5"
        />

        <div id="recaptcha-container" className="mt-6 min-h-0" />
      </div>
    </FullscreenFlowShell>
  );

  if (requiresVaultUnlockForRedirect(redirectPath)) {
    return <VaultLockGuard>{shell}</VaultLockGuard>;
  }

  return shell;
}

export default function RegisterPhonePage() {
  return (
    <Suspense fallback={<HushhLoader label="Loading phone verification..." variant="fullscreen" />}>
      <PhoneMandatePageContent />
    </Suspense>
  );
}

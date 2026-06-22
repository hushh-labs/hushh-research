"use client";

import Image from "next/image";
import { type CSSProperties, Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOut, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  kaiAppBodyClassName,
  kaiAppCompactTitleClassName,
} from "@/components/kai/shared/kai-typography";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";

const FLOW_SHELL_STYLE = {
  "--page-top-local-offset": "0px",
  "--phone-mandate-safe-pt":
    "calc(var(--app-safe-area-top-effective, env(safe-area-inset-top, 0px)) + 1.25rem)",
  "--phone-mandate-safe-pb":
    "calc(var(--app-safe-area-bottom-effective, env(safe-area-inset-bottom, 0px)) + 1.25rem)",
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
    signOut,
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

      const identity = await AccountIdentityService.syncCurrentUser(activeUser);
      const idToken = await activeUser.getIdToken().catch(() => undefined);
      const nextPath = await PostAuthRouteService.resolveAfterLogin({
        userId: activeUser.uid,
        redirectPath,
        idToken,
        phoneNumber: activeUser.phoneNumber,
        phoneVerified: AccountIdentityService.hasVerifiedPhone(identity),
        hostname: window.location.hostname,
      });
      router.replace(nextPath);
    },
    [redirectPath, refreshUser, router, user]
  );

  const [shouldBypassLocalPhoneMandate, setShouldBypassLocalPhoneMandate] = useState(false);

  const handleSignOut = useCallback(async () => {
    try {
      setOnboardingRequiredCookie(false);
      setOnboardingFlowActiveCookie(false);
      await signOut({ redirectTo: ROUTES.HOME });
    } catch (error) {
      console.error("[RegisterPhonePage] Failed to sign out:", error);
      toast.error("Couldn't sign out. Please retry.");
    }
  }, [signOut]);

  useEffect(() => {
    if (!loading && Boolean(user) && !phoneNumber) {
      if (typeof window !== "undefined" && shouldBypassPhoneMandateForLocalhost(window.location.hostname)) {
        setShouldBypassLocalPhoneMandate(true);
      }
    }
  }, [loading, user, phoneNumber]);

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
      className="relative h-[100dvh] min-h-[100svh] justify-center overflow-hidden px-6 pb-[var(--phone-mandate-safe-pb)] pt-[var(--phone-mandate-safe-pt)]"
      style={FLOW_SHELL_STYLE}
    >
      <div className="absolute right-4 top-[calc(var(--app-safe-area-top-effective,env(safe-area-inset-top,0px))+0.75rem)] z-20">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ShellActionSurface variant="icon" aria-label="Account actions">
              <MoreHorizontal className="h-5 w-5 text-current" />
            </ShellActionSurface>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void handleSignOut()}>
              <LogOut className="h-4 w-4 text-current" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />
      <div className="mx-auto w-full max-w-[27rem]">
        <header className="flex-none text-center">
          <Image
            src="/one-quiet-emoji.png"
            alt=""
            width={44}
            height={44}
            priority
            aria-hidden="true"
            draggable={false}
            className="mx-auto h-11 w-11 select-none object-contain drop-shadow-[0_12px_24px_rgba(0,0,0,0.08)]"
          />
          <div
            role="heading"
            aria-level={1}
            aria-label="Verify your phone number"
            className={`mt-2.5 ${kaiAppCompactTitleClassName} text-[#1d1d1f] dark:text-[#f5f5f7]`}
          >
            Verify your phone number
          </div>
          <p className={`mx-auto mt-2.5 max-w-[20rem] ${kaiAppBodyClassName} text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]`}>
            Add your phone number to continue.
          </p>
        </header>
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

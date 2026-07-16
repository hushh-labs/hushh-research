"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, LogOut, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { resolvePostPhoneOnboardingPhase } from "@/lib/onboarding/onboarding-journey-phase";

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

export function PhoneMandatePageContent() {
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
    router.replace(
      `${ROUTES.LOGIN}?redirect=${encodeURIComponent(currentPath)}`,
    );
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
      const setupResolved = await PreVaultUserStateService.bootstrapState(
        activeUser.uid,
        {
          force: true,
        },
      )
        .then((state) => PreVaultUserStateService.isSetupResolved(state))
        .catch((error) => {
          console.warn(
            "[RegisterPhonePage] Failed to refresh setup state:",
            error,
          );
          return false;
        });
      await PreVaultUserStateService.syncOnboardingJourney({
        userId: activeUser.uid,
        // A destination is never proof that root onboarding resolved. Only the
        // hub's durable Finish/Skip write can move the journey to completion.
        phase: resolvePostPhoneOnboardingPhase(setupResolved),
        activeCapability: null,
        callbackState: "none",
      }).catch((error) => {
        console.warn(
          "[RegisterPhonePage] Failed to persist phone journey settlement:",
          error,
        );
      });
      router.replace(nextPath);
    },
    [redirectPath, refreshUser, router, user],
  );

  const [shouldBypassLocalPhoneMandate, setShouldBypassLocalPhoneMandate] =
    useState(false);
  const localBypassNavigationRef = useRef<string | null>(null);

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
      if (
        typeof window !== "undefined" &&
        shouldBypassPhoneMandateForLocalhost(window.location.hostname)
      ) {
        setShouldBypassLocalPhoneMandate(true);
      }
    }
  }, [loading, user, phoneNumber]);

  useEffect(() => {
    if (!shouldBypassLocalPhoneMandate || !user) {
      localBypassNavigationRef.current = null;
      return;
    }

    // Local development bypasses the phone challenge only. It must not await
    // account sync, persona lookup, or pre-vault bootstrap before leaving this
    // screen: those are network-backed reconciliation tasks and can stall a
    // local browser indefinitely. The canonical next onboarding boundary is
    // always the setup hub; it owns its own authenticated state admission.
    const targetRoute = ROUTES.ONE_SETUP;
    const attemptKey = `${user.uid}:${targetRoute}`;
    if (localBypassNavigationRef.current === attemptKey) {
      return;
    }

    localBypassNavigationRef.current = attemptKey;
    router.replace(targetRoute);
  }, [router, shouldBypassLocalPhoneMandate, user]);

  usePublishVoiceSurfaceMetadata(
    !loading && user && !shouldBypassLocalPhoneMandate
      ? {
          screenId: "phone_mandate",
          title: "Verify your phone",
          purpose:
            "Adding a phone number keeps your account recoverable and secure before setup continues.",
          actions: [
            {
              id: "phone_mandate.submit_number",
              label: "Submit phone number",
              purpose: "Send a verification code to the phone number you say.",
            },
          ],
        }
      : null,
  );

  if (loading || !user) {
    return (
      <HushhLoader label="Loading phone verification..." variant="fullscreen" />
    );
  }

  if (shouldBypassLocalPhoneMandate) {
    return (
      <HushhLoader label="Continuing local session..." variant="fullscreen" />
    );
  }

  const shell = (
    // Inline styles (not Tailwind arbitrary-value classes) for every
    // computed height/offset here: Tailwind's arbitrary calc() parser
    // requires escaped whitespace around +/- operators ("18px_+_var(...)");
    // without it the whole declaration is invalid CSS and silently dropped,
    // which produced 0px paddings/heights and forced full-page scroll.
    // The outer app scroll root reserves --app-scroll-bottom-pad below this
    // element for the fixed onboarding Agent Bar, then re-adds it as its own
    // padding-bottom, so this element is exactly one viewport minus that
    // reservation.
    <main
      className="relative w-full overflow-hidden"
      style={{
        height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
        minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
      }}
    >
      {/* Shared immersive gradient backdrop (welcome / login / phone). */}
      <OnboardingHeroBackground />
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />

      <div
        className="relative mx-auto flex w-full max-w-[440px] flex-col"
        style={{
          height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
          minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
        }}
      >
        {/* Top bar: back + account actions */}
        <div
          className="flex items-center justify-between px-5"
          style={{ paddingTop: "calc(18px + var(--app-safe-area-top-effective, 0px))" }}
        >
          <button
            type="button"
            aria-label="Go back"
            onClick={() => router.back()}
            className="grid h-9 w-9 place-items-center rounded-full bg-black/[0.05] text-[#1d1d1f]/70 transition-colors hover:bg-black/[0.08] active:scale-95 dark:bg-white/10 dark:text-white/80 dark:hover:bg-white/15"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account actions"
                className="grid h-9 w-9 place-items-center rounded-full bg-black/[0.05] text-[#1d1d1f]/70 transition-colors hover:bg-black/[0.08] active:scale-95 dark:bg-white/10 dark:text-white/80 dark:hover:bg-white/15"
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void handleSignOut()}>
                <LogOut className="h-4 w-4 text-current" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Hero + OTP controls anchor to the bottom of the screen
            (justify-end), not vertically centered, so the whole verification
            surface sits within comfortable one-thumb reach on tall phones. */}
        <div className="flex flex-1 flex-col items-center justify-end px-6 pb-2 text-center">
          <span
            aria-hidden="true"
            className="select-none text-[48px] leading-none drop-shadow-[0_6px_14px_rgba(0,0,0,0.25)]"
          >
            🤫
          </span>
          <h1
            role="heading"
            aria-level={1}
            aria-label="Verify your phone number"
            className="mt-6 font-[family-name:var(--font-app-display)] text-[34px] font-extrabold leading-[1.05] tracking-[-1.1px] text-[#17130C] dark:text-[#FAF6EE]"
          >
            Verify your phone number
          </h1>
          <p className="mt-3 max-w-[20rem] text-[16px] leading-[1.45] text-[rgba(23,19,12,0.6)] dark:text-[rgba(250,246,238,0.62)]">
            Add your phone number to continue.
          </p>
        </div>

        {/* OTP controls sit directly on the shared hero background, matching
            the welcome/login pages. max-h + overflow-y-auto is a safety net:
            the page root is overflow-hidden, so on a very short screen
            (iPhone SE) a tall step scrolls WITHIN this region instead of
            clipping. It also subtracts --kb-height (KeyboardInsetManager;
            resize:"none") so the region fits above the on-screen keyboard and
            the focused OTP field is scrolled into view. Inert on desktop
            (--kb-height:0). See mobile-bug-log B21. */}
        <div
          className="relative overflow-y-auto px-6 pb-6"
          style={{ maxHeight: "calc(100dvh - 4rem - var(--kb-height, 0px))" }}
        >
          <PhoneVerificationFlow
            mode="link"
            currentPhoneNumber={phoneNumber}
            startVerification={startPhoneVerification}
            confirmVerification={confirmPhoneVerification}
            onCompleted={continueToNextRoute}
            onContinueExisting={continueToNextRoute}
            confirmLabel="Verify and continue"
            className="gap-5"
          />
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[13px] text-[#86868b] dark:text-white/45">
            <svg
              width="11"
              height="12"
              viewBox="0 0 11 12"
              fill="none"
              aria-hidden
            >
              <rect
                x="1.5"
                y="5"
                width="8"
                height="6"
                rx="1.6"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M3.2 5V3.7a2.3 2.3 0 014.6 0V5"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
            Used only to secure your vault. Never shared.
          </div>
          <div id="recaptcha-container" className="mt-4 min-h-0" />
        </div>
      </div>
    </main>
  );

  if (requiresVaultUnlockForRedirect(redirectPath)) {
    return <VaultLockGuard>{shell}</VaultLockGuard>;
  }

  return shell;
}

export default function RegisterPhonePage() {
  return (
    <Suspense fallback={null}>
      <PhoneMandatePageContent />
    </Suspense>
  );
}

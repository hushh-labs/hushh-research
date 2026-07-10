"use client";

import Image from "next/image";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, LogOut, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
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
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

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
      : null
  );

  if (loading || !user) {
    return <HushhLoader label="Loading phone verification..." variant="fullscreen" />;
  }

  if (shouldBypassLocalPhoneMandate) {
    return <HushhLoader label="Continuing local session..." variant="fullscreen" />;
  }

  const shell = (
    <main className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-[#0A0908] [--phone-mandate-safe-pb:calc(34px+var(--app-safe-area-bottom-effective,0px))] [--phone-mandate-safe-pt:calc(18px+var(--app-safe-area-top-effective,0px))]">
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />
      {/* Immersive hero glows */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[58%]">
        <span
          className="absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full"
          style={{ background: "rgba(212,175,106,0.26)", filter: "blur(80px)" }}
        />
        <span
          className="absolute -right-16 top-16 h-56 w-56 rounded-full"
          style={{ background: "rgba(212,175,106,0.14)", filter: "blur(80px)" }}
        />
      </div>

      <div className="relative mx-auto flex h-[100dvh] min-h-[100svh] w-full max-w-[440px] flex-col">
        {/* Top bar: back + account actions */}
        <div className="flex items-center justify-between px-5 pt-[var(--phone-mandate-safe-pt)]">
          <button
            type="button"
            aria-label="Go back"
            onClick={() => router.back()}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/15 active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account actions"
                className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/15 active:scale-95"
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

        {/* Dark hero */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 text-center">
          <div className="flex h-[84px] w-[84px] items-center justify-center rounded-[22px] border border-[rgba(214,175,106,0.30)] bg-gradient-to-b from-white/[0.16] to-white/[0.06] shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
            <Image
              src="/one-quiet-emoji.png"
              alt=""
              width={762}
              height={766}
              priority
              unoptimized
              aria-hidden="true"
              draggable={false}
              className="h-11 w-11 select-none object-contain [filter:drop-shadow(0_4px_10px_rgba(0,0,0,0.35))]"
            />
          </div>
          <h1
            role="heading"
            aria-level={1}
            aria-label="Verify your phone number"
            className="mt-6 font-[family-name:var(--font-app-display)] text-[34px] font-extrabold leading-[1.05] tracking-[-1px] text-[#FAF6EE]"
          >
            Verify your phone number
          </h1>
          <p className="mt-3 max-w-[20rem] text-[16px] text-[rgba(250,246,238,0.62)]">
            Add your phone number to continue.
          </p>
        </div>

        {/* White form sheet. max-h + overflow-y-auto is a safety net: with
            Keyboard.resize:"native" the viewport shrinks above the keyboard, and
            the page root is overflow-hidden, so on a very short screen (iPhone SE)
            a tall step scrolls WITHIN the sheet instead of clipping. At rest the
            content is short so no scroll appears — resting look is unchanged. */}
        <div className="relative max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-t-[34px] bg-white px-6 pt-7 pb-[var(--phone-mandate-safe-pb)] shadow-[0_-16px_50px_rgba(0,0,0,0.45)] dark:bg-[#141416]">
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
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[13px] text-black/40 dark:text-white/45">
            <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden>
              <rect x="1.5" y="5" width="8" height="6" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M3.2 5V3.7a2.3 2.3 0 014.6 0V5" stroke="currentColor" strokeWidth="1.3" />
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
    <Suspense fallback={<HushhLoader label="Loading phone verification..." variant="fullscreen" />}>
      <PhoneMandatePageContent />
    </Suspense>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
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
import {
  buildOneSetupRoute,
  KAI_MARKET_PATH,
  ROUTES,
} from "@/lib/navigation/routes";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { RiaService } from "@/lib/services/ria-service";
import {
  buildRiaClaimRoute,
  isClaimableLookupOutcome,
  resolveVerifiedPhone,
} from "@/lib/ria/ria-claim-entry";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { resolvePostPhoneOnboardingPhase } from "@/lib/onboarding/onboarding-journey-phase";

function requiresVaultUnlockForRedirect(path?: string | null): boolean {
  const normalizedPath = String(path ?? "").trim();
  if (!normalizedPath) {
    return false;
  }

  return (
    normalizedPath === KAI_MARKET_PATH ||
    normalizedPath.startsWith(`${KAI_MARKET_PATH}/`) ||
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
      // Phone verification is an onboarding boundary, not a generic post-auth
      // redirect. Refresh the authoritative root state before resolving a
      // destination: a stale cached bootstrap result must never let a newly
      // verified account skip One setup and land in Profile/Home.
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
      const idToken = await activeUser.getIdToken().catch(() => undefined);

      // The number they just verified is the trigger for claiming: if the SEC
      // lists a firm or advisers at it, show that instead of the generic next
      // screen. Fails open — any error, timeout or miss continues as normal.
      const claimRoute = await (async () => {
        // identity.phone_number is the authoritative verified number. The
        // Firebase user object is null here whenever the phone was confirmed
        // through the backend test-code path or any non-Firebase channel --
        // that path returns the unchanged user and only records the phone
        // server-side, so reading activeUser.phoneNumber skips recognition
        // exactly when it is needed.
        const verifiedPhone = resolveVerifiedPhone({
          identityPhone: identity?.phone_number,
          contextPhone: phoneNumber,
          firebasePhone: activeUser.phoneNumber,
        });
        if (!idToken || !verifiedPhone) return null;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12_000);
          const lookup = await RiaService.claimLookup(
            idToken,
            { phone: verifiedPhone },
            { signal: controller.signal },
          ).finally(() => clearTimeout(timer));
          return isClaimableLookupOutcome(lookup)
            ? buildRiaClaimRoute(verifiedPhone, { returnTo: redirectPath })
            : null;
        } catch {
          return null;
        }
      })();

      const nextPath = claimRoute
        ? claimRoute
        : setupResolved
        ? await PostAuthRouteService.resolveAfterLogin({
            userId: activeUser.uid,
            redirectPath,
            idToken,
            phoneNumber: activeUser.phoneNumber,
            phoneVerified: AccountIdentityService.hasVerifiedPhone(identity),
          })
        : buildOneSetupRoute({ returnTo: redirectPath });
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
    [redirectPath, refreshUser, router, user, phoneNumber],
  );

  const [verificationStep, setVerificationStep] = useState<
    "phone" | "code" | "linked"
  >("phone");

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

  // This screen never host-redirects away. It used to detect localhost/dev
  // hostnames and bounce straight to the setup hub, which turned the one
  // reachable phone screen into a dead end while the server still required a
  // verified phone before recording a cloud (observed on dev, 2026-08-19). The
  // GUARD may exempt localhost from forcing this screen (Firebase reCAPTCHA
  // cannot complete there), but an explicit visit always renders the flow, and
  // the fictitious-number allowlist (+1 555 0100-0199) completes it without
  // captcha or SMS in development lanes; production numbers ride the real SMS
  // challenge.
  usePublishVoiceSurfaceMetadata(
    !loading && user
      ? {
          screenId: "phone_mandate",
          title: "Verify your phone",
          purpose:
            "Adding a phone number keeps your account recoverable and secure before setup continues.",
          // The step is the only verification state published to One. Phone
          // numbers and OTPs stay inside the input and auth operation.
          screenMetadata: { phone_verification_step: verificationStep },
          actions:
            verificationStep === "phone"
              ? [
                  {
                    id: "phone_mandate.submit_number",
                    actionId: "phone_mandate.submit_number",
                    label: "Send verification code",
                    purpose: "Send a code after the phone form is completed.",
                  },
                ]
              : verificationStep === "code"
                ? [
                    {
                      id: "phone_mandate.submit_code",
                      actionId: "phone_mandate.submit_code",
                      label: "Confirm verification code",
                      purpose: "Confirm the code in the current verification form.",
                    },
                  ]
                : [],
          controls:
            verificationStep === "phone"
              ? [
                  {
                    id: "phone-flow-number",
                    label: "Phone number",
                    type: "tel",
                    actionId: "phone_mandate.submit_number",
                  },
                ]
              : verificationStep === "code"
                ? [
                    {
                      id: "phone-flow-code",
                      label: "Verification code",
                      type: "text",
                      actionId: "phone_mandate.submit_code",
                    },
                  ]
                : [],
        }
      : null,
    { role: "route", routeKey: ROUTES.PHONE_MANDATE },
  );

  if (loading || !user) {
    return (
      <HushhLoader label="Loading phone verification..." variant="fullscreen" />
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

        {/* Verification is a focused task, not a hero. Keep the heading tight
            so the active field row can clear the native keyboard. */}
        <div className="px-6 pb-3 pt-7 text-center">
          <h1
            role="heading"
            aria-level={1}
            aria-label="Verify your phone number"
            className="font-[family-name:var(--font-app-display)] text-[28px] font-extrabold leading-[1.1] tracking-[-0.9px] text-[#17130C] dark:text-[#FAF6EE]"
          >
            Verify your phone number
          </h1>
          <p className="mx-auto mt-1.5 max-w-[20rem] text-[15px] leading-[1.4] text-[rgba(23,19,12,0.6)] dark:text-[rgba(250,246,238,0.62)]">
            Add your phone number to continue. It&rsquo;s how your private agent is bound to you.
          </p>
        </div>

        {/* The active field group owns the keyboard clearance. The keyboard
            plugin leaves the WebView frame stable, so padding—not a `dvh`
            resize—keeps both the number and OTP fields visibly above iOS and
            Android keyboards. Tiny screens may scroll this one form region. */}
        <div
          data-phone-mandate-input-region="true"
          className="relative mt-3 max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain px-6 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            paddingBottom:
              "max(calc(1rem + var(--app-safe-area-bottom-effective, 0px)), calc(1rem + var(--kb-height, 0px)))",
          }}
        >
          <PhoneVerificationFlow
            mode="link"
            currentPhoneNumber={phoneNumber}
            startVerification={startPhoneVerification}
            confirmVerification={confirmPhoneVerification}
            onCompleted={continueToNextRoute}
            onContinueExisting={continueToNextRoute}
            onStepChange={setVerificationStep}
            confirmLabel="Verify and continue"
            className="gap-5"
          />
          <div id="recaptcha-container" className="mt-3 min-h-0" />
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

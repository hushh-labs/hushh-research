"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, LogOut, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { FigmaIllustration } from "@/components/onboarding/FigmaOnboardingPrimitives";
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
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { resolvePostPhoneOnboardingPhase } from "@/lib/onboarding/onboarding-journey-phase";
import { cn } from "@/lib/utils";
import styles from "./page.module.css";

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
            hostname: window.location.hostname,
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

  const [shouldBypassLocalPhoneMandate, setShouldBypassLocalPhoneMandate] =
    useState(false);
  const [verificationStep, setVerificationStep] = useState<
    "phone" | "code" | "linked"
  >("phone");
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

  // Gate on identity, never on `loading`.
  //
  // `loading` is not "the page is still booting" -- the web auth observer sets
  // it true on every re-validation (lib/firebase/auth-context.tsx:1369), and
  // starting Firebase phone verification is exactly the kind of event that
  // triggers one. Returning a fullscreen loader here UNMOUNTS
  // PhoneVerificationFlow, and its `step` lives in useState, so a person who
  // had just been sent a code was silently put back on the phone form: the
  // "Verification code sent" toast had already fired, and the OTP screen they
  // needed was destroyed before they could type into it.
  //
  // A signed-out visitor still sees this loader -- `user` is null -- while the
  // redirect at the top of this component sends them to /login.
  if (!user) {
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
      className={cn(
        "relative w-full overflow-hidden bg-[#f6f5fc] dark:bg-black",
        styles.shell,
      )}
      style={{
        height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
        minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
      }}
      data-testid="phone-mandate-screen"
    >
      {/* Verification is a focused task, not a hero; the Figma illustration
          is a compact visual anchor above the form rather than a new flow. */}
      <OnboardingHeroBackground variant="solid" />
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />

      <div className={styles.stage}>
        <div
          className={cn(
            "relative mx-auto flex w-full max-w-[440px] flex-col",
            styles.composition,
          )}
          style={{
            height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
            minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
          }}
        >
        {/* Top bar: back + account actions */}
        <div
          className={cn(
            "absolute inset-x-0 z-30 flex items-center justify-between px-5",
            styles.topBar,
          )}
          style={{
            top: "max(0px, calc(54px - var(--app-safe-area-top-effective, 0px)))",
            paddingTop: "calc(18px + var(--app-safe-area-top-effective, 0px))",
          }}
        >
          <button
            type="button"
            aria-label="Go back"
            onClick={() => router.back()}
            className={cn(
              "grid h-11 w-11 place-items-center rounded-full bg-white/[0.52] text-[#1d1d1f]/70 shadow-[0_4px_15px_rgba(150,196,255,0.22)] transition-colors hover:bg-white/[0.75] active:scale-95 dark:bg-[#1c1c1e]/85 dark:text-white/90 dark:shadow-none dark:hover:bg-[#303034]",
              styles.phoneBackButton,
            )}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account actions"
                className={cn(
                  "grid h-11 w-11 place-items-center rounded-full bg-white/[0.52] text-[#1d1d1f]/70 shadow-[0_4px_15px_rgba(150,196,255,0.22)] transition-colors hover:bg-white/[0.75] active:scale-95 dark:bg-[#1c1c1e]/85 dark:text-white/90 dark:shadow-none dark:hover:bg-[#303034]",
                  styles.accountButton,
                )}
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

        <div className={cn("absolute left-1/2 top-[78px] -translate-x-1/2", styles.phoneIllustrationSlot)}>
          <FigmaIllustration variant="phone" className={styles.phoneIllustration} />
        </div>

        <div className={cn("absolute inset-x-6 top-[373px] text-center", styles.phoneTitle)}>
          <h1
            role="heading"
            aria-level={1}
            aria-label={
              verificationStep === "code"
                ? "Enter verification code"
                : "Verify your phone number"
            }
            className="whitespace-nowrap font-[family-name:var(--font-app-display)] text-[27px] font-bold leading-[1.1] tracking-[-0.7px] text-[#0a0a0a] dark:text-[#fafafa]"
          >
            {verificationStep === "code"
              ? "Enter verification code"
              : "Verify your phone number"}
          </h1>
        </div>

        {/* The active field group owns the keyboard clearance. The keyboard
            plugin leaves the WebView frame stable, so padding—not a `dvh`
            resize—keeps both the number and OTP fields visibly above iOS and
            Android keyboards. Tiny screens may scroll this one form region. */}
        <div
          data-phone-mandate-input-region="true"
          className={cn(
            `absolute inset-x-0 bottom-0 top-[438px] overflow-y-auto overscroll-contain px-6 pt-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${verificationStep === "code" ? "top-[432px]" : ""}`,
            styles.inputRegion,
          )}
          style={{
            paddingBottom:
              "max(calc(1rem + var(--app-safe-area-bottom-effective, 0px)), calc(1rem + var(--kb-height, 0px)))",
          }}
        >
          <PhoneVerificationFlow
            key={user.uid}
            mode="link"
            currentPhoneNumber={phoneNumber}
            startVerification={startPhoneVerification}
            confirmVerification={confirmPhoneVerification}
            onCompleted={continueToNextRoute}
            onContinueExisting={continueToNextRoute}
            onStepChange={setVerificationStep}
            sendCodeLabel="Send a verification code"
            confirmLabel="Verify"
            primaryActionClassName={cn("mx-auto max-w-[21.5rem]", styles.phoneSubmitButton)}
            className={cn("flex flex-col gap-5", styles.phoneForm)}
            helperText=""
          />
          <div id="recaptcha-container" className={cn("mt-3 min-h-0", styles.recaptcha)} />
        </div>
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

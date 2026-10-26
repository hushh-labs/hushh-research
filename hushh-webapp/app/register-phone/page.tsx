"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, LogOut, MoreHorizontal } from "@/components/icons";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { PhoneVerificationScene } from "@/components/auth/phone-verification-scene";
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
  normalizeStaticExportPathname,
  normalizeInvitationReturnTo,
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
import { shouldBypassPhoneMandateForLocalhost } from "@/lib/services/phone-mandate-service";
import { RiaService } from "@/lib/services/ria-service";
import {
  buildRiaClaimRoute,
  isClaimableLookupOutcome,
  resolveVerifiedPhone,
} from "@/lib/ria/ria-claim-entry";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { resolvePostPhoneOnboardingPhase } from "@/lib/onboarding/onboarding-journey-phase";
import { useBackLayer } from "@/lib/navigation/back-layers";
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
    sessionVerificationRequired,
    retrySessionVerification,
    startPhoneVerification,
    confirmPhoneVerification,
    confirmPhoneTransfer,
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
        // Finish the invitation the person chose before optional discovery.
        if (normalizeInvitationReturnTo(redirectPath)) return null;
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
  const codeBackRef = useRef<(() => boolean) | null>(null);
  const setCodeBackHandler = useCallback((handler: (() => boolean) | null) => {
    codeBackRef.current = handler;
  }, []);
  const returnFromCode = useCallback(() => {
    if (verificationStep !== "code") return false;
    return codeBackRef.current?.() ?? true;
  }, [verificationStep]);
  useBackLayer(ROUTES.PHONE_MANDATE, verificationStep === "code" ? 2 : 0, returnFromCode);
  const [admission, setAdmission] = useState<{
    userId: string;
    status: "ready" | "redirecting" | "error";
  } | null>(null);
  const [admissionRetry, setAdmissionRetry] = useState(0);

  useEffect(() => {
    if (!user || sessionVerificationRequired) return;
    const userId = user.uid;
    let cancelled = false;
    setAdmission(null);
    // An explicit local visit remains usable for the development phone flow.
    // The route guard, rather than this page, owns any localhost exemption.
    if (shouldBypassPhoneMandateForLocalhost(window.location.hostname)) {
      setAdmission({ userId, status: "ready" });
      return;
    }
    void (async () => {
      if (admissionRetry > 0) {
        await PreVaultUserStateService.bootstrapState(userId, { force: true });
      }
      // Accepting a token invitation is an explicit phone-verification operation.
      // Generic onboarding correctly exempts established accounts, but applying
      // that exemption here bounced them back to the invite before any OTP form.
      const invitation = normalizeInvitationReturnTo(redirectPath);
      const invitationUrl = invitation ? new URL(invitation, window.location.origin) : null;
      const invitationPath = invitationUrl && normalizeStaticExportPathname(invitationUrl.pathname);
      const isTokenInvitation = Boolean(invitationUrl && (
        /^\/one\/location\/invite\/[^/]+$/.test(invitationPath!) ||
        (invitationPath === ROUTES.CIRCLE_JOIN && invitationUrl.searchParams.get("invite")?.trim())
      ));
      if (isTokenInvitation) {
        const identity = await AccountIdentityService.syncCurrentUser(user);
        if (cancelled) return;
        if (typeof identity?.phone_verified !== "boolean") {
          throw new Error("Unable to check phone verification. Please retry.");
        }
        if (!identity.phone_verified) {
          setAdmission({ userId, status: "ready" });
          return;
        }
      }
      const nextPath = await PostAuthRouteService.resolveAfterLogin({
        userId,
        redirectPath,
        phoneNumber,
        hostname: window.location.hostname,
        allowNativeRouteAuditBypass: false,
      });
      if (cancelled) return;
      const needsPhone = normalizeStaticExportPathname(
        new URL(nextPath, window.location.origin).pathname,
      ) === ROUTES.PHONE_MANDATE;
      setAdmission({ userId, status: needsPhone ? "ready" : "redirecting" });
      if (!needsPhone) router.replace(nextPath);
    })().catch(() => {
      if (!cancelled) setAdmission({ userId, status: "error" });
    });
    return () => { cancelled = true; };
    // Admission is per owner, not per token refresh or OTP callback. Once the
    // form opens, keep it mounted until its completion handler settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, redirectPath, admissionRetry, sessionVerificationRequired]);

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

  // Admission moves an established account to its owning route. An explicit
  // localhost visit remains on the phone flow; the route guard owns any local
  // exemption. The development number allowlist can complete this flow without
  // SMS, while production numbers use the real challenge.
  usePublishVoiceSurfaceMetadata(
    !loading && user
      ? {
          screenId: "phone_mandate",
          title: "Verify your phone",
          purpose:
            "Verify your phone to continue setup or accept your invitation.",
          // The step is the only verification state published to One. Phone
          // numbers and OTPs stay inside the input and auth operation.
          screenMetadata: { phone_verification_step: verificationStep },
          actions:
            verificationStep === "phone"
              ? [
                  {
                    id: "phone_mandate.submit_number",
                    actionId: "phone_mandate.submit_number",
                    label: "Send a verification code",
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
      <HushhLoader stage="phone" label="Loading phone verification..." />
    );
  }

  if (sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  if (admission?.userId === user.uid && admission.status === "error") {
    return (
      <SessionVerificationRecovery
        onRetry={() => setAdmissionRetry((attempt) => attempt + 1)}
        onSignOut={() => void handleSignOut()}
      />
    );
  }

  if (admission?.userId !== user.uid || admission.status !== "ready") {
    return <HushhLoader stage="phone" label="Checking phone requirement..." />;
  }
  const shell = (
    <main className={styles.shell} data-testid="phone-mandate-screen" data-phone-step={verificationStep}>
      <NativeRouteMarker
        routeId={ROUTES.PHONE_MANDATE}
        marker="native-route-register-phone"
        authState="authenticated"
        dataState="loaded"
      />

      <button
        type="button"
        aria-label="Go back"
        onClick={() => { if (!returnFromCode()) router.back(); }}
        className={styles.backButton}
      >
        <ChevronLeft className="h-[18px] w-[18px]" weight="bold" />
      </button>

      <div className={styles.accountActions}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account actions"
              className={styles.accountButton}
            >
              <MoreHorizontal className="h-[18px] w-[18px]" weight="bold" />
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

      <div className={styles.surface}>
        <PhoneVerificationScene step={verificationStep === "code" ? "code" : "phone"} />
        <div className={styles.content}>
          <h1>
            {verificationStep === "code" ? "Enter your code" : verificationStep === "phone" ? "Enter your phone number" : "Verify your phone number"}
          </h1>
          <div data-phone-mandate-input-region="true" className={styles.inputRegion}>
            <PhoneVerificationFlow
              key={user.uid}
              mode="link"
              currentPhoneNumber={phoneNumber}
              startVerification={startPhoneVerification}
              confirmVerification={confirmPhoneVerification}
              confirmTransfer={confirmPhoneTransfer}
              recoverPreviousAccount={() => signOut({ redirectTo: `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.PROFILE)}` })}
              deletePreviousAccount={() => signOut({ redirectTo: `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.PROFILE)}` })}
              onCompleted={continueToNextRoute}
              onContinueExisting={continueToNextRoute}
              onStepChange={setVerificationStep}
              onBackStepChange={setCodeBackHandler}
              sendCodeLabel="Continue"
              phonePresentation="compact"
              confirmLabel="Confirm"
              codePresentation="onboarding"
              primaryActionClassName={styles.primaryAction}
              className={styles.phoneForm}
              helperText={
                <>
                  We may send SMS notifications.{" "}
                  <Dialog modal>
                    <DialogTrigger asChild>
                      <button type="button" className={styles.learnMore}>
                        Learn more
                      </button>
                    </DialogTrigger>
                    <DialogContent srDescription="How your mobile number is used">
                      <DialogTitle>About SMS notifications</DialogTitle>
                      <p>
                        We’ll send a verification code to confirm your mobile
                        number. You may also receive SMS notifications from Hushh.
                      </p>
                    </DialogContent>
                  </Dialog>
                </>
              }
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
    <Suspense fallback={<HushhLoader stage="phone" label="Loading phone verification..." />}>
      <PhoneMandatePageContent />
    </Suspense>
  );
}

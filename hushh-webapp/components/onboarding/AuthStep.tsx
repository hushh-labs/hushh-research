"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Lock, Shield } from "lucide-react";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { useAuth } from "@/lib/firebase/auth-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isAndroid } from "@/lib/capacitor/platform";
import { Icon } from "@/lib/morphy-ux/ui";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";
import {
  isOnboardingFlowActiveCookieEnabled,
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { buildWelcomeRoute, ROUTES } from "@/lib/navigation/routes";
import { type KaiLegalDocumentType } from "@/lib/legal/kai-legal-content";
import { trackEvent } from "@/lib/observability/client";
import {
  resolveGrowthEntrySurface,
  resolveGrowthJourneyForPath,
  trackGrowthFunnelStepCompleted,
} from "@/lib/observability/growth";
import {
  getNativeTestConfig,
  useNativeTestConfig,
} from "@/lib/testing/native-test";
import { resolveLocalReviewerCredentials } from "@/lib/testing/local-reviewer-auth";

// Firebase error codes that mean the user deliberately dismissed the provider
// popup. These are not real failures, so we stay silent for them and only toast
// on genuine errors (network, account-exists, blocked popup, etc.).
const AUTH_CANCEL_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
]);

// One first choice, one quiet alternative: Apple is a solid black card, Google
// a white card with a hairline edge, in BOTH themes so the pair never swaps
// rank on a dark sheet. Reviewer stays an outlined tertiary.
//
// Three sizing rules this file learned the hard way:
//  * `size="lg"` sets BOTH h-[50px] and min-h-[50px] (components/ui/button.tsx)
//    and tailwind-merge treats them as separate groups, so a height override
//    must set both or the control silently keeps the other value.
//  * `rounded-full` is applied three times up the stack; only a later
//    `rounded-*` replaces it.
//  * `.ui-text-button-label` (globals.css) forces `opacity: 1 !important`, so
//    the primitive's `disabled:opacity-50` never paints here. The busy state
//    has to be a solid colour swap, or a disabled button still looks tappable.
const SHARED_PROVIDER_BTN_CLASS =
  "h-[56px] min-h-[56px] rounded-[18px] shadow-none";
const APPLE_BTN_EDGE = "border border-transparent dark:border-white/15";
const GOOGLE_BTN_EDGE = "border border-black/10 dark:border-white/15";

// Idle and busy are two whole treatments, never a base plus a `disabled:`
// override. Measured in Chromium: a `disabled:!bg-*` utility loses the cascade
// to the plain `!bg-*` it is meant to replace, so the button stayed fully
// black while sign-in was in flight — a dead control that still looked
// tappable. Swapping the entire class string means only one background rule
// is ever in the list.
const APPLE_BTN_CLASS =
  `${SHARED_PROVIDER_BTN_CLASS} ${APPLE_BTN_EDGE} !bg-black !text-white hover:!bg-[#141414] hover:text-white dark:!bg-black dark:!text-white dark:hover:!bg-[#141414]`;
const APPLE_BTN_BUSY_CLASS =
  `${SHARED_PROVIDER_BTN_CLASS} ${APPLE_BTN_EDGE} !bg-[#8a8a8e] !text-white dark:!bg-[#3a3a3c] dark:!text-white/70`;
const GOOGLE_BTN_CLASS =
  `${SHARED_PROVIDER_BTN_CLASS} ${GOOGLE_BTN_EDGE} !bg-white !text-[#1d1d1f] hover:!bg-[#f5f5f7] hover:text-[#1d1d1f] dark:!bg-white dark:!text-[#1d1d1f] dark:hover:!bg-[#f5f5f7]`;
const GOOGLE_BTN_BUSY_CLASS =
  `${SHARED_PROVIDER_BTN_CLASS} ${GOOGLE_BTN_EDGE} !bg-[#e5e5ea] !text-[#6e6e73] dark:!bg-[#2c2c2e] dark:!text-white/50`;
const REVIEWER_BTN_CLASS =
  `${SHARED_PROVIDER_BTN_CLASS} !bg-transparent !text-[#6b6b70] border border-black/10 hover:!bg-black/[0.03] dark:!text-white/60 dark:border-white/15 dark:hover:!bg-white/[0.05]`;

type AuthProviderId = "google" | "apple";
type ProviderAttemptPhase =
  "launching" | "provider_open" | "attention_required" | "settling";
type ProviderAttempt = {
  id: string;
  provider: AuthProviderId;
  initiator: "tap" | "voice_confirmation";
  directiveId: string | null;
  resumeRoute: string;
  phase: ProviderAttemptPhase;
  startedAt: number;
};

function isAuthCancel(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return AUTH_CANCEL_CODES.has(code);
}

function debugLog(...args: unknown[]) {
  if (process.env.NODE_ENV !== "production") {
    console.log(...args);
  }
}

function debugError(label: string, error?: unknown) {
  if (process.env.NODE_ENV !== "production" && error !== undefined) {
    console.error(label, error);
    return;
  }
  console.error(label);
}

function authErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "auth/account-exists-with-different-credential") {
      return "An account already exists with this email using a different sign-in method.";
    }
    if (code === "auth/network-request-failed") {
      return "Network error. Check your connection and try again.";
    }
    if (code === "auth/popup-blocked") {
      return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : "Sign-in failed. Please try again.";
}

export function AuthStep({
  redirectPath,
}: {
  redirectPath: string;
  compact?: boolean;
}) {
  const nativeTestConfig = useNativeTestConfig();
  const router = useRouter();
  const {
    user,
    loading: authLoading,
    beginPostAuthSettlement,
    completePostAuthSettlement,
  } = useAuth();
  const { registerSteps, completeStep, reset } = useStepProgress();
  const lastNavigationKeyRef = useRef<string | null>(null);
  const lastResolvedNavigationPathRef = useRef<string | null>(null);
  const autoReviewerLoginStartedRef = useRef(false);
  const [nativeReviewerVisible, setNativeReviewerVisible] = useState(
    nativeTestConfig.autoReviewerLogin,
  );
  const [nativeAuthState, setNativeAuthState] = useState<
    "anonymous" | "pending" | "authenticated"
  >(nativeTestConfig.autoReviewerLogin ? "pending" : "anonymous");
  const [nativeDataState, setNativeDataState] = useState<
    "loading" | "loaded" | "error"
  >(nativeTestConfig.autoReviewerLogin ? "loading" : "loaded");
  const [nativeErrorCode, setNativeErrorCode] = useState<string | null>(null);
  const providerAttemptRef = useRef<ProviderAttempt | null>(null);
  const providerAttemptSequenceRef = useRef(0);
  const attentionResolversRef = useRef(
    new Map<string, (result: { status: "started"; summary: string }) => void>(),
  );
  const [providerAttempt, setProviderAttempt] =
    useState<ProviderAttempt | null>(null);
  const providerBusy = Boolean(
    providerAttempt && providerAttempt.phase !== "attention_required",
  );

  const [reviewModeConfig, setReviewModeConfig] = useState<{
    enabled: boolean;
  }>({ enabled: false });
  const shouldUseNativeTestBootstrap =
    nativeTestConfig.enabled &&
    nativeTestConfig.autoReviewerLogin &&
    Boolean(nativeTestConfig.expectedUserId) &&
    Boolean(nativeTestConfig.vaultPassphrase);
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_FINANCE &&
    redirectPath === ROUTES.ONE_SETUP_FINANCE;
  const growthJourney = useMemo(
    () => resolveGrowthJourneyForPath(redirectPath),
    [redirectPath],
  );
  const growthEntrySurface = useMemo(
    () => resolveGrowthEntrySurface(redirectPath),
    [redirectPath],
  );
  const [activeLegalDoc, setActiveLegalDoc] =
    useState<KaiLegalDocumentType | null>(null);
  const legalReturnControlIdRef = useRef<string | null>(null);
  const legalCloseResolversRef = useRef<Array<() => void>>([]);

  const publishProviderAttempt = useCallback(
    (attempt: ProviderAttempt | null) => {
      providerAttemptRef.current = attempt;
      setProviderAttempt(attempt);
    },
    [],
  );

  const updateProviderAttemptPhase = useCallback(
    (attemptId: string, phase: ProviderAttemptPhase) => {
      const current = providerAttemptRef.current;
      if (!current || current.id !== attemptId) return false;
      publishProviderAttempt({ ...current, phase });
      return true;
    },
    [publishProviderAttempt],
  );

  useEffect(() => {
    let attentionTimer: number | null = null;
    const scheduleAttentionRecovery = () => {
      const current = providerAttemptRef.current;
      if (
        !current ||
        (current.phase !== "launching" && current.phase !== "provider_open") ||
        Date.now() - current.startedAt < 250
      ) {
        return;
      }
      if (attentionTimer !== null) return;
      attentionTimer = window.setTimeout(() => {
        attentionTimer = null;
        const active = providerAttemptRef.current;
        if (
          !active ||
          active.id !== current.id ||
          (active.phase !== "launching" && active.phase !== "provider_open") ||
          user
        ) {
          return;
        }
        updateProviderAttemptPhase(active.id, "attention_required");
        attentionResolversRef.current.get(active.id)?.({
          status: "started",
          summary: `${active.provider === "apple" ? "Apple" : "Google"} sign-in still needs attention. You can retry securely.`,
        });
        attentionResolversRef.current.delete(active.id);
      }, 750);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleAttentionRecovery();
    };
    window.addEventListener("focus", scheduleAttentionRecovery);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const focusPoll = window.setInterval(() => {
      if (document.hasFocus()) scheduleAttentionRecovery();
    }, 250);
    return () => {
      if (attentionTimer !== null) window.clearTimeout(attentionTimer);
      window.clearInterval(focusPoll);
      window.removeEventListener("focus", scheduleAttentionRecovery);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [updateProviderAttemptPhase, user]);

  const openLegalDoc = useCallback(async (docType: KaiLegalDocumentType) => {
    // Defer open so the originating tap does not get interpreted as outside-interact.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        legalReturnControlIdRef.current =
          docType === "terms" ? "auth_terms" : "auth_privacy";
        setActiveLegalDoc(docType);
        resolve();
      });
    });
  }, []);

  const closeLegalDoc = useCallback(async () => {
    if (!activeLegalDoc) return;
    await new Promise<void>((resolve) => {
      legalCloseResolversRef.current.push(resolve);
      setActiveLegalDoc(null);
    });
  }, [activeLegalDoc]);

  useEffect(() => {
    if (activeLegalDoc || legalCloseResolversRef.current.length === 0) return;
    requestAnimationFrame(() => {
      const returnControlId = legalReturnControlIdRef.current;
      if (returnControlId) {
        document
          .querySelector<HTMLElement>(
            `[data-voice-control-id="${returnControlId}"]`,
          )
          ?.focus();
      }
      legalReturnControlIdRef.current = null;
      const resolvers = legalCloseResolversRef.current.splice(0);
      resolvers.forEach((resolve) => resolve());
    });
  }, [activeLegalDoc]);

  useEffect(
    () => () => {
      legalCloseResolversRef.current.splice(0).forEach((resolve) => resolve());
    },
    [],
  );

  const returnToWelcome = useCallback(async () => {
    // A stale directive must not pull the person away from an OAuth attempt.
    if (providerBusy) {
      return {
        status: "blocked" as const,
        summary: "Sign-in is still in progress.",
      };
    }
    // A legal document is nested beneath Login, so return to Login before
    // considering the journey parent even if an old directive arrives late.
    if (activeLegalDoc) {
      await closeLegalDoc();
      return {
        status: "succeeded" as const,
        summary: "Returned to sign-in.",
      };
    }
    // Login has one logical parent in the app-router hierarchy: One's public
    // introduction. Browser history can point at an external OAuth page, a
    // protected deep link, or a stale pre-auth page, none of which is a safe
    // back destination. Keep a valid pending destination on the welcome
    // screen so claiming One again resumes the same journey.
    router.replace(
      buildWelcomeRoute(redirectPath === ROUTES.HOME ? null : redirectPath),
    );
    return {
      status: "started" as const,
      summary: "Returning to One's welcome screen.",
      routeAfter: buildWelcomeRoute(
        redirectPath === ROUTES.HOME ? null : redirectPath,
      ),
      screenAfter: "one_intro",
    };
  }, [activeLegalDoc, closeLegalDoc, providerBusy, redirectPath, router]);

  const handleBack = useCallback(() => {
    void returnToWelcome();
  }, [returnToWelcome]);

  const resolveAndNavigate = useCallback(
    async (
      userId: string,
      idToken?: string,
      phoneNumber?: string | null,
      resumeTarget?: string,
    ) => {
      const targetPath = resumeTarget || redirectPath;
      const navigationKey = `${userId}:${targetPath || ROUTES.KAI_HOME}`;
      if (lastNavigationKeyRef.current === navigationKey) {
        return (
          lastResolvedNavigationPathRef.current || targetPath || ROUTES.ONE_HOME
        );
      }
      lastNavigationKeyRef.current = navigationKey;

      try {
        if (preserveOnboardingAuditRoute) {
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          router.push(ROUTES.ONE_SETUP_FINANCE);
          lastResolvedNavigationPathRef.current = ROUTES.ONE_SETUP_FINANCE;
          return ROUTES.ONE_SETUP_FINANCE;
        }
        const resolvedIdToken =
          idToken ||
          (user ? await user.getIdToken().catch(() => undefined) : undefined);
        const resolvedPath = await PostAuthRouteService.resolveAfterLogin({
          userId,
          redirectPath: targetPath,
          idToken: resolvedIdToken,
          phoneNumber,
          enableFirstRunSetupGate: true,
        });

        const resumeImportFlow =
          resolvedPath === ROUTES.KAI_HOME &&
          isOnboardingFlowActiveCookieEnabled();
        const nextPath = resumeImportFlow ? ROUTES.KAI_IMPORT : resolvedPath;

        // This runs only after Firebase's redirect callback has produced a
        // user. The provider launch itself remains a `started` settlement;
        // the durable journey is never advanced merely because a redirect was
        // opened or a popup was requested.
        await PreVaultUserStateService.syncOnboardingJourney({
          userId,
          phase:
            nextPath === ROUTES.PHONE_MANDATE ? "phone_required" : "setup_hub",
          callbackState: "succeeded",
          idToken: resolvedIdToken,
        }).catch((journeyError) => {
          // The existing post-auth route remains the rollback path while the
          // additive journey migration rolls out.
          console.warn(
            "[AuthStep] Failed to persist onboarding journey:",
            journeyError,
          );
        });
        setOnboardingRequiredCookie(nextPath === ROUTES.ONE_SETUP);
        setOnboardingFlowActiveCookie(nextPath === ROUTES.KAI_IMPORT);
        // Replace, not push: the login screen must not stay on the back stack,
        // so an onboarded user pressing Back never lands back on /login or the
        // setup hub it forwards to.
        router.replace(nextPath);
        lastResolvedNavigationPathRef.current = nextPath;
        return nextPath;
      } catch (error) {
        console.warn("[AuthStep] Failed to resolve post-auth route:", error);
        const fallbackPath = targetPath || ROUTES.KAI_HOME;
        const safeFallbackPath =
          fallbackPath === ROUTES.ONE_SETUP ||
          fallbackPath === ROUTES.ONE_SETUP_FINANCE ||
          fallbackPath === ROUTES.KAI_IMPORT
            ? ROUTES.KAI_HOME
            : fallbackPath;
        setOnboardingRequiredCookie(safeFallbackPath === ROUTES.ONE_SETUP);
        setOnboardingFlowActiveCookie(safeFallbackPath === ROUTES.KAI_IMPORT);
        router.replace(safeFallbackPath);
        lastResolvedNavigationPathRef.current = safeFallbackPath;
        return safeFallbackPath;
      }
    },
    [preserveOnboardingAuditRoute, redirectPath, router, user],
  );

  useEffect(() => {
    registerSteps(1);
    return () => reset();
  }, [registerSteps, reset]);

  useEffect(() => {
    if (!growthJourney || authLoading || user) return;
    trackGrowthFunnelStepCompleted({
      journey: growthJourney,
      step: "entered",
      entrySurface: growthEntrySurface,
      dedupeKey: `growth:${growthJourney}:entered:${growthEntrySurface}`,
      dedupeWindowMs: 5_000,
    });
  }, [authLoading, growthEntrySurface, growthJourney, user]);

  useEffect(() => {
    if (authLoading) return;
    completeStep();
    // Provider popup attempts own token verification and navigation while
    // active. The ordinary auth observer handles only restored sessions.
    if (user && !providerAttemptRef.current) {
      if (growthJourney) {
        trackGrowthFunnelStepCompleted({
          journey: growthJourney,
          step: "auth_completed",
          entrySurface: growthEntrySurface,
          authMethod: "existing_session",
          dedupeKey: `growth:${growthJourney}:auth_completed:existing_session`,
          dedupeWindowMs: 5_000,
        });
      }
      debugLog("[AuthStep] User authenticated, navigating to:", redirectPath);
      void resolveAndNavigate(user.uid, undefined, user.phoneNumber);
    }
  }, [
    redirectPath,
    user,
    authLoading,
    completeStep,
    growthEntrySurface,
    growthJourney,
    providerAttempt?.id,
    resolveAndNavigate,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await ApiService.getAppReviewModeConfig();
      if (!cancelled) setReviewModeConfig(config);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleReviewerLogin = useCallback(async () => {
    trackEvent("auth_started", {
      action: "reviewer",
    });
    try {
      const localReviewerCredentials = resolveLocalReviewerCredentials(
        typeof window !== "undefined" ? window.location.hostname : null,
      );

      if (
        !reviewModeConfig.enabled &&
        !nativeTestConfig.autoReviewerLogin &&
        !localReviewerCredentials
      ) {
        throw new Error("Reviewer mode is not enabled");
      }

      const authResult = localReviewerCredentials
        ? await AuthService.signInWithEmailAndPassword(
            localReviewerCredentials.email,
            localReviewerCredentials.password,
          )
        : await (async () => {
            const { token } = await ApiService.createAppReviewModeSession(
              "reviewer",
              {
                smokePassphrase: nativeTestConfig.autoReviewerLogin
                  ? nativeTestConfig.vaultPassphrase
                  : null,
              },
            );
            return AuthService.signInWithCustomToken(token);
          })();
      const authenticatedUser = authResult.user;

      if (authenticatedUser) {
        setNativeAuthState("authenticated");
        setNativeDataState("loaded");
        setNativeErrorCode(null);
        trackEvent("auth_succeeded", {
          action: "reviewer",
          result: "success",
        });
        if (growthJourney) {
          trackGrowthFunnelStepCompleted({
            journey: growthJourney,
            step: "auth_completed",
            entrySurface: growthEntrySurface,
            authMethod: "reviewer",
            dedupeKey: `growth:${growthJourney}:auth_completed:reviewer`,
            dedupeWindowMs: 5_000,
          });
        }
        const settlementId = beginPostAuthSettlement(authenticatedUser);
        try {
          await resolveAndNavigate(
            authenticatedUser.uid,
            await authenticatedUser.getIdToken(),
            authenticatedUser.phoneNumber,
          );
        } finally {
          completePostAuthSettlement(settlementId);
        }
      } else {
        trackEvent("auth_failed", {
          action: "reviewer",
          result: "error",
          error_class: "missing_user",
        });
        morphyToast.error("Reviewer login failed: no user session returned.");
      }
    } catch (err: unknown) {
      setNativeAuthState("anonymous");
      setNativeDataState("error");
      setNativeErrorCode("reviewer_login_failed");
      debugError("[AuthStep] Reviewer login failed", err);
      trackEvent("auth_failed", {
        action: "reviewer",
        result: "error",
        error_class: "auth_failed",
      });
      morphyToast.error(
        err instanceof Error ? err.message : "Failed to sign in as reviewer",
      );
    }
  }, [
    beginPostAuthSettlement,
    completePostAuthSettlement,
    growthEntrySurface,
    growthJourney,
    nativeTestConfig.autoReviewerLogin,
    nativeTestConfig.vaultPassphrase,
    resolveAndNavigate,
    reviewModeConfig.enabled,
  ]);

  useEffect(() => {
    if (shouldUseNativeTestBootstrap) {
      return;
    }
    if (authLoading || user || autoReviewerLoginStartedRef.current) {
      return;
    }

    let attempts = 0;
    const tryAutoReviewerLogin = () => {
      const liveConfig = getNativeTestConfig();
      const requested = liveConfig.enabled && liveConfig.autoReviewerLogin;
      setNativeReviewerVisible(requested);
      if (!requested) {
        attempts += 1;
        return attempts >= 40;
      }

      autoReviewerLoginStartedRef.current = true;
      setNativeAuthState("pending");
      setNativeDataState("loading");
      setNativeErrorCode(null);
      void handleReviewerLogin();
      return true;
    };

    if (tryAutoReviewerLogin()) {
      return;
    }

    const timer = window.setInterval(() => {
      if (tryAutoReviewerLogin()) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    authLoading,
    handleReviewerLogin,
    reviewModeConfig.enabled,
    shouldUseNativeTestBootstrap,
    user,
  ]);

  const handleProviderLogin = useCallback(
    (
      provider: AuthProviderId,
      context: {
        initiator: "tap" | "voice_confirmation";
        directiveId?: string | null;
      },
    ) => {
      const active = providerAttemptRef.current;
      if (active && active.phase !== "attention_required") {
        return Promise.resolve({
          status: "blocked" as const,
          summary: "A sign-in window is already open.",
        });
      }

      providerAttemptSequenceRef.current += 1;
      const attempt: ProviderAttempt = {
        id: `provider_${Date.now().toString(36)}_${providerAttemptSequenceRef.current}`,
        provider,
        initiator: context.initiator,
        directiveId: context.directiveId ?? null,
        resumeRoute: redirectPath,
        phase: "launching",
        startedAt: Date.now(),
      };
      publishProviderAttempt(attempt);
      trackEvent("auth_started", { action: provider });

      // This call must remain before any await/timer. The direct button and
      // provider-specific Agent Bar action both enter here with a trusted tap.
      const providerPromise =
        provider === "google"
          ? AuthService.signInWithGoogle()
          : AuthService.signInWithApple();
      updateProviderAttemptPhase(attempt.id, "provider_open");

      const attentionPromise = new Promise<{
        status: "started";
        summary: string;
      }>((resolve) => {
        attentionResolversRef.current.set(attempt.id, resolve);
      });

      const settlementPromise = providerPromise
        .then(async (authResult) => {
          if (providerAttemptRef.current?.id !== attempt.id) {
            return {
              status: "blocked" as const,
              summary: "A newer sign-in attempt replaced this one.",
            };
          }
          updateProviderAttemptPhase(attempt.id, "settling");
          const authenticatedUser = authResult.user;
          if (!authenticatedUser) {
            trackEvent("auth_failed", {
              action: provider,
              result: "error",
              error_class: "missing_user",
            });
            morphyToast.error(
              "Sign-in completed but no user session was returned.",
              { description: "Please try again." },
            );
            return {
              status: "failed" as const,
              summary: `${provider === "apple" ? "Apple" : "Google"} did not return a user session.`,
            };
          }
          const settlementId = beginPostAuthSettlement(authenticatedUser);
          try {
            const idToken =
              authResult.idToken || (await authenticatedUser.getIdToken());
            if (providerAttemptRef.current?.id !== attempt.id) {
              return {
                status: "blocked" as const,
                summary: "A newer sign-in attempt replaced this one.",
              };
            }
            trackEvent("auth_succeeded", {
              action: provider,
              result: "success",
            });
            // Welcome on the first sign-in, welcome back afterwards. The server
            // decides which; this is the one point per sign-in that asks. It is
            // never awaited — navigation must not wait on a mail.
            void ApiService.notifyAuthMail("signed_in", { idToken });
            if (growthJourney) {
              trackGrowthFunnelStepCompleted({
                journey: growthJourney,
                step: "auth_completed",
                entrySurface: growthEntrySurface,
                authMethod: provider,
                dedupeKey: `growth:${growthJourney}:auth_completed:${provider}`,
                dedupeWindowMs: 5_000,
              });
            }
            const routeAfter = await resolveAndNavigate(
              authenticatedUser.uid,
              idToken,
              authenticatedUser.phoneNumber,
              attempt.resumeRoute,
            );
            return {
              status: "succeeded" as const,
              summary: `${provider === "apple" ? "Apple" : "Google"} sign-in completed.`,
              routeAfter,
            };
          } finally {
            completePostAuthSettlement(settlementId);
          }
        })
        .catch((error: unknown) => {
          if (providerAttemptRef.current?.id !== attempt.id) {
            return {
              status: "blocked" as const,
              summary: "A newer sign-in attempt replaced this one.",
            };
          }
          const cancelled = isAuthCancel(error);
          if (!cancelled) {
            debugError(`[AuthStep] ${provider} login failed`, error);
          }
          trackEvent("auth_failed", {
            action: provider,
            result: "error",
            error_class:
              error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code || "auth_failed")
                : "auth_failed",
          });
          if (!cancelled) {
            morphyToast.error(
              `Could not sign in with ${provider === "apple" ? "Apple" : "Google"}.`,
              { description: authErrorMessage(error) },
            );
          }
          return {
            status: cancelled ? ("blocked" as const) : ("failed" as const),
            summary: cancelled
              ? `${provider === "apple" ? "Apple" : "Google"} sign-in was cancelled.`
              : authErrorMessage(error),
          };
        })
        .finally(() => {
          attentionResolversRef.current.delete(attempt.id);
          if (providerAttemptRef.current?.id === attempt.id) {
            publishProviderAttempt(null);
          }
        });

      return Promise.race([settlementPromise, attentionPromise]);
    },
    [
      beginPostAuthSettlement,
      completePostAuthSettlement,
      growthEntrySurface,
      growthJourney,
      publishProviderAttempt,
      redirectPath,
      resolveAndNavigate,
      updateProviderAttemptPhase,
    ],
  );

  useLocalOnboardingActionHandler("auth.sign_in_google", (_slots, context) =>
    handleProviderLogin("google", {
      initiator: "voice_confirmation",
      directiveId: context?.directiveId ?? null,
    }),
  );
  useLocalOnboardingActionHandler("auth.sign_in_apple", (_slots, context) =>
    handleProviderLogin("apple", {
      initiator: "voice_confirmation",
      directiveId: context?.directiveId ?? null,
    }),
  );
  useLocalOnboardingActionHandler("onboarding.back_to_intro", returnToWelcome);
  useLocalOnboardingActionHandler("auth.open_terms", async () => {
    await openLegalDoc("terms");
    return { status: "succeeded", summary: "Terms opened." };
  });
  useLocalOnboardingActionHandler("auth.open_privacy", async () => {
    await openLegalDoc("privacy");
    return { status: "succeeded", summary: "Privacy Policy opened." };
  });
  useLocalOnboardingActionHandler("auth.close_legal", async () => {
    await closeLegalDoc();
    return { status: "succeeded", summary: "Legal document closed." };
  });

  usePublishVoiceSurfaceMetadata(
    {
      screenId: "login",
      title: "Sign in to One",
      purpose:
        "This is the sign-in screen. Help the person sign in with Apple or Google so they can open their private vault. Terms and Privacy Policy open as inline documents.",
      actions: [
        ...(!providerBusy
          ? [
              {
                id: "auth.sign_in_google",
                actionId: "auth.sign_in_google",
                label: "Continue with Google",
                purpose: "Open the Google sign-in popup.",
              },
              {
                id: "auth.sign_in_apple",
                actionId: "auth.sign_in_apple",
                label: "Continue with Apple",
                purpose: "Open the Apple sign-in popup.",
              },
            ]
          : []),
        {
          id: "auth.open_terms",
          actionId: "auth.open_terms",
          label: "Terms",
          purpose: "Open the Terms document in this screen.",
        },
        {
          id: "auth.open_privacy",
          actionId: "auth.open_privacy",
          label: "Privacy Policy",
          purpose: "Open the Privacy Policy document in this screen.",
        },
        ...(!activeLegalDoc && !providerBusy
          ? [
              {
                id: "onboarding.back_to_intro",
                actionId: "onboarding.back_to_intro",
                label: "Back to welcome",
                purpose:
                  "Return to One's public welcome screen while preserving a valid pending destination.",
              },
            ]
          : []),
      ],
      controls: [
        ...(!providerBusy
          ? [
              {
                id: "auth_google",
                label: "Continue with Google",
                purpose: "Open the Google sign-in popup.",
                actionId: "auth.sign_in_google",
                role: "button",
              },
              {
                id: "auth_apple",
                label: "Continue with Apple",
                purpose: "Open the Apple sign-in popup.",
                actionId: "auth.sign_in_apple",
                role: "button",
              },
            ]
          : []),
        {
          id: "auth_terms",
          label: "Terms",
          purpose: "Open the Terms document in this screen.",
          actionId: "auth.open_terms",
          role: "button",
        },
        {
          id: "auth_privacy",
          label: "Privacy Policy",
          purpose: "Open the Privacy Policy document in this screen.",
          actionId: "auth.open_privacy",
          role: "button",
        },
        ...(!activeLegalDoc && !providerBusy
          ? [
              {
                id: "auth_back",
                label: "Back to welcome",
                purpose:
                  "Return to One's public welcome screen while preserving a valid pending destination.",
                actionId: "onboarding.back_to_intro",
                role: "button" as const,
              },
            ]
          : []),
      ],
      modalState: null,
      activeControlId: null,
    },
    { role: "route", routeKey: ROUTES.LOGIN },
  );

  usePublishVoiceSurfaceMetadata(
    activeLegalDoc
      ? {
          screenId: "login",
          title: activeLegalDoc === "terms" ? "Terms" : "Privacy Policy",
          purpose:
            "An inline legal document is open above Login. Answer questions about it or close it before using Login controls.",
          actions: [
            {
              id: "auth.close_legal",
              actionId: "auth.close_legal",
              label: "Close legal document",
              purpose: "Close this document and restore Login controls.",
            },
          ],
          controls: [
            {
              id: "auth_close_legal",
              label: "Close legal document",
              purpose: "Close this document and restore Login controls.",
              actionId: "auth.close_legal",
              role: "button",
            },
          ],
          modalState: `legal_${activeLegalDoc}`,
          activeControlId: "auth_close_legal",
          interactionLayer: {
            schemaVersion: "voice_interaction_layer.v1",
            id: `login_legal_${activeLegalDoc}`,
            kind: "legal_document",
            modality: "modal",
            lifecycle: "open",
            dismissible: true,
            dismissActionId: "auth.close_legal",
            visibleActionIds: ["auth.close_legal"],
            visibleControlIds: ["auth_close_legal"],
            options: [],
            returnFocusControlId:
              activeLegalDoc === "terms" ? "auth_terms" : "auth_privacy",
            blocksUnderlyingActions: true,
            agentContinuity: "interactive",
          },
        }
      : null,
    { role: "interaction_layer", routeKey: ROUTES.LOGIN },
  );

  if (authLoading || user) {
    return <HushhLoader label="Checking session..." variant="fullscreen" />;
  }

  const authOptions = isAndroid()
    ? [
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon />,
          onClick: () => handleProviderLogin("google", { initiator: "tap" }),
        },
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon />,
          onClick: () => handleProviderLogin("apple", { initiator: "tap" }),
        },
      ]
    : [
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon />,
          onClick: () => handleProviderLogin("apple", { initiator: "tap" }),
        },
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon />,
          onClick: () => handleProviderLogin("google", { initiator: "tap" }),
        },
      ];

  // Reviewer credentials are a governed native-test fixture, never a normal
  // sign-in choice. Keeping this control behind the explicit test bridge
  // prevents local/UAT configuration from leaking a fixture account into the
  // product UI while preserving the native runner's observable test mode.
  const showReviewer = nativeTestConfig.enabled && nativeReviewerVisible;

  return (
    <main
      // The outer app scroll root reserves --app-scroll-bottom-pad below this
      // element for the fixed onboarding Agent Bar, then re-adds it as its
      // own padding-bottom. Sizing this element to a full 100dvh on top of
      // that reservation forced scroll on every device. Inline style (not a
      // Tailwind arbitrary-value class) because Tailwind's arbitrary calc()
      // parser requires escaped whitespace around the minus sign
      // ("100dvh_-_var(...)"); without it the whole declaration is invalid
      // CSS and silently dropped, which is what happened here before.
      //
      // min-height, NOT height. A fixed height plus overflow-hidden does not
      // scroll when the content outgrows it — it silently CUTS the content,
      // with no scrollbar and no error. At 200% text the bottom reservation
      // doubles too (it is measured in rem), and the mark and title were being
      // clipped off the top edge. With a minimum, the block still fills exactly
      // one viewport at normal size (measured: 0px of scroll at 320-430 wide)
      // and grows into the scroll root only when the text genuinely needs it.
      className="relative w-full overflow-hidden"
      style={{
        minHeight: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
      }}
      data-testid="auth-step-primary"
    >
      {/* Shared immersive gradient backdrop (welcome / login / carousel). */}
      <OnboardingHeroBackground motes={false} />
      <NativeTestBeacon
        routeId="/login"
        marker="native-route-login"
        authState={nativeAuthState}
        dataState={nativeDataState}
        attachToBridge={(bridge) => {
          bridge.triggerReviewerLogin = () => {
            if (autoReviewerLoginStartedRef.current) {
              return;
            }
            autoReviewerLoginStartedRef.current = true;
            setNativeReviewerVisible(true);
            setNativeAuthState("pending");
            setNativeDataState("loading");
            setNativeErrorCode(null);
            void handleReviewerLogin();
          };
        }}
        errorCode={
          nativeErrorCode ??
          `cfg_${nativeTestConfig.enabled ? "1" : "0"}_${nativeTestConfig.autoReviewerLogin ? "1" : "0"}`
        }
      />

      <button
        type="button"
        onClick={handleBack}
        disabled={providerBusy}
        aria-label={providerBusy ? "Sign-in in progress" : "Go back"}
        data-voice-control-id={
          activeLegalDoc || providerBusy ? undefined : "auth_back"
        }
        className="fixed left-4 top-[calc(max(var(--app-safe-area-top-effective),0.5rem))] z-50 grid h-9 w-9 place-items-center rounded-full bg-black/[0.05] text-[#1d1d1f]/70 transition-colors hover:bg-black/[0.08] disabled:pointer-events-none disabled:opacity-40 dark:bg-white/10 dark:text-white/80 dark:hover:bg-white/15"
      >
        <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>

      <div
        className="relative mx-auto flex w-full max-w-[440px] flex-col justify-center"
        style={{
          minHeight: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
        }}
        data-auth-content-block
      >
        {/* Center the complete sign-in group as one visual block while the
            fixed Back control remains independently anchored above it. The
            clusters use one deliberate rhythm: identity, provider actions,
            then the consent and legal context. */}
        <div
          className="flex w-full flex-none flex-col items-center gap-6 px-6 pb-6 text-center"
          data-auth-signin-clusters
        >
          <div className="flex flex-col items-center gap-4">
            {/* The One mark. The glyph is the logo, so it is never restyled;
                only the geometry around it shrank — a 64px box and a 72px halo
                instead of a 92px box under a 112px blur that washed the whole
                top of the screen blue. The drop-shadow went with it: at 25%
                black it read as a smudge on the #f2f2f7 canvas. */}
            <div
              className="relative flex h-[64px] w-[64px] items-center justify-center"
              aria-hidden="true"
            >
              <span className="pointer-events-none absolute h-[80px] w-[80px] rounded-full bg-accent/[0.18] blur-[24px]" />
              <span className="relative select-none text-[52px] leading-none">
                🤫
              </span>
            </div>
            {/* Title and its one supporting line are a tight pair (gap-1.5);
                the 16px rhythm belongs between the mark and this pair. The
                line is a SIBLING of the h1, never a child, because the smoke
                test matches the heading by accessible name.

                The h1 sets no size, line-height or weight on purpose: the base
                `h1` rule in globals.css locks all three with !important
                (28px / 700 at 390px wide), so a Tailwind size class here
                paints nothing and only misleads the next reader. Tracking is
                the one property that rule leaves overridable. */}
            <div className="flex flex-col items-center gap-1.5">
              <h1
                role="heading"
                aria-level={1}
                aria-label="Welcome to One"
                className="font-[family-name:var(--font-app-display)] tracking-[-1.1px] text-[#17130C] dark:text-[#FAF6EE]"
              >
                Welcome to One
              </h1>
              <p className="type-callout text-[color:var(--app-secondary-label)]">
                Sign in to continue.
              </p>
            </div>
          </div>

          {/* Buttons sit directly on the shared hero background (no card/sheet
              behind them), matching the welcome ("/") page's direct-on-canvas
              CTA. The outer app scroll root already reserves clearance for the
              fixed onboarding Agent Bar (--onboarding-agent-bar-clearance in
              app/providers.tsx), so this is a plain content gap rather than a
              second bar-height reservation. */}
          <div className="relative mx-auto w-full max-w-[21.5rem] space-y-4">
            <div className="space-y-3" data-auth-provider-actions>
              {providerAttempt?.phase === "attention_required" ? (
                <p
                  role="status"
                  className="rounded-2xl bg-[color:var(--app-accent-tint)] px-4 py-3 text-center text-sm leading-relaxed text-[color:var(--app-accent-deep)] dark:bg-white/[0.08]"
                >
                  The provider window needs attention. You can retry the same
                  sign-in option securely.
                </p>
              ) : null}
              {authOptions.map((option) => (
                <AuthProviderButton
                  key={option.id}
                  label={option.label}
                  icon={option.icon}
                  onClick={() => {
                    void option.onClick();
                  }}
                  disabled={providerBusy}
                  voiceControlId={`auth_${option.id}`}
                  className={cn(
                    option.id === "apple"
                      ? providerBusy
                        ? APPLE_BTN_BUSY_CLASS
                        : APPLE_BTN_CLASS
                      : providerBusy
                        ? GOOGLE_BTN_BUSY_CLASS
                        : GOOGLE_BTN_CLASS,
                  )}
                />
              ))}

              {showReviewer ? (
                <AuthProviderButton
                  label="Continue as Reviewer"
                  icon={<Icon icon={Shield} size="md" />}
                  onClick={handleReviewerLogin}
                  disabled={providerBusy}
                  className={REVIEWER_BTN_CLASS}
                />
              ) : null}
            </div>

            <div className="flex flex-col items-center gap-3" data-auth-supporting-content>
              {/* Reassurance, not a control. The blue pill read as a tappable
                  filter, and accent-blue body text on the #f2f2f7 canvas sits
                  under the 4.5:1 contrast floor — so the words moved to the
                  secondary label colour and only the lock stays accent.
                  Both this line and the legal line below use
                  --app-secondary-label: the tertiary grey measures 2.9:1 on
                  this canvas, which fails AA. Hierarchy is carried by size
                  (15px here, 13px below), not by an unreadable grey. */}
              <div className="flex items-center gap-1.5">
                <Icon
                  icon={Lock}
                  size="sm"
                  className="text-[color:var(--app-accent-deep)]"
                />
                <span className="text-[15px] leading-5 text-[color:var(--app-secondary-label)]">
                  You choose what One can see.
                </span>
              </div>

              <p className="type-footnote mx-auto max-w-[22rem] text-center leading-5 text-[color:var(--app-secondary-label)]">
                By continuing you agree to our{" "}
                <button
                  type="button"
                  onClick={() => void openLegalDoc("terms")}
                  data-voice-control-id="auth_terms"
                  className="font-semibold text-[color:var(--app-accent-deep)] transition-opacity hover:opacity-70 dark:text-[color:var(--app-accent-deep)]"
                >
                  Terms
                </button>
                <span aria-hidden="true"> and </span>
                <button
                  type="button"
                  onClick={() => void openLegalDoc("privacy")}
                  data-voice-control-id="auth_privacy"
                  className="font-semibold text-[color:var(--app-accent-deep)] transition-opacity hover:opacity-70 dark:text-[color:var(--app-accent-deep)]"
                >
                  Privacy Policy
                </button>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
      <AuthLegalDialog
        docType={activeLegalDoc}
        closeControlId="auth_close_legal"
        onOpenChange={(open) => {
          if (!open) void closeLegalDoc();
        }}
      />
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" aria-hidden>
      <title>Google</title>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <title>Apple</title>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
    </svg>
  );
}

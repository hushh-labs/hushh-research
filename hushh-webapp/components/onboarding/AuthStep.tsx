"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Shield } from "lucide-react";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { useAuth } from "@/lib/firebase/auth-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OnboardingHeroBackground } from "@/components/onboarding/OnboardingHeroBackground";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isAndroid } from "@/lib/capacitor/platform";
import { Icon } from "@/lib/morphy-ux/ui";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import {
  FigmaBackButton,
  FigmaIllustration,
  FigmaPrivacyNote,
  FigmaProviderIcon,
} from "@/components/onboarding/FigmaOnboardingPrimitives";
import styles from "./AuthStep.module.css";
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
import {
  buildWelcomeRoute,
  isFirebaseSessionOnlyRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
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

// Provider-button treatments MATCH the theme (light surfaces in light mode,
// dark surfaces in dark mode) so the sheet reads as one coherent material:
// Apple/Google are white cards with ink text on the light sheet, and deep
// charcoal cards with light text on the dark sheet. Reviewer stays a quiet
// outlined tertiary in both themes.
const APPLE_BTN_CLASS =
  "!bg-white !text-[#17130C] border border-black/10 shadow-sm hover:!bg-black/[0.02] dark:!bg-[#1c1c1e] dark:!text-[#F7F3EA] dark:border-white/12 dark:hover:!bg-[#26262a]";
const GOOGLE_BTN_CLASS =
  "!bg-white !text-[#17130C] border border-black/10 shadow-sm hover:!bg-black/[0.02] dark:!bg-[#1c1c1e] dark:!text-[#F7F3EA] dark:border-white/12 dark:hover:!bg-[#26262a]";
const REVIEWER_BTN_CLASS =
  "!bg-transparent !text-[#6b6b70] border border-black/10 shadow-none hover:!bg-black/[0.03] dark:!text-white/60 dark:border-white/15 dark:hover:!bg-white/[0.05]";

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
  // Firebase/native persistence may settle before this Suspense subtree is
  // hydrated. Keep the server and first client paint identical so Login never
  // throws away its tree (and a one-shot account-recovery toast) during a
  // hydration mismatch.
  const [hydrated, setHydrated] = useState(false);
  const nativeTestConfig = useNativeTestConfig();
  const router = useRouter();
  const {
    user,
    loading: authLoading,
    sessionVerificationRequired,
    retrySessionVerification,
    signOut,
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

  useEffect(() => {
    setHydrated(true);
  }, []);

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
      const explicitTargetPath = normalizeInternalRouteHref(
        resumeTarget || redirectPath,
      );
      const targetPath = explicitTargetPath ?? ROUTES.ONE_HOME;
      const navigationKey = `${userId}:${targetPath}`;
      if (lastNavigationKeyRef.current === navigationKey) {
        return lastResolvedNavigationPathRef.current || targetPath;
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
          redirectPath: explicitTargetPath ?? undefined,
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
        const firebaseSessionOnly = isFirebaseSessionOnlyRoute(nextPath);
        if (!firebaseSessionOnly) {
          await PreVaultUserStateService.syncOnboardingJourney({
            userId,
            phase:
              nextPath === ROUTES.PHONE_MANDATE
                ? "phone_required"
                : "setup_hub",
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
        }
        // Product handoffs require only the settled Firebase session. They do
        // not start or resume One setup and never create a private-place gate.
        setOnboardingRequiredCookie(
          !firebaseSessionOnly && nextPath === ROUTES.ONE_SETUP,
        );
        setOnboardingFlowActiveCookie(
          !firebaseSessionOnly && nextPath === ROUTES.KAI_IMPORT,
        );
        // Replace, not push: the login screen must not stay on the back stack,
        // so an onboarded user pressing Back never lands back on /login or the
        // setup hub it forwards to.
        router.replace(nextPath);
        lastResolvedNavigationPathRef.current = nextPath;
        return nextPath;
      } catch (error) {
        console.warn("[AuthStep] Failed to resolve post-auth route:", error);
        const safeFallbackPath =
          targetPath === ROUTES.ONE_SETUP ||
          targetPath === ROUTES.ONE_SETUP_FINANCE ||
          targetPath === ROUTES.KAI_IMPORT
            ? ROUTES.KAI_HOME
            : targetPath;
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
    if (authLoading || sessionVerificationRequired) return;
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
    sessionVerificationRequired,
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

  if (hydrated && !authLoading && sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  if (!hydrated || authLoading || user) {
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
      className={cn("relative w-full overflow-hidden", styles.shell)}
      style={{
        height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
        minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
      }}
      data-testid="auth-step-primary"
    >
      {/* Shared immersive gradient backdrop (welcome / login / carousel). */}
      <OnboardingHeroBackground variant="solid" />
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

      <div className={styles.stage}>
        <div className={styles.composition}>
          <FigmaBackButton
            onClick={handleBack}
            disabled={providerBusy}
            aria-label={providerBusy ? "Sign-in in progress" : "Go back"}
            data-voice-control-id={
              activeLegalDoc || providerBusy ? undefined : "auth_back"
            }
            className={styles.authBackButton}
          />

          <div
            className={cn(
              "relative mx-auto flex w-full max-w-[440px] flex-col justify-center",
              styles.authContentBlock,
            )}
            style={{
              height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
              minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
              paddingTop: "78px",
              justifyContent: "flex-start",
            }}
            data-auth-content-block
          >
        {/* Center the complete sign-in group as one visual block while the
            fixed Back control remains independently anchored above it. Legal
            copy is anchored separately at the bottom like a standard auth
            footer, so it does not read as primary sign-in content. */}
            <div
              className={cn(
                "flex w-full flex-none flex-col items-center gap-6 px-6 pb-6 text-center",
                styles.authSignInClusters,
              )}
              data-auth-signin-clusters
            >
              <div className={cn("flex flex-col items-center gap-4", styles.authHero)}>
            <FigmaIllustration variant="auth" className={styles.authIllustration} />
            <h1
              role="heading"
              aria-level={1}
              aria-label="Welcome to One"
              className={cn(
                "font-[family-name:var(--font-app-display)] text-[27px] font-bold leading-[1.1] tracking-[-0.7px] text-[#0a0a0a] dark:text-[#fafafa]",
                styles.authTitle,
              )}
            >
              Welcome to One
              <span style={{ color: "var(--app-accent)" }}>.</span>
            </h1>
              </div>

          {/* Buttons sit directly on the shared hero background (no card/sheet
              behind them), matching the welcome ("/") page's direct-on-canvas
              CTA. The outer app scroll root already reserves clearance for the
              fixed onboarding Agent Bar (--onboarding-agent-bar-clearance in
              app/providers.tsx), so this is a plain content gap rather than a
              second bar-height reservation. */}
              <div
                className={cn(
                  "relative mx-auto w-full max-w-[21.5rem] space-y-4",
                  styles.providerActionsShell,
                )}
              >
                <div
                  className={cn("space-y-3", styles.providerActions)}
                  data-auth-provider-actions
                >
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
                    option.id === "apple" ? APPLE_BTN_CLASS : GOOGLE_BTN_CLASS,
                    styles.authProviderButton,
                  )}
                />
              ))}

              {showReviewer ? (
                <AuthProviderButton
                  label="Continue as Reviewer"
                  icon={<Icon icon={Shield} size="md" />}
                  onClick={handleReviewerLogin}
                  disabled={providerBusy}
                  className={cn(REVIEWER_BTN_CLASS, styles.reviewerButton)}
                />
              ) : null}
                </div>
              </div>
            </div>
          </div>
          <div
            className={cn(
              "absolute inset-x-6 bottom-5 z-10 flex justify-center",
              styles.supportingShell,
            )}
          >
            <div
              className={cn("flex flex-col items-center gap-3", styles.supportingContent)}
              data-auth-supporting-content
            >
              <FigmaPrivacyNote>
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
              </FigmaPrivacyNote>
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
  return <FigmaProviderIcon provider="google" />;
}

function AppleIcon() {
  return <FigmaProviderIcon provider="apple" />;
}

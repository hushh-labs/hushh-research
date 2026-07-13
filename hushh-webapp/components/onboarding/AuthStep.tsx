"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Shield } from "lucide-react";
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
  const nativeTestConfig = useNativeTestConfig();
  const router = useRouter();
  const { user, loading: authLoading, setNativeUser } = useAuth();
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
    nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_KAI &&
    redirectPath === ROUTES.ONE_SETUP_KAI;
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

  const localReviewerCredentialsAvailable = useMemo(() => {
    return Boolean(
      resolveLocalReviewerCredentials(
        typeof window !== "undefined" ? window.location.hostname : null,
      ),
    );
  }, []);
  const isLocalReviewerSurface = useMemo(() => {
    if (typeof window === "undefined") {
      return process.env.NODE_ENV !== "production";
    }
    const hostname = window.location.hostname.toLowerCase();
    return (
      process.env.NODE_ENV !== "production" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1"
    );
  }, []);
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
        return lastResolvedNavigationPathRef.current;
      }
      lastNavigationKeyRef.current = navigationKey;

      try {
        if (preserveOnboardingAuditRoute) {
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          router.push(ROUTES.ONE_SETUP_KAI);
          lastResolvedNavigationPathRef.current = ROUTES.ONE_SETUP_KAI;
          return ROUTES.ONE_SETUP_KAI;
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
        router.push(nextPath);
        lastResolvedNavigationPathRef.current = nextPath;
        return nextPath;
      } catch (error) {
        console.warn("[AuthStep] Failed to resolve post-auth route:", error);
        const fallbackPath = targetPath || ROUTES.KAI_HOME;
        const safeFallbackPath =
          fallbackPath === ROUTES.ONE_SETUP ||
          fallbackPath === ROUTES.ONE_SETUP_KAI ||
          fallbackPath === ROUTES.KAI_IMPORT
            ? ROUTES.KAI_HOME
            : fallbackPath;
        setOnboardingRequiredCookie(safeFallbackPath === ROUTES.ONE_SETUP);
        setOnboardingFlowActiveCookie(safeFallbackPath === ROUTES.KAI_IMPORT);
        router.push(safeFallbackPath);
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
    setNativeUser,
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
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(
          authenticatedUser.uid,
          await authenticatedUser.getIdToken(),
          authenticatedUser.phoneNumber,
        );
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
    growthEntrySurface,
    growthJourney,
    nativeTestConfig.autoReviewerLogin,
    nativeTestConfig.vaultPassphrase,
    resolveAndNavigate,
    reviewModeConfig.enabled,
    setNativeUser,
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
          const idToken = await authenticatedUser.getIdToken();
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
          setNativeUser(authenticatedUser);
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
      growthEntrySurface,
      growthJourney,
      publishProviderAttempt,
      redirectPath,
      resolveAndNavigate,
      setNativeUser,
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

  const showReviewer =
    reviewModeConfig.enabled ||
    nativeReviewerVisible ||
    localReviewerCredentialsAvailable ||
    isLocalReviewerSurface;

  return (
    <main
      className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden"
      data-testid="auth-step-primary"
    >
      {/* Shared immersive gradient backdrop (welcome / login / carousel). */}
      <OnboardingHeroBackground />
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

      <div className="relative mx-auto flex h-[100dvh] min-h-[100svh] w-full max-w-[440px] flex-col">
        {/* Hero */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-6 text-center">
          {/* Quiet mark: the bare 🤫 over a soft accent glow, no medallion
              chrome (badge circle removed by design). */}
          <div
            className="relative flex h-[92px] w-[92px] items-center justify-center"
            aria-hidden="true"
          >
            <span className="pointer-events-none absolute h-28 w-28 rounded-full bg-accent/20 blur-2xl" />
            <span className="relative select-none text-[56px] leading-none drop-shadow-[0_6px_14px_rgba(0,0,0,0.25)]">
              🤫
            </span>
          </div>
          <h1
            role="heading"
            aria-level={1}
            aria-label="Welcome to One"
            className="mt-6 font-[family-name:var(--font-app-display)] text-[34px] font-extrabold leading-[1.05] tracking-[-1.1px] text-[#17130C] dark:text-[#FAF6EE]"
          >
            Welcome to One<span style={{ color: "#D4AF6A" }}>.</span>
          </h1>
          <p className="mt-3 max-w-[19rem] text-[16px] leading-[1.45] text-[rgba(23,19,12,0.6)] dark:text-[rgba(250,246,238,0.62)]">
            Sign in to open your private vault. It unlocks with you, and only
            you.
          </p>
        </div>

        {/* Frosted glass action sheet: translucent + backdrop-blurred so the
            dark ambient hero shows through behind it, while dark-on-light
            controls stay legible. Matches the welcome ("/") glass sheet. */}
        <div className="relative overflow-hidden rounded-t-[36px] border-t border-white/70 bg-white/55 px-6 pt-7 pb-[calc(132px+env(safe-area-inset-bottom,0px)+var(--app-screen-footer-pad))] shadow-[0_-1px_0_rgba(255,255,255,0.6)_inset,0_-24px_60px_-24px_rgba(23,19,12,0.22)] backdrop-blur-md backdrop-saturate-150 supports-[backdrop-filter]:bg-white/40 dark:border-white/10 dark:bg-[#141018]/60 dark:shadow-[0_-1px_0_rgba(255,255,255,0.06)_inset,0_-24px_60px_-24px_rgba(0,0,0,0.6)] dark:supports-[backdrop-filter]:bg-[#141018]/45">
          {/* Glass highlight sheen along the top edge. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.55)_0%,transparent_100%)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.06)_0%,transparent_100%)]"
          />
          <div className="relative z-[1] mx-auto w-full max-w-[21.5rem] space-y-3">
            {providerAttempt?.phase === "attention_required" ? (
              <p
                role="status"
                className="rounded-2xl bg-[rgba(156,116,52,0.10)] px-4 py-3 text-center text-sm leading-relaxed text-[#6e5121] dark:bg-white/[0.08] dark:text-[#E7C47C]"
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

            {/* Consent-first reassurance chip. */}
            <div className="mx-auto mt-1 flex w-fit items-center gap-1.5 rounded-full bg-[rgba(156,116,52,0.10)] px-3 py-1.5 dark:bg-white/[0.06]">
              <Icon
                icon={Shield}
                size="sm"
                className="text-[#9C7434] dark:text-[#D4AF6A]"
              />
              <span className="type-footnote text-[#8a6a2f] dark:text-[#D4AF6A]">
                Consent-first. Nothing moves without your yes.
              </span>
            </div>

            <p className="type-footnote mx-auto max-w-[18.75rem] text-center text-[#86868b] dark:text-white/45">
              A verified phone number is required before you continue.
            </p>
          </div>
        </div>
        {/* Lifted to clear the persistent agent bar (pinned above the safe
            area, ~44px tall + gap) so the legal footnote never tucks under it. */}
        <footer className="absolute inset-x-6 bottom-[calc(20px+56px+env(safe-area-inset-bottom,0px)+var(--app-screen-footer-pad))] flex-none">
          <p className="type-footnote mx-auto max-w-[19.5rem] text-center text-[#86868b] dark:text-white/45">
            By continuing, you agree to One&apos;s{" "}
            <button
              type="button"
              onClick={() => void openLegalDoc("terms")}
              data-voice-control-id="auth_terms"
              className="font-semibold text-[#9C7434] transition-opacity hover:opacity-70 dark:text-[#D4AF6A]"
            >
              Terms
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => void openLegalDoc("privacy")}
              data-voice-control-id="auth_privacy"
              className="font-semibold text-[#9C7434] transition-opacity hover:opacity-70 dark:text-[#D4AF6A]"
            >
              Privacy Policy
            </button>
            .
          </p>
        </footer>
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
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden>
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
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <title>Apple</title>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
    </svg>
  );
}

"use client";

import { canStartReviewerLogin, shouldAutoAuthenticateReviewer } from "@/lib/testing/reviewer-authentication-policy.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Shield } from "@/components/icons";
import lightStyles from "./AuthStepLight.module.css";
import { AuthService, type AuthResult } from "@/lib/services/auth-service";
import { EmailSignInSection } from "@/components/onboarding/EmailSignInSection";
import { InitialContactsOnboardingService } from "@/lib/services/initial-contacts-onboarding-service";
import { preloadGoogleSignupAuth } from "@/lib/auth/google-signup-token";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiService } from "@/lib/services/api-service";
import { LegalAcceptanceService } from "@/lib/services/legal-acceptance-service";
import { useAuth } from "@/lib/firebase/auth-context";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OneWelcomeArtwork } from "@/components/onboarding/OneWelcomeStory";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isAndroid, isWeb } from "@/lib/capacitor/platform";
import { Icon } from "@/lib/morphy-ux/ui";
import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { EnterpriseSsoSection } from "@/components/onboarding/EnterpriseSsoSection";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
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

const AUTH_CANCEL_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
]);

const APPLE_BTN_CLASS =
  "!bg-white !text-zinc-900 border border-slate-200/90 shadow-sm hover:!bg-slate-50 h-[56px] sm:h-[60px] rounded-[20px] text-[17px] font-[650] whitespace-nowrap flex items-center justify-center dark:!bg-[#1C1C1E] dark:!text-white dark:border-white/10 dark:hover:!bg-[#26262a]";
const GOOGLE_BTN_CLASS =
  "!bg-white !text-zinc-900 border border-slate-200/90 shadow-sm hover:!bg-slate-50 h-[56px] sm:h-[60px] rounded-[20px] text-[17px] font-[650] whitespace-nowrap flex items-center justify-center dark:!bg-[#1C1C1E] dark:!text-white dark:border-white/10 dark:hover:!bg-[#26262a]";
const REVIEWER_BTN_CLASS =
  "!bg-transparent !text-[#6b6b70] border border-black/10 shadow-none hover:!bg-black/[0.03] dark:!text-white/60 dark:border-white/15 dark:hover:!bg-white/[0.05]";

type AuthProviderId = "google" | "apple" | "microsoft";
const PROVIDER_NAMES = { google: "Google", apple: "Apple", microsoft: "Microsoft", email: "Email" };
type ProviderAttemptPhase =
  | "launching"
  | "provider_open"
  | "attention_required"
  | "settling";
type ProviderAttempt = {
  id: string;
  provider: AuthProviderId | "email";
  initiator: "tap" | "voice_confirmation";
  directiveId: string | null;
  resumeRoute: string;
  phase: ProviderAttemptPhase;
  startedAt: number;
};

function isAuthCancel(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
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
      return "An account already exists with this mail using a different sign-in method.";
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
  const [hydrated, setHydrated] = useState(false);
  const [findInitialContacts, setFindInitialContacts] = useState(true);
  const initialContactsEnabled = AuthService.canRequestInitialGoogleContacts();
  const nativeTestConfig = useNativeTestConfig();
  const router = useRouter();
  const {
    user,
    userId,
    loading: authLoading,
    sessionVerificationRequired,
    retrySessionVerification,
    signOut,
    beginPostAuthSettlement,
    admitPostAuthSettlement,
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
  const emailBusyRef = useRef(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const setEmailOperationBusy = useCallback((busy: boolean) => {
    emailBusyRef.current = busy;
    setEmailBusy(busy);
  }, []);
  const providerAttemptSequenceRef = useRef(0);
  const providerAbortRef = useRef<AbortController | null>(null);
  const attentionResolversRef = useRef(
    new Map<string, (result: { status: "started"; summary: string }) => void>(),
  );
  const [providerAttempt, setProviderAttempt] =
    useState<ProviderAttempt | null>(null);
  const [providerRecovery, setProviderRecovery] = useState<string | null>(null);
  const providerBusy = Boolean(
    emailBusy || (providerAttempt && providerAttempt.phase !== "attention_required"),
  );

  const [reviewModeConfig, setReviewModeConfig] = useState<{
    enabled: boolean;
  }>({ enabled: false });
  const shouldUseNativeTestBootstrap = nativeTestConfig.enabled && nativeTestConfig.autoReviewerLogin;
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

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (isWeb()) {
      void preloadGoogleSignupAuth().catch(() => undefined);
    }
  }, []);

  useEffect(() => () => providerAbortRef.current?.abort(), []);

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
        !current || current.provider === "email" ||
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
          summary: `${PROVIDER_NAMES[active.provider]} sign-in still needs attention. You can retry securely.`,
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

  const returnToWelcome = useCallback(async () => {
    if (providerBusy) {
      return {
        status: "blocked" as const,
        summary: "Sign-in is still in progress.",
      };
    }
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
  }, [providerBusy, redirectPath, router]);

  const handleBack = useCallback(() => {
    void returnToWelcome();
  }, [returnToWelcome]);

  const resolveAndNavigate = useCallback(
    async (
      userId: string,
      idToken?: string,
      phoneNumber?: string | null,
      resumeTarget?: string,
      canContinue: () => boolean = () => true,
    ) => {
      if (!canContinue()) return undefined;
      const explicitTargetPath = normalizeInternalRouteHref(
        resumeTarget || redirectPath,
      );
      const targetPath = explicitTargetPath ?? ROUTES.HOME;
      const navigationKey = `${userId}:${targetPath}`;
      if (lastNavigationKeyRef.current === navigationKey) {
        return lastResolvedNavigationPathRef.current || targetPath;
      }
      lastNavigationKeyRef.current = navigationKey;
      const stillCurrent = () => {
        if (canContinue()) return true;
        if (lastNavigationKeyRef.current === navigationKey) lastNavigationKeyRef.current = null;
        return false;
      };

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
        if (!stillCurrent()) return undefined;
        const resolvedPath = await PostAuthRouteService.resolveAfterLogin({
          userId,
          redirectPath: explicitTargetPath ?? undefined,
          idToken: resolvedIdToken,
          phoneNumber,
          enableFirstRunSetupGate: true,
        });
        if (!stillCurrent()) return undefined;

        const resumeImportFlow =
          resolvedPath === ROUTES.KAI_HOME &&
          isOnboardingFlowActiveCookieEnabled();
        const nextPath = resumeImportFlow ? ROUTES.KAI_IMPORT : resolvedPath;

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
            console.warn(
              "[AuthStep] Failed to persist onboarding journey:",
              journeyError,
            );
          });
        }
        if (!stillCurrent()) return undefined;
        setOnboardingRequiredCookie(
          !firebaseSessionOnly && nextPath === ROUTES.ONE_SETUP,
        );
        setOnboardingFlowActiveCookie(
          !firebaseSessionOnly && nextPath === ROUTES.KAI_IMPORT,
        );
        router.replace(nextPath);
        lastResolvedNavigationPathRef.current = nextPath;
        return nextPath;
      } catch (error) {
        if (!stillCurrent()) return undefined;
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
    if (user && userId && !providerAttemptRef.current) {
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
      const owner = snapshotValidatedAuthSessionOwner();
      if (!owner || owner.userId !== userId) return;
      void resolveAndNavigate(userId, undefined, user.phoneNumber, undefined,
        () => isValidatedAuthSessionOwnerCurrent(owner));
    }
  }, [
    redirectPath,
    user,
    userId,
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

  const handleReviewerLogin = useCallback(async (interactive: boolean) => {
    const liveConfig = getNativeTestConfig();
    if (shouldUseNativeTestBootstrap || (liveConfig.enabled && liveConfig.autoReviewerLogin)) return;
    trackEvent("auth_started", {
      action: "reviewer",
    });
    try {
      const localReviewerCredentials = resolveLocalReviewerCredentials(
        typeof window !== "undefined" ? window.location.hostname : null,
      );

      if (!canStartReviewerLogin(getNativeTestConfig(), reviewModeConfig.enabled, Boolean(localReviewerCredentials))) {
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
                reviewerUid: nativeTestConfig.autoReviewerLogin
                  ? nativeTestConfig.expectedUserId
                  : null,
                // The backend mint requires the reviewer passphrase; only
                // native test mode holds it. See app-review-mode-config.md.
                smokePassphrase: nativeTestConfig.autoReviewerLogin
                  ? nativeTestConfig.reviewerSessionPassphrase ||
                    nativeTestConfig.vaultPassphrase
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
        void LegalAcceptanceService.recordSignInAcceptance(
          authenticatedUser,
          interactive,
        );
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
          const ownerId = await admitPostAuthSettlement(settlementId);
          if (!ownerId) return;
          const owner = snapshotValidatedAuthSessionOwner();
          if (!owner || owner.userId !== ownerId) return;
          await resolveAndNavigate(
            ownerId,
            await authenticatedUser.getIdToken(),
            authenticatedUser.phoneNumber,
            undefined,
            () => isValidatedAuthSessionOwnerCurrent(owner),
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
    admitPostAuthSettlement,
    completePostAuthSettlement,
    growthEntrySurface,
    growthJourney,
    nativeTestConfig.autoReviewerLogin,
    nativeTestConfig.expectedUserId,
    nativeTestConfig.reviewerSessionPassphrase,
    nativeTestConfig.vaultPassphrase,
    resolveAndNavigate,
    reviewModeConfig.enabled,
    shouldUseNativeTestBootstrap,
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
      const requested = shouldAutoAuthenticateReviewer(liveConfig);
      setNativeReviewerVisible(requested);
      if (!requested) {
        attempts += 1;
        return attempts >= 40;
      }

      autoReviewerLoginStartedRef.current = true;
      setNativeAuthState("pending");
      setNativeDataState("loading");
      setNativeErrorCode(null);
      void handleReviewerLogin(false);
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

  const finishAuthentication = useCallback(async (
    result: AuthResult, method: AuthProviderId | "email", resumeRoute: string, attemptId: string, signal?: AbortSignal,
  ) => {
    const ownsAttempt = () => providerAttemptRef.current?.id === attemptId
      && (!isWeb() || AuthService.getCurrentUser()?.uid === result.user.uid);
    if (!ownsAttempt()) throw new Error("The active sign-in session changed.");
    const settlementId = beginPostAuthSettlement(result.user);
    try {
      const ownerId = await admitPostAuthSettlement(settlementId);
      if (!ownerId || !ownsAttempt()) return undefined;
      const owner = snapshotValidatedAuthSessionOwner();
      if (!owner || owner.userId !== ownerId) return undefined;
      const canContinue = () => ownsAttempt() && isValidatedAuthSessionOwnerCurrent(owner);
      const idToken = result.idToken || await result.user.getIdToken();
      if (!canContinue()) throw new Error("The active sign-in session changed.");
      trackEvent("auth_succeeded", { action: method, result: "success" });
      void ApiService.notifyFirstWelcome({ idToken });
      void LegalAcceptanceService.recordSignInAcceptance(result.user, true);
      if (method === "google" || method === "apple") {
        void InitialContactsOnboardingService.begin(result, method, attemptId,
          initialContactsEnabled && findInitialContacts).catch(() => undefined);
      }
      if (growthJourney) {
        trackGrowthFunnelStepCompleted({ journey: growthJourney, step: "auth_completed",
          entrySurface: growthEntrySurface, authMethod: method,
          dedupeKey: `growth:${growthJourney}:auth_completed:${method}`, dedupeWindowMs: 5_000 });
      }
      if (signal?.aborted) return undefined;
      return await resolveAndNavigate(ownerId, idToken, result.user.phoneNumber, resumeRoute,
        () => !signal?.aborted && canContinue());
    } finally { completePostAuthSettlement(settlementId); }
  }, [beginPostAuthSettlement, admitPostAuthSettlement, completePostAuthSettlement, initialContactsEnabled, findInitialContacts, growthEntrySurface, growthJourney, resolveAndNavigate]);

  const handleEmailAuthenticated = useCallback(async (customToken: string) => {
    if (providerAttemptRef.current) throw new Error("Another sign-in is in progress.");
    const attempt: ProviderAttempt = {
      id: `email_${Date.now()}_${++providerAttemptSequenceRef.current}`, provider: "email",
      initiator: "tap", directiveId: null, resumeRoute: redirectPath, phase: "settling", startedAt: Date.now(),
    };
    const controller = new AbortController();
    providerAbortRef.current?.abort();
    providerAbortRef.current = controller;
    publishProviderAttempt(attempt);
    try {
      const result = await AuthService.signInWithCustomToken(customToken);
      if ((providerAttemptRef.current as ProviderAttempt | null)?.id !== attempt.id) throw new Error("Restart sign-in.");
      await finishAuthentication(result, "email", attempt.resumeRoute, attempt.id, controller.signal);
    } finally {
      if (providerAbortRef.current === controller) providerAbortRef.current = null;
      if ((providerAttemptRef.current as ProviderAttempt | null)?.id === attempt.id) publishProviderAttempt(null);
    }
  }, [finishAuthentication, publishProviderAttempt, redirectPath]);

  const handleProviderLogin = useCallback(
    (
      provider: AuthProviderId,
      context: {
        initiator: "tap" | "voice_confirmation";
        directiveId?: string | null;
      },
    ) => {
      const active = providerAttemptRef.current;
      if (emailExpanded || emailBusyRef.current || (active && active.phase !== "attention_required")) {
        return Promise.resolve({
          status: "blocked" as const,
          summary: "A sign-in window is already open.",
        });
      }

      providerAttemptSequenceRef.current += 1;
      providerAbortRef.current?.abort();
      const controller = new AbortController();
      providerAbortRef.current = controller;
      setProviderRecovery(null);
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

      const providerPromise =
        provider === "google"
          ? AuthService.signInWithGoogle({
              purpose: initialContactsEnabled && findInitialContacts ? "initial_contacts" : "authentication",
              includeContacts: initialContactsEnabled && findInitialContacts,
              signal: controller.signal,
              onCredentialExchange: () => updateProviderAttemptPhase(attempt.id, "settling"),
            })
          : provider === "apple" ? AuthService.signInWithApple() : AuthService.signInWithMicrosoft();
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
          if (!controller.signal.aborted) updateProviderAttemptPhase(attempt.id, "settling");
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
              summary: `${PROVIDER_NAMES[provider]} did not return a user session.`,
            };
          }
            const routeAfter = await finishAuthentication(authResult, provider, attempt.resumeRoute, attempt.id, controller.signal);
            return {
              status: "succeeded" as const,
              summary: `${PROVIDER_NAMES[provider]} sign-in completed.`,
              routeAfter,
            };
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || providerAttemptRef.current?.id !== attempt.id) {
            return {
              status: "blocked" as const,
              summary: "A newer sign-in attempt replaced this one.",
            };
          }
          const cancelled = isAuthCancel(error);
          if (error && typeof error === "object" && "code" in error &&
              error.code === "auth/popup-closed-by-user") {
            setProviderRecovery("Sign-in didn’t finish. Please try again.");
          }
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
              `Could not sign in with ${PROVIDER_NAMES[provider]}.`,
              { description: authErrorMessage(error) },
            );
          }
          return {
            status: cancelled ? ("blocked" as const) : ("failed" as const),
            summary: cancelled
              ? `${PROVIDER_NAMES[provider]} sign-in was cancelled.`
              : authErrorMessage(error),
          };
        })
        .finally(() => {
          if (providerAbortRef.current === controller) providerAbortRef.current = null;
          attentionResolversRef.current.delete(attempt.id);
          if (providerAttemptRef.current?.id === attempt.id) {
            publishProviderAttempt(null);
          }
        });

      return Promise.race([settlementPromise, attentionPromise]);
    },
    [
      initialContactsEnabled,
      findInitialContacts,
      emailExpanded,
      finishAuthentication,
      publishProviderAttempt,
      redirectPath,
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
  // Terms and Privacy Policy are ordinary pages. Voice takes the same
  // same-tab navigation the footer links do; Back returns to sign-in.
  useLocalOnboardingActionHandler("auth.open_terms", async () => {
    router.push(ROUTES.TERMS);
    return {
      status: "started",
      summary: "Opening the Terms.",
      routeAfter: ROUTES.TERMS,
    };
  });
  useLocalOnboardingActionHandler("auth.open_privacy", async () => {
    router.push(ROUTES.PRIVACY);
    return {
      status: "started",
      summary: "Opening the Privacy Policy.",
      routeAfter: ROUTES.PRIVACY,
    };
  });

  usePublishVoiceSurfaceMetadata(
    {
      screenId: "login",
      title: "Sign in to One",
      purpose:
        "This is the sign-in screen. Help the person sign in with Apple or Google so they can open their private vault. Terms and Privacy Policy open as their own pages.",
      actions: [
        ...(!providerBusy && !emailExpanded
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
          purpose: "Open the Terms page.",
        },
        {
          id: "auth.open_privacy",
          actionId: "auth.open_privacy",
          label: "Privacy Policy",
          purpose: "Open the Privacy Policy page.",
        },
        ...(!providerBusy && !emailExpanded
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
        ...(!providerBusy && !emailExpanded
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
          purpose: "Open the Terms page.",
          actionId: "auth.open_terms",
          role: "link",
        },
        {
          id: "auth_privacy",
          label: "Privacy Policy",
          purpose: "Open the Privacy Policy page.",
          actionId: "auth.open_privacy",
          role: "link",
        },
        ...(!providerBusy && !emailExpanded
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

  if (hydrated && !authLoading && sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={retrySessionVerification}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  if (!hydrated || authLoading || user) {
    return (
      <HushhLoader
        stage={!hydrated || authLoading ? "session" : "workspace"}
        label="Checking session..."
        holdThroughNavigation={hydrated && !authLoading && Boolean(user)}
      />
    );
  }

  const authOptions = isAndroid()
    ? [
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon className="size-6" />,
          onClick: () => handleProviderLogin("google", { initiator: "tap" }),
        },
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon className={cn("size-6", lightStyles.appleProviderIcon)} />,
          onClick: () => handleProviderLogin("apple", { initiator: "tap" }),
        },
      ]
    : [
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon className={cn("size-6", lightStyles.appleProviderIcon)} />,
          onClick: () => handleProviderLogin("apple", { initiator: "tap" }),
        },
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon className="size-6" />,
          onClick: () => handleProviderLogin("google", { initiator: "tap" }),
        },
      ];

  const showReviewer = shouldAutoAuthenticateReviewer(nativeTestConfig) && nativeReviewerVisible;

  if (isWeb()) {
    authOptions.push({
      id: "microsoft", label: "Continue with Microsoft",
      icon: <span aria-hidden="true" className={cn("grid size-6 grid-cols-2 gap-[2px]", lightStyles.microsoftProviderIcon)}>
        {["#f25022", "#7fba00", "#00a4ef", "#ffb900"].map((color) => <span key={color} style={{ backgroundColor: color }} />)}
      </span>,
      onClick: () => handleProviderLogin("microsoft", { initiator: "tap" }),
    });
  }

  return (
    <main
      className={lightStyles.shell}
      style={{
        height: "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
        minHeight: "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
      }}
      data-testid="auth-step-primary"
    >
      <NativeTestBeacon
        routeId="/login"
        marker="native-route-login"
        authState={nativeAuthState}
        dataState={nativeDataState}
        attachToBridge={(bridge) => {
          bridge.triggerReviewerLogin = () => {
            const liveConfig = getNativeTestConfig();
            const localCredentials = resolveLocalReviewerCredentials(window.location.hostname);
            if (shouldUseNativeTestBootstrap || (liveConfig.enabled && liveConfig.autoReviewerLogin)
              || autoReviewerLoginStartedRef.current
              || !canStartReviewerLogin(liveConfig, reviewModeConfig.enabled, Boolean(localCredentials))) {
              return;
            }
            autoReviewerLoginStartedRef.current = true;
            setNativeReviewerVisible(true);
            setNativeAuthState("pending");
            setNativeDataState("loading");
            setNativeErrorCode(null);
            void handleReviewerLogin(false);
          };
        }}
        errorCode={
          nativeErrorCode ??
          `cfg_${nativeTestConfig.enabled ? "1" : "0"}_${nativeTestConfig.autoReviewerLogin ? "1" : "0"}`
        }
      />

      <div className={lightStyles.frame}>
        <button
          type="button"
          onClick={handleBack}
          disabled={providerBusy}
          aria-label={providerBusy ? "Sign-in in progress" : "Go back"}
          data-voice-control-id={providerBusy ? undefined : "auth_back"}
          className={lightStyles.back}
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
        </button>

        <div className={lightStyles.artwork} data-auth-illustration>
          <OneWelcomeArtwork />
        </div>

        <div
          className={lightStyles.content}
          data-auth-content-block
        >
          <div
            className={cn("flex w-full flex-none flex-col items-center gap-5 px-2 text-center", lightStyles.clusters)}
            data-auth-signin-clusters
          >
            <div className={cn("flex w-full flex-col items-center gap-3", lightStyles.hero)}>
              <h1
                role="heading"
                aria-level={1}
                aria-label="Welcome to One"
                className={lightStyles.title}
              >
                Welcome to One
                <span className="text-[#387BF5]">.</span>
              </h1>
            </div>

            <div className={cn("relative mx-auto w-full max-w-[344px] space-y-3.5", lightStyles.actions)}>
              {initialContactsEnabled && !emailExpanded ? (
                <div className={cn("space-y-2 text-start text-sm text-muted-foreground", lightStyles.contacts)}>
                  <label className="flex min-h-11 items-center gap-3 font-semibold">
                    <Checkbox checked={findInitialContacts} disabled={providerBusy}
                      onCheckedChange={(checked) => setFindInitialContacts(checked === true)} />
                    <span>Find people I know</span>
                  </label>
                  <p>Use my contacts to make a shared circle. Members can see who’s in it.</p>
                </div>
              ) : null}
              <div className="space-y-3" data-auth-provider-actions>
                {!emailExpanded && providerRecovery && !providerAttempt ? (
                  <p role="status" className="text-center text-sm text-muted-foreground">
                    {providerRecovery}
                  </p>
                ) : null}
                {!emailExpanded && providerAttempt?.phase === "attention_required" ? (
                  <p
                    role="status"
                    className="rounded-2xl bg-[color:var(--app-accent-tint)] px-4 py-3 text-center text-sm leading-relaxed text-[color:var(--app-accent-deep)] dark:bg-white/[0.08]"
                  >
                    The provider window needs attention. You can retry the same
                    sign-in option securely.
                  </p>
                ) : null}
                {!emailExpanded && authOptions.map((option) => (
                  <AuthProviderButton
                    key={option.id}
                    label={option.label}
                    icon={option.icon}
                    onClick={() => {
                      void option.onClick();
                    }}
                    disabled={providerBusy}
                    voiceControlId={option.id === "microsoft" ? undefined : `auth_${option.id}`}
                    className={cn(
                      option.id === "apple" ? APPLE_BTN_CLASS : GOOGLE_BTN_CLASS,
                      lightStyles.providerButton,
                    )}
                  />
                ))}
                {!emailExpanded ? <EnterpriseSsoSection
                  redirectPath={redirectPath}
                  disabled={providerBusy}
                /> : null}

                {isWeb() ? <EmailSignInSection
                  disabled={Boolean(providerAttempt)}
                  onBusyChange={setEmailOperationBusy}
                  onExpandedChange={setEmailExpanded}
                  onAuthenticated={handleEmailAuthenticated}
                /> : null}

                {showReviewer && !emailExpanded ? (
                  <AuthProviderButton
                    label="Continue as Reviewer"
                    icon={<Icon icon={Shield} size="md" />}
                    onClick={() => void handleReviewerLogin(true)}
                    disabled={providerBusy || shouldUseNativeTestBootstrap}
                    className={REVIEWER_BTN_CLASS}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className={lightStyles.footer}>
          <div
            className={cn("flex items-center gap-3.5 text-left max-w-[24rem]", lightStyles.legalRow)}
            data-auth-supporting-content
          >
            <p className="text-xs sm:text-[13px] leading-[1.35] text-[#8E8E93] dark:text-white/90">
              By continuing you agree to our{" "}
              <Link
                href={ROUTES.TERMS}
                data-voice-control-id="auth_terms"
                className="font-semibold text-[#387BF5] transition-opacity hover:opacity-75"
              >
                Terms
              </Link>
              <span aria-hidden="true"> and </span>
              <Link
                href={ROUTES.PRIVACY}
                data-voice-control-id="auth_privacy"
                className="font-semibold text-[#387BF5] transition-opacity hover:opacity-75"
              >
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

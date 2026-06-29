"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getRedirectResult } from "firebase/auth";
import { ArrowLeft, Shield } from "lucide-react";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { auth } from "@/lib/firebase/config";
import { useAuth } from "@/lib/firebase/auth-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isAndroid } from "@/lib/capacitor/platform";
import { Icon } from "@/lib/morphy-ux/ui";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";
import {
  kaiAppHeroBodyClassName,
  kaiAppHeroTitleClassName,
} from "@/components/kai/shared/kai-typography";
import { OneLockup } from "@/components/app-ui/gold-period";
import {
  isOnboardingFlowActiveCookieEnabled,
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { ROUTES } from "@/lib/navigation/routes";
import { type KaiLegalDocumentType } from "@/lib/legal/kai-legal-content";
import { trackEvent } from "@/lib/observability/client";
import {
  resolveGrowthEntrySurface,
  resolveGrowthJourneyForPath,
  trackGrowthFunnelStepCompleted,
} from "@/lib/observability/growth";
import { getNativeTestConfig, useNativeTestConfig } from "@/lib/testing/native-test";
import { resolveLocalReviewerCredentials } from "@/lib/testing/local-reviewer-auth";

// Firebase error codes that mean the user deliberately dismissed the provider
// popup. These are not real failures, so we stay silent for them and only toast
// on genuine errors (network, account-exists, blocked popup, etc.).
const AUTH_CANCEL_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
]);

function isAuthCancel(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return AUTH_CANCEL_CODES.has(code);
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
  compact = false,
}: {
  redirectPath: string;
  compact?: boolean;
}) {
  const nativeTestConfig = useNativeTestConfig();
  const router = useRouter();
  const { user, loading: authLoading, setNativeUser } = useAuth();
  const { registerSteps, completeStep, reset } = useStepProgress();
  const lastNavigationKeyRef = useRef<string | null>(null);
  const autoReviewerLoginStartedRef = useRef(false);
  const [nativeReviewerVisible, setNativeReviewerVisible] = useState(
    nativeTestConfig.autoReviewerLogin
  );
  const [nativeAuthState, setNativeAuthState] = useState<
    "anonymous" | "pending" | "authenticated"
  >(nativeTestConfig.autoReviewerLogin ? "pending" : "anonymous");
  const [nativeDataState, setNativeDataState] = useState<
    "loading" | "loaded" | "error"
  >(nativeTestConfig.autoReviewerLogin ? "loading" : "loaded");
  const [nativeErrorCode, setNativeErrorCode] = useState<string | null>(null);
  // Which social provider sign-in is in flight, so the buttons disable while a
  // popup is open and a second tap cannot trigger overlapping popups.
  const [pendingProvider, setPendingProvider] = useState<"google" | "apple" | null>(
    null
  );

  const [reviewModeConfig, setReviewModeConfig] = useState<{ enabled: boolean }>(
    { enabled: false }
  );
  const shouldUseNativeTestBootstrap =
    nativeTestConfig.enabled &&
    nativeTestConfig.autoReviewerLogin &&
    Boolean(nativeTestConfig.expectedUserId) &&
    Boolean(nativeTestConfig.vaultPassphrase);
  const preserveOnboardingAuditRoute =
    nativeTestConfig.enabled &&
    nativeTestConfig.expectedRoute === ROUTES.ONE_SETUP_KAI &&
    redirectPath === ROUTES.ONE_SETUP_KAI;
  const growthJourney = useMemo(() => resolveGrowthJourneyForPath(redirectPath), [redirectPath]);
  const growthEntrySurface = useMemo(
    () => resolveGrowthEntrySurface(redirectPath),
    [redirectPath]
  );
  const [activeLegalDoc, setActiveLegalDoc] = useState<KaiLegalDocumentType | null>(
    null
  );
  const localReviewerCredentialsAvailable = useMemo(() => {
    return Boolean(
      resolveLocalReviewerCredentials(
        typeof window !== "undefined" ? window.location.hostname : null
      )
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
  const openLegalDoc = useCallback((docType: KaiLegalDocumentType) => {
    // Defer open so the originating tap does not get interpreted as outside-interact.
    requestAnimationFrame(() => setActiveLegalDoc(docType));
  }, []);

  const handleBack = useCallback(() => {
    // Prefer real history; fall back to the marketing home when login was the
    // first entry (deep link / fresh tab) so the control is never a dead end.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(ROUTES.HOME);
  }, [router]);

  const resolveAndNavigate = useCallback(
    async (userId: string, idToken?: string, phoneNumber?: string | null) => {
      const navigationKey = `${userId}:${redirectPath || ROUTES.KAI_HOME}`;
      if (lastNavigationKeyRef.current === navigationKey) {
        return;
      }
      lastNavigationKeyRef.current = navigationKey;

      try {
        if (preserveOnboardingAuditRoute) {
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          router.push(ROUTES.ONE_SETUP_KAI);
          return;
        }
        const resolvedIdToken =
          idToken || (user ? await user.getIdToken().catch(() => undefined) : undefined);
        const resolvedPath = await PostAuthRouteService.resolveAfterLogin({
          userId,
          redirectPath,
          idToken: resolvedIdToken,
          phoneNumber,
          enableFirstRunSetupGate: true,
        });

        const resumeImportFlow =
          resolvedPath === ROUTES.KAI_HOME && isOnboardingFlowActiveCookieEnabled();
        const nextPath = resumeImportFlow ? ROUTES.KAI_IMPORT : resolvedPath;

        setOnboardingRequiredCookie(nextPath === ROUTES.ONE_SETUP);
        setOnboardingFlowActiveCookie(nextPath === ROUTES.KAI_IMPORT);
        router.push(nextPath);
      } catch (error) {
        console.warn("[AuthStep] Failed to resolve post-auth route:", error);
        const fallbackPath = redirectPath || ROUTES.KAI_HOME;
        const safeFallbackPath =
          fallbackPath === ROUTES.ONE_SETUP || fallbackPath === ROUTES.ONE_SETUP_KAI || fallbackPath === ROUTES.KAI_IMPORT
            ? ROUTES.KAI_HOME
            : fallbackPath;
        setOnboardingRequiredCookie(safeFallbackPath === ROUTES.ONE_SETUP);
        setOnboardingFlowActiveCookie(safeFallbackPath === ROUTES.KAI_IMPORT);
        router.push(safeFallbackPath);
      }
    },
    [preserveOnboardingAuditRoute, redirectPath, router, user]
  );

  const debugLog = (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(...args);
    }
  };

  const debugError = (label: string, error?: unknown) => {
    if (process.env.NODE_ENV !== "production" && error !== undefined) {
      console.error(label, error);
      return;
    }
    console.error(label);
  };

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

    getRedirectResult(auth)
      .then(async (result) => {
        if (result?.user) {
          trackEvent("auth_succeeded", {
            action: "redirect",
            result: "success",
          });
          if (growthJourney) {
            trackGrowthFunnelStepCompleted({
              journey: growthJourney,
              step: "auth_completed",
              entrySurface: growthEntrySurface,
              authMethod: "redirect",
              dedupeKey: `growth:${growthJourney}:auth_completed:redirect`,
              dedupeWindowMs: 5_000,
            });
          }
          debugLog("[AuthStep] Redirect result found, navigating to:", redirectPath);
          setNativeUser(result.user);
          void resolveAndNavigate(
            result.user.uid,
            await result.user.getIdToken(),
            result.user.phoneNumber
          );
        }
      })
      .catch((err) => {
        debugError("[AuthStep] Redirect auth error", err);
      });

    if (user) {
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
        typeof window !== "undefined" ? window.location.hostname : null
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
            localReviewerCredentials.password
          )
        : await (async () => {
            const { token } = await ApiService.createAppReviewModeSession("reviewer", {
              smokePassphrase: nativeTestConfig.autoReviewerLogin
                ? nativeTestConfig.vaultPassphrase
                : null,
            });
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
          authenticatedUser.phoneNumber
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
      morphyToast.error(err instanceof Error ? err.message : "Failed to sign in as reviewer");
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

  if (authLoading || user) {
    return <HushhLoader label="Checking session..." variant="fullscreen" />;
  }

  const handleGoogleLogin = async () => {
    if (pendingProvider) return;
    setPendingProvider("google");
    trackEvent("auth_started", {
      action: "google",
    });
    try {
      const authResult = await AuthService.signInWithGoogle();
      const authenticatedUser = authResult.user;

      debugLog("[AuthStep] signInWithGoogle returned user");

      if (authenticatedUser) {
        trackEvent("auth_succeeded", {
          action: "google",
          result: "success",
        });
        if (growthJourney) {
          trackGrowthFunnelStepCompleted({
            journey: growthJourney,
            step: "auth_completed",
            entrySurface: growthEntrySurface,
            authMethod: "google",
            dedupeKey: `growth:${growthJourney}:auth_completed:google`,
            dedupeWindowMs: 5_000,
          });
        }
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(
          authenticatedUser.uid,
          await authenticatedUser.getIdToken(),
          authenticatedUser.phoneNumber
        );
      } else {
        debugError("[AuthStep] No user returned from signInWithGoogle");
        trackEvent("auth_failed", {
          action: "google",
          result: "error",
          error_class: "missing_user",
        });
        morphyToast.error("Sign-in completed but no user session was returned.", {
          description: "Please try again.",
        });
      }
    } catch (err: any) {
      debugError("[AuthStep] Google login failed", err);
      trackEvent("auth_failed", {
        action: "google",
        result: "error",
        error_class: "auth_failed",
      });
      if (!isAuthCancel(err)) {
        morphyToast.error("Could not sign in with Google.", {
          description: authErrorMessage(err),
        });
      }
    } finally {
      setPendingProvider(null);
    }
  };

  const handleAppleLogin = async () => {
    if (pendingProvider) return;
    setPendingProvider("apple");
    trackEvent("auth_started", {
      action: "apple",
    });
    try {
      const authResult = await AuthService.signInWithApple();
      const authenticatedUser = authResult.user;

      debugLog("[AuthStep] signInWithApple returned user");

      if (authenticatedUser) {
        trackEvent("auth_succeeded", {
          action: "apple",
          result: "success",
        });
        if (growthJourney) {
          trackGrowthFunnelStepCompleted({
            journey: growthJourney,
            step: "auth_completed",
            entrySurface: growthEntrySurface,
            authMethod: "apple",
            dedupeKey: `growth:${growthJourney}:auth_completed:apple`,
            dedupeWindowMs: 5_000,
          });
        }
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(
          authenticatedUser.uid,
          await authenticatedUser.getIdToken(),
          authenticatedUser.phoneNumber
        );
      } else {
        debugError("[AuthStep] No user returned from signInWithApple");
        trackEvent("auth_failed", {
          action: "apple",
          result: "error",
          error_class: "missing_user",
        });
        morphyToast.error("Sign-in completed but no user session was returned.", {
          description: "Please try again.",
        });
      }
    } catch (err: any) {
      debugError("[AuthStep] Apple login failed", err);
      trackEvent("auth_failed", {
        action: "apple",
        result: "error",
        error_class: "auth_failed",
      });
      if (!isAuthCancel(err)) {
        morphyToast.error("Could not sign in with Apple.", {
          description: authErrorMessage(err),
        });
      }
    } finally {
      setPendingProvider(null);
    }
  };

  const authOptions = isAndroid()
    ? [
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon />,
          onClick: handleGoogleLogin,
        },
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon />,
          onClick: handleAppleLogin,
        },
      ]
    : [
        {
          id: "apple",
          label: "Continue with Apple",
          icon: <AppleIcon />,
          onClick: handleAppleLogin,
        },
        {
          id: "google",
          label: "Continue with Google",
          icon: <GoogleIcon />,
          onClick: handleGoogleLogin,
        },
      ];

  return (
    <main
      className="h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-white text-[#1d1d1f] dark:bg-[#000000] dark:text-[#f5f5f7]"
      data-testid="auth-step-primary"
    >
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
      <div
        className={
          compact
            ? "relative mx-auto flex h-full min-h-0 w-full max-w-[27rem] flex-col justify-center px-6 pb-[calc(54px+var(--app-screen-footer-pad))] pt-[calc(24px+var(--app-safe-area-top-effective,0px))]"
            : "relative mx-auto flex h-full min-h-0 w-full max-w-[27rem] flex-col justify-center px-6 pb-[calc(58px+var(--app-screen-footer-pad))] pt-[calc(32px+var(--app-safe-area-top-effective,0px))]"
        }
      >
        {/* Back button: shares the exact lean ShellActionSurface aesthetic and
            sits on the same fixed top line as the lean theme pill, mirroring the
            getting-started screen so both onboarding surfaces are symmetric. */}
        <ShellActionSurface
          variant="icon"
          onClick={handleBack}
          aria-label="Go back"
          wrapperClassName="fixed left-0 z-50 px-4 top-[calc(max(var(--app-safe-area-top-effective),0.5rem))]"
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
        </ShellActionSurface>
        <header className="flex-none text-center">
          <Image
            src="/one-quiet-emoji.png"
            alt="One"
            width={44}
            height={44}
            priority
            className="mx-auto h-11 w-11 object-contain drop-shadow-[0_12px_24px_rgba(0,0,0,0.08)]"
          />
          <div
            role="heading"
            aria-level={1}
            aria-label="Sign in to One"
            className={`mt-2.5 ${kaiAppHeroTitleClassName} text-[#1d1d1f] dark:text-[#f5f5f7]`}
          >
            Sign in to <OneLockup />
          </div>
          <p className={`mx-auto mt-3 max-w-[20rem] ${kaiAppHeroBodyClassName} text-[rgba(0,0,0,0.56)] dark:text-[rgba(245,245,247,0.60)]`}>
            Sign in to open your private vault, only you can.
          </p>
        </header>

        <section
          className={
            compact
              ? "flex-none pt-11"
              : "flex-none pt-12"
          }
        >
          <div className="mx-auto w-full max-w-[21.5rem] space-y-3">
            {authOptions.map((option) => (
              <AuthProviderButton
                key={option.id}
                label={option.label}
                icon={option.icon}
                onClick={option.onClick}
                disabled={pendingProvider !== null}
              />
            ))}

              {(reviewModeConfig.enabled ||
                nativeReviewerVisible ||
                localReviewerCredentialsAvailable ||
                isLocalReviewerSurface) && (
                <AuthProviderButton
                  label="Continue as Reviewer"
                  icon={<Icon icon={Shield} size="md" />}
                  onClick={handleReviewerLogin}
                />
              )}

            <p className="type-footnote mx-auto max-w-[18.75rem] pt-2 text-center text-[#86868b] dark:text-[#8e8e93]">
              A verified phone number is required before you continue.
            </p>
            </div>
          </section>

        <footer className="absolute inset-x-6 bottom-[calc(20px+var(--app-screen-footer-pad))] flex-none">
          <p className="type-footnote mx-auto max-w-[19.5rem] text-center text-[#86868b] dark:text-[#8e8e93]">
            By continuing, you agree to One&apos;s{" "}
            <button
              type="button"
              onClick={() => openLegalDoc("terms")}
              className="font-semibold text-[#b8894d] transition-opacity hover:opacity-70 dark:text-[#d4a574]"
            >
              Terms
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openLegalDoc("privacy")}
              className="font-semibold text-[#b8894d] transition-opacity hover:opacity-70 dark:text-[#d4a574]"
            >
              Privacy Policy
            </button>
            .
          </p>
        </footer>
      </div>
      <AuthLegalDialog
        docType={activeLegalDoc}
        onOpenChange={(open) => {
          if (!open) setActiveLegalDoc(null);
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
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <title>Apple</title>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
    </svg>
  );
}

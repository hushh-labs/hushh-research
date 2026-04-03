"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getRedirectResult } from "firebase/auth";
import { Phone, Shield } from "lucide-react";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { auth } from "@/lib/firebase/config";
import { useAuth } from "@/lib/firebase/auth-context";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isAndroid } from "@/lib/capacitor/platform";
import { BrandMark, Icon } from "@/lib/morphy-ux/ui";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";
import {
  isOnboardingFlowActiveCookieEnabled,
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { ROUTES } from "@/lib/navigation/routes";
import { type KaiLegalDocumentType } from "@/lib/legal/kai-legal-content";
import { trackEvent } from "@/lib/observability/client";
import { getNativeTestConfig, useNativeTestConfig } from "@/lib/testing/native-test";

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
    nativeTestConfig.expectedRoute === ROUTES.KAI_ONBOARDING &&
    redirectPath === ROUTES.KAI_ONBOARDING;
  const [activeLegalDoc, setActiveLegalDoc] = useState<KaiLegalDocumentType | null>(
    null
  );
  const openLegalDoc = useCallback((docType: KaiLegalDocumentType) => {
    // Defer open so the originating tap does not get interpreted as outside-interact.
    requestAnimationFrame(() => setActiveLegalDoc(docType));
  }, []);

  const resolveAndNavigate = useCallback(
    async (userId: string, idToken?: string) => {
      const navigationKey = `${userId}:${redirectPath || ROUTES.KAI_HOME}`;
      if (lastNavigationKeyRef.current === navigationKey) {
        return;
      }
      lastNavigationKeyRef.current = navigationKey;

      try {
        if (preserveOnboardingAuditRoute) {
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);
          router.push(ROUTES.KAI_ONBOARDING);
          return;
        }
        const resolvedIdToken =
          idToken || (user ? await user.getIdToken().catch(() => undefined) : undefined);
        const resolvedPath = await PostAuthRouteService.resolveAfterLogin({
          userId,
          redirectPath,
          idToken: resolvedIdToken,
        });

        const resumeImportFlow =
          resolvedPath === ROUTES.KAI_HOME && isOnboardingFlowActiveCookieEnabled();
        const nextPath = resumeImportFlow ? ROUTES.KAI_IMPORT : resolvedPath;

        setOnboardingRequiredCookie(nextPath === ROUTES.KAI_ONBOARDING);
        setOnboardingFlowActiveCookie(nextPath === ROUTES.KAI_IMPORT);
        router.push(nextPath);
      } catch (error) {
        console.warn("[AuthStep] Failed to resolve post-auth route:", error);
        const fallbackPath = redirectPath || ROUTES.KAI_HOME;
        const safeFallbackPath =
          fallbackPath === ROUTES.KAI_ONBOARDING || fallbackPath === ROUTES.KAI_IMPORT
            ? ROUTES.KAI_HOME
            : fallbackPath;
        setOnboardingRequiredCookie(safeFallbackPath === ROUTES.KAI_ONBOARDING);
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
    if (authLoading) return;
    completeStep();

    getRedirectResult(auth)
      .then(async (result) => {
        if (result?.user) {
          trackEvent("auth_succeeded", {
            action: "redirect",
            result: "success",
          });
          debugLog("[AuthStep] Redirect result found, navigating to:", redirectPath);
          setNativeUser(result.user);
          void resolveAndNavigate(result.user.uid, await result.user.getIdToken());
        }
      })
      .catch((err) => {
        debugError("[AuthStep] Redirect auth error", err);
      });

    if (user) {
      trackEvent("auth_succeeded", {
        action: "redirect",
        result: "success",
      });
      debugLog("[AuthStep] User authenticated, navigating to:", redirectPath);
      void resolveAndNavigate(user.uid, undefined);
    }
  }, [
    redirectPath,
    user,
    authLoading,
    completeStep,
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
      if (!reviewModeConfig.enabled && !nativeTestConfig.autoReviewerLogin) {
        throw new Error("Reviewer mode is not enabled");
      }

      const { token } = await ApiService.createAppReviewModeSession("reviewer");
      const authResult = await AuthService.signInWithCustomToken(token);
      const authenticatedUser = authResult.user;

      if (authenticatedUser) {
        setNativeAuthState("authenticated");
        setNativeDataState("loaded");
        setNativeErrorCode(null);
        trackEvent("auth_succeeded", {
          action: "reviewer",
          result: "success",
        });
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(authenticatedUser.uid, await authenticatedUser.getIdToken());
      } else {
        trackEvent("auth_failed", {
          action: "reviewer",
          result: "error",
          error_class: "missing_user",
        });
        morphyToast.error("Reviewer login failed: no user session returned.");
      }
    } catch (err: any) {
      setNativeAuthState("anonymous");
      setNativeDataState("error");
      setNativeErrorCode("reviewer_login_failed");
      debugError("[AuthStep] Reviewer login failed", err);
      trackEvent("auth_failed", {
        action: "reviewer",
        result: "error",
        error_class: "auth_failed",
      });
      morphyToast.error(err.message || "Failed to sign in as reviewer");
    }
  }, [
    nativeTestConfig.autoReviewerLogin,
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
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(authenticatedUser.uid, await authenticatedUser.getIdToken());
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
    }
  };

  const handleAppleLogin = async () => {
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
        setNativeUser(authenticatedUser);
        await resolveAndNavigate(authenticatedUser.uid, await authenticatedUser.getIdToken());
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
    <main className="min-h-[100dvh] w-full bg-transparent" data-testid="auth-step-primary">
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
            ? "mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-8 pt-[calc(16px+var(--app-safe-area-top-effective,0px))] pb-[var(--app-screen-footer-pad)]"
            : "mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-8 pt-10 pb-[var(--app-screen-footer-pad)]"
        }
      >
        <header className="flex-none text-center">
          <BrandMark label="Kai" size={compact ? "sm" : "md"} className="mx-auto" />
          {compact ? (
            <>
              <h1 className="mt-6 text-[clamp(1.75rem,5.8vw,2.35rem)] font-black tracking-tight leading-[1.12]">
                Sign in to Kai
              </h1>
              <p className="mx-auto mt-3 max-w-[17.5rem] text-sm leading-relaxed text-muted-foreground">
                Continue with your preferred provider.
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-8 text-[clamp(2.2rem,7vw,3rem)] font-black tracking-tight leading-[1.08]">
                Meet Kai,
                <br />
                Your Personal
                <br />
                Financial Advisor
              </h1>
              <p className="mx-auto mt-4 max-w-[17.5rem] text-[17px] leading-relaxed text-muted-foreground">
                The fastest path to actionable wealth insights.
              </p>
            </>
          )}
        </header>

        <section className={compact ? "flex-1 min-h-0 flex items-center pt-6" : "flex-1 min-h-0 flex items-center"}>
          <div className="mx-auto w-full max-w-[20rem] space-y-3">
            {authOptions.map((option) => (
              <AuthProviderButton
                key={option.id}
                label={option.label}
                icon={option.icon}
                onClick={option.onClick}
              />
            ))}

            <AuthProviderButton
              label="Continue with Phone Number"
              icon={<Icon icon={Phone} size="md" className="text-[var(--morphy-primary-start)]" />}
              disabled
            />

            <p className="pt-1 text-center text-xs text-muted-foreground">
              Phone sign-in is coming soon.
            </p>

            {(reviewModeConfig.enabled || nativeReviewerVisible) && (
              <AuthProviderButton
                label="Continue as Reviewer"
                icon={<Icon icon={Shield} size="md" />}
                onClick={handleReviewerLogin}
                className="border-yellow-500/30"
              />
            )}
          </div>
        </section>

        <footer className={compact ? "flex-none pt-4" : "flex-none pt-3"}>
          <p className="mx-auto max-w-[18.75rem] text-center text-[11px] leading-normal text-muted-foreground/80">
            By continuing, you agree to Kai&apos;s{" "}
            <button
              type="button"
              onClick={() => openLegalDoc("terms")}
              className="font-semibold text-foreground underline underline-offset-2 transition-opacity hover:opacity-70"
            >
              Terms
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openLegalDoc("privacy")}
              className="font-semibold text-foreground underline underline-offset-2 transition-opacity hover:opacity-70"
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
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.38-1.07-.52-2.07-.51-3.2 0-1.01.43-2.1.49-2.98-.38C5.22 17.63 2.7 12 5.45 8.04c1.47-2.09 3.8-2.31 5.33-1.18 1.1.75 3.3.73 4.45-.04 2.1-1.31 3.55-.95 4.5 1.14-.15.08.2.14 0 .2-2.63 1.34-3.35 6.03.95 7.84-.46 1.4-1.25 2.89-2.26 4.4l-.07.08-.05-.2zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.17 2.22-1.8 4.19-3.74 4.25z" />
    </svg>
  );
}

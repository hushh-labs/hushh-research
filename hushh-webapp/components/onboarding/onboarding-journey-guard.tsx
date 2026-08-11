"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import {
  buildOneSetupRoute,
  isCapabilityOnboardingRoute,
  isOnboardingAdmissionExemptRoute,
  isOneSetupRoute,
  isOneSetupSurfaceRoute,
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import { OneSetupCompletionHintService } from "@/lib/services/one-setup-completion-hint-service";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

const SETUP_REDIRECT_RETRY_MS = 1200;
const SETUP_REDIRECT_FAILURE_MS = 2400;
const SETUP_BOOTSTRAP_RETRY_MS = 300;

function waitForBootstrapRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETUP_BOOTSTRAP_RETRY_MS));
}

function hasExplicitIncompleteSetup(state: PreVaultUserState): boolean {
  if (PreVaultUserStateService.isSetupResolved(state)) return false;
  if (state.setupCompleted === false) return true;
  return (
    state.onboardingJourneyVersion === 1 &&
    state.onboardingPhase !== null &&
    state.onboardingPhase !== "root_completion"
  );
}

function admissionAllowsCurrentRoute(params: {
  state: PreVaultUserState;
  pathname: string;
  setupSurface: boolean;
}): boolean {
  const { pathname, setupSurface, state } = params;
  // Product routes (including the Location workspace at /one/location) stay
  // gated until the overall first-run setup is resolved via the master
  // "Finish setup" action, which requires the Connections step. Completing an
  // individual capability like Location is NOT sufficient on its own — the
  // user must still return to /one/setup and finish setup before any main
  // workspace becomes reachable.
  return (
    !hasExplicitIncompleteSetup(state) ||
    setupSurface ||
    isCapabilityOnboardingRoute(state.onboardingActiveCapability, pathname)
  );
}

/**
 * App-wide authenticated onboarding admission gate.
 *
 * Next proxy cannot verify the browser's Firebase session or memory-only vault
 * state. This client boundary therefore owns the mutable journey decision once
 * for every route family. The durable pre-vault record is the root authority;
 * Finance/Kai preferences and query parameters never resolve or widen it.
 */
export function OnboardingJourneyGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.uid ?? null;
  const exempt = isOnboardingAdmissionExemptRoute(pathname);
  const setupSurface = isOneSetupSurfaceRoute(pathname);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [redirecting, setRedirecting] = useState(false);
  const redirectTargetRef = useRef<string | null>(null);
  const redirectWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Read query/hash from window at redirect time instead of useSearchParams:
  // this guard wraps every route (including the 404 shell) and a CSR bailout
  // from useSearchParams would break static prerender of /_not-found. The
  // href is only consumed client-side inside the effect below.
  const currentHref = useMemo(() => {
    if (typeof window === "undefined") return pathname;
    return `${pathname}${window.location.search}${window.location.hash}`;
  }, [pathname]);
  const cachedState = userId
    ? PreVaultUserStateService.getCachedBootstrapState?.(userId) ?? null
    : null;
  // Honor the durable positive latch even when a session cache exists. The
  // latch is positive-only and is cleared in lockstep with any authoritative
  // `setupCompleted === false` read, so it never contradicts a genuine
  // incomplete state — but it DOES override a stale/transient cache value that
  // would otherwise re-force setup on every navigation for the whole session.
  const persistentSetupResolved = Boolean(
    userId && OneSetupCompletionHintService.isResolved(userId),
  );
  const cachedAdmissionAllowsCurrentRoute = Boolean(
    persistentSetupResolved ||
      (cachedState &&
        admissionAllowsCurrentRoute({
          state: cachedState,
          pathname,
          setupSurface,
        })),
  );
  // "Dismissed" = the user finished/skipped onboarding at least once. The root
  // setup funnel is one-time, so every post-completion setup arrival is ejected
  // to home. Account reset/delete clears this durable state and re-enables the
  // canonical setup route through the existing recovery flow.
  const setupDismissed = Boolean(
    persistentSetupResolved ||
      (cachedState && PreVaultUserStateService.isSetupResolved(cachedState)),
  );
  // Finance setup remains a valid, bounded capability entry after the one-time
  // root journey is dismissed. Root completion (including Skip) is not the
  // durable Finance completion signal.
  const isPostRootFinanceSetup =
    normalizeStaticExportPathname(pathname) === ROUTES.ONE_SETUP_FINANCE;
  const shouldEjectSetupSurface = Boolean(
    setupSurface && setupDismissed && !isPostRootFinanceSetup,
  );

  useEffect(() => {
    let cancelled = false;

    function clearRedirectWatchdog() {
      if (redirectWatchdogRef.current === null) return;
      clearTimeout(redirectWatchdogRef.current);
      redirectWatchdogRef.current = null;
    }

    clearRedirectWatchdog();
    setRedirecting(false);

    async function verifyAdmission() {
      if (authLoading) return;
      if (!userId || exempt) {
        redirectTargetRef.current = null;
        setError(null);
        setChecking(false);
        return;
      }
      if (setupSurface) {
        // First onboarding is admitted. A dismissed user who reaches a setup
        // surface (browser/OS back, history, direct URL, or stale navigation)
        // is ejected to home — this is the one place that catches every arrival
        // path after the one-time gate resolves.
        if (shouldEjectSetupSurface) {
          if (redirectTargetRef.current !== ROUTES.ONE_HOME) {
            redirectTargetRef.current = ROUTES.ONE_HOME;
            setRedirecting(true);
            router.replace(ROUTES.ONE_HOME);
          }
          return;
        }
        redirectTargetRef.current = null;
        setError(null);
        setChecking(false);
        return;
      }

      // Setup completion is a one-time, non-sensitive admission fact. Hydrate
      // it synchronously from the user-scoped positive latch so a returning
      // user does not wait on the same bootstrap request after every WebView or
      // browser restart. Explicit backend-incomplete responses and sign-out
      // clear this latch; vault keys and owner tokens remain memory-only.
      if (persistentSetupResolved) {
        redirectTargetRef.current = null;
        setError(null);
        setChecking(false);
        return;
      }

      // A fresh session record is already sufficient to admit this route.
      // Do not toggle checking on every client navigation: it adds two root
      // renders and competes with the nested vault/phone guards despite no
      // network work being required.
      if (
        cachedState &&
        admissionAllowsCurrentRoute({
          state: cachedState,
          pathname,
          setupSurface,
        })
      ) {
        redirectTargetRef.current = null;
        setError(null);
        setChecking(false);
        return;
      }

      // Native WKWebView evicts localStorage across launches (iosScheme
      // "App"), so the positive latch can be cold even for a resolved user on
      // relaunch. Restore it from durable native storage before paying for a
      // network bootstrap; this also prevents a transient cold-start read from
      // re-trapping a resolved user on the setup hub. Native-only: web
      // localStorage persists, so there is nothing to rehydrate there.
      if (!cachedState && Capacitor.isNativePlatform()) {
        const restored =
          await OneSetupCompletionHintService.hydrateFromNative(userId);
        if (cancelled) return;
        if (restored) {
          redirectTargetRef.current = null;
          setError(null);
          setChecking(false);
          return;
        }
      }

      setChecking(true);
      setError(null);
      try {
        let state = cachedState;
        if (!state) {
          try {
            state = await PreVaultUserStateService.bootstrapState(userId);
          } catch {
            // Native auth restoration and cross-tab web auth can publish the
            // user before the token provider or proxy is ready. Retry once
            // with a forced read; never create an unbounded setup loop.
            await waitForBootstrapRetry();
            if (cancelled) return;
            state = await PreVaultUserStateService.bootstrapState(userId, {
              force: true,
            });
          }
        }
        if (cancelled) return;

        // A missing legacy mirror is not evidence that an established account
        // is incomplete. New journeys write setupCompleted=false and a versioned
        // phase, so only explicit durable state activates the hard gate.
        if (
          admissionAllowsCurrentRoute({ state, pathname, setupSurface })
        ) {
          redirectTargetRef.current = null;
          setChecking(false);

          // Bootstrap state is session-cached and updated through the journey
          // services on every local mutation/callback. Do not re-fetch it on
          // every route change; explicit recovery and terminal settlement use
          // the force-refresh path and expected-version guard instead.
          return;
        }

        const redirectTarget = buildOneSetupRoute({ returnTo: currentHref });
        if (redirectTargetRef.current === redirectTarget) {
          return;
        }
        redirectTargetRef.current = redirectTarget;
        setRedirecting(true);
        router.replace(redirectTarget);
        // Keep the redirect inside the App Router. A document navigation here
        // would destroy the memory-only vault key and could re-enter this gate
        // indefinitely. Retry once, then expose a recoverable error.
        redirectWatchdogRef.current = setTimeout(() => {
          if (cancelled || typeof window === "undefined") return;
          if (isOneSetupRoute(window.location.pathname)) {
            setRedirecting(false);
            setChecking(false);
            return;
          }
          router.replace(redirectTarget);
          redirectWatchdogRef.current = setTimeout(() => {
            if (cancelled || typeof window === "undefined") return;
            if (isOneSetupRoute(window.location.pathname)) {
              setRedirecting(false);
              setChecking(false);
              return;
            }
            redirectTargetRef.current = null;
            setRedirecting(false);
            setChecking(false);
            setError("Unable to open setup. Please retry.");
          }, SETUP_REDIRECT_FAILURE_MS);
        }, SETUP_REDIRECT_RETRY_MS);
      } catch (cause) {
        console.warn(
          "[OnboardingJourneyGuard] Failed to verify setup admission:",
          cause,
        );
        if (!cancelled) {
          setError("Unable to verify setup progress. Please retry.");
          setChecking(false);
        }
      }
    }

    void verifyAdmission();
    return () => {
      cancelled = true;
      clearRedirectWatchdog();
    };
  }, [
    authLoading,
    cachedState,
    currentHref,
    exempt,
    pathname,
    persistentSetupResolved,
    retryNonce,
    router,
    setupSurface,
    shouldEjectSetupSurface,
    userId,
  ]);

  const passThrough = exempt || (!authLoading && !userId);
  const loaderActive =
    !passThrough &&
    (shouldEjectSetupSurface ||
      (checking && !cachedAdmissionAllowsCurrentRoute) ||
      authLoading ||
      redirecting);
  // Suppress the persistent shell (top tabs/back + bottom nav) while the setup
  // admission check paints its loader, so the loader never leaks the page frame.
  useSessionChromeSuppression(loaderActive);

  if (passThrough) return <>{children}</>;
  if (loaderActive) {
    return (
      <HushhLoader
        label={
          shouldEjectSetupSurface
            ? "Opening One..."
            : redirecting
              ? "Returning to setup..."
              : "Checking setup..."
        }
      />
    );
  }
  if (error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card/70 p-4 text-center">
          <p className="text-sm text-foreground">{error}</p>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => {
              setChecking(true);
              setRetryNonce((value) => value + 1);
            }}
          >
            Retry
          </Button>
          <Button
            size="sm"
            variant="muted"
            effect="fade"
            className="mt-3"
            onClick={() => router.push(ROUTES.PROFILE)}
          >
            Open profile
          </Button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

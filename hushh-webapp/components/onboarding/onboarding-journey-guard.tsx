"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import {
  buildOneSetupRoute,
  isCapabilityOnboardingRoute,
  isOnboardingAdmissionExemptRoute,
  isOneSetupSurfaceRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";

const SETUP_REDIRECT_WATCHDOG_MS = 2400;

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
  const cachedAdmissionAllowsCurrentRoute = Boolean(
    cachedState &&
      admissionAllowsCurrentRoute({
        state: cachedState,
        pathname,
        setupSurface,
      }),
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
      if (
        !userId ||
        exempt ||
        (setupSurface && pathname !== ROUTES.ONE_SETUP)
      ) {
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

      setChecking(true);
      setError(null);
      try {
        const state =
          cachedState ??
          (await PreVaultUserStateService.bootstrapState(userId));
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
        // Watchdog (from main): if the client router never lands on the setup
        // route, force a hard navigation; otherwise release the loader.
        redirectWatchdogRef.current = setTimeout(() => {
          if (cancelled || typeof window === "undefined") return;
          if (window.location.pathname !== ROUTES.ONE_SETUP) {
            window.location.assign(redirectTarget);
            return;
          }
          setRedirecting(false);
          setChecking(false);
        }, SETUP_REDIRECT_WATCHDOG_MS);
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
    retryNonce,
    router,
    setupSurface,
    userId,
  ]);

  if (exempt || (!authLoading && !userId)) return <>{children}</>;
  if (
    (checking && !cachedAdmissionAllowsCurrentRoute) ||
    authLoading ||
    redirecting
  ) {
    return <HushhLoader label={redirecting ? "Returning to setup..." : "Checking setup..."} />;
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
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

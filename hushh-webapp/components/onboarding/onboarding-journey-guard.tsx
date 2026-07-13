"use client";

import { useEffect, useMemo, useState } from "react";
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

function hasExplicitIncompleteSetup(state: PreVaultUserState): boolean {
  if (PreVaultUserStateService.isSetupResolved(state)) return false;
  if (state.setupCompleted === false) return true;
  return (
    state.onboardingJourneyVersion === 1 &&
    state.onboardingPhase !== null &&
    state.onboardingPhase !== "root_completion"
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

  const currentHref = useMemo(() => {
    if (typeof window === "undefined") return pathname;
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    setRedirecting(false);

    async function verifyAdmission() {
      if (authLoading) return;
      if (
        !userId ||
        exempt ||
        (setupSurface && pathname !== ROUTES.ONE_SETUP)
      ) {
        setError(null);
        setChecking(false);
        return;
      }

      setChecking(true);
      setError(null);
      try {
        const state = await PreVaultUserStateService.bootstrapState(userId, {
          force: true,
        });
        if (cancelled) return;

        // A missing legacy mirror is not evidence that an established account
        // is incomplete. New journeys write setupCompleted=false and a versioned
        // phase, so only explicit durable state activates the hard gate.
        if (!hasExplicitIncompleteSetup(state)) {
          setChecking(false);
          return;
        }

        // The hub is always a safe return point. An active capability remains
        // resumable there until its own explicit Finish or Skip settles it.
        if (setupSurface) {
          setChecking(false);
          return;
        }

        if (
          isCapabilityOnboardingRoute(
            state.onboardingActiveCapability,
            pathname,
          )
        ) {
          setChecking(false);
          return;
        }

        setRedirecting(true);
        router.replace(buildOneSetupRoute({ returnTo: currentHref }));
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
    };
  }, [
    authLoading,
    currentHref,
    exempt,
    pathname,
    retryNonce,
    router,
    setupSurface,
    userId,
  ]);

  if (exempt || (!authLoading && !userId)) return <>{children}</>;
  if (checking || authLoading || redirecting) {
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

"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { isPublicRoute } from "@/lib/navigation/routes";
import {
  resolveGrowthJourneyForPath,
  trackLocationFunnelStepCompleted,
} from "@/lib/observability/growth";

/**
 * Emits the One Location funnel gates that no single screen owns.
 *
 * `entered` and `auth_completed` already come from AuthStep, which resolves the
 * journey from the post-login redirect path. The remaining gates are imposed by
 * OneAuthGate (VaultLockGuard -> PhoneMandateGuard) rather than by any screen,
 * so there is no natural place to instrument them from.
 *
 * Why this matters: these gates sit between a friend tapping a Circle invite
 * and that friend appearing in someone's Circle. They are the prime suspects
 * for invite-path drop-off, and until they are measured, any change to them is
 * guesswork.
 *
 * Steps are claimed once per user, so re-renders and remounts are safe.
 */
export function LocationFunnelObserver() {
  const pathname = usePathname();
  const { user, loading, phoneNumber } = useAuth();

  const path = pathname ?? "";
  const isLocationJourney = resolveGrowthJourneyForPath(path) === "location";
  // Public location routes are viewable without an account by design, so an
  // anonymous visitor there is not someone being sent to sign in.
  const isPublic = isPublicRoute(path);

  useEffect(() => {
    if (!isLocationJourney || loading) return;

    if (!user) {
      // Only on a gated route, where the gate really is about to redirect.
      // Firing on a public share link counted people who were never asked to
      // sign in, and — because the step is claimed once per device — burned
      // the marker so their real sign-in later would never be recorded.
      if (!isPublic) {
        trackLocationFunnelStepCompleted("auth_started");
      }
      return;
    }

    if (phoneNumber) {
      trackLocationFunnelStepCompleted("phone_verified");
    }
  }, [isLocationJourney, isPublic, loading, phoneNumber, user]);

  return null;
}

/**
 * Emits `vault_unlocked`, and is deliberately mounted as a child of
 * VaultLockGuard rather than reading vault state itself.
 *
 * The guard's contract is "Auth ✅ + Vault ✅ → Render children", so reaching
 * this component *is* the unlock signal. Calling `useVault()` instead would add
 * a hard VaultProvider dependency to a purely observational component — which
 * is exactly what broke every OneAuthGate test when this was first written, and
 * would have thrown in any tree that renders the gate without the provider.
 * Infer the state from position; do not reach for the context.
 */
export function LocationVaultUnlockedObserver() {
  const pathname = usePathname();
  const isLocationJourney =
    resolveGrowthJourneyForPath(pathname ?? "") === "location";

  useEffect(() => {
    if (!isLocationJourney) return;
    trackLocationFunnelStepCompleted("vault_unlocked");
  }, [isLocationJourney]);

  return null;
}

"use client";

import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { RiaService } from "@/lib/services/ria-service";
import {
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { shouldRequirePhoneMandate } from "@/lib/services/phone-mandate-service";
import type { PreVaultOnboardingAnswers } from "@/lib/services/pre-vault-onboarding-service";

const PRE_VAULT_ROUTE = ROUTES.ONE_ONBOARDING;
const DEFAULT_HOME_ROUTE = ROUTES.ONE_HOME;
const NO_VAULT_DEFAULT_ROUTE = ROUTES.ONE_HOME;

function normalizeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.trim()) return DEFAULT_HOME_ROUTE;
  if (path === ROUTES.PHONE_MANDATE || path.startsWith(`${ROUTES.PHONE_MANDATE}?`)) {
    return DEFAULT_HOME_ROUTE;
  }
  return path;
}

function hasCompletePreVaultAnswers(
  answers: PreVaultOnboardingAnswers | null | undefined,
): boolean {
  return Boolean(
    answers?.investment_horizon &&
      answers?.drawdown_response &&
      answers?.volatility_preference,
  );
}

function isOneLocationInviteRedirect(path: string): boolean {
  return (
    path === ROUTES.ONE_LOCATION ||
    path.startsWith(`${ROUTES.ONE_LOCATION}?`) ||
    path.startsWith(`${ROUTES.ONE_LOCATION}/invite/`)
  );
}

function inviteRedirectTargetFor(path: string): string | null {
  if (isOneLocationInviteRedirect(path)) return path;
  try {
    const url = new URL(path, "https://one.local");
    if (url.pathname !== ROUTES.PROFILE) return null;
    const returnTo = url.searchParams.get("return_to");
    return returnTo && isOneLocationInviteRedirect(returnTo) ? returnTo : null;
  } catch {
    return null;
  }
}

export class PostAuthRouteService {
  /**
   * Apply the soft first-run One Setup gate to a home-bound destination.
   *
   * Returns `ROUTES.ONE_SETUP` only when the caller opted in, the login is
   * organic (no explicit redirect target), and the user has not yet seen the
   * one-time setup nudge. Otherwise returns the original home route unchanged,
   * so existing post-auth behavior is preserved for every other path.
   */
  private static applyFirstRunSetupGate(params: {
    userId: string;
    homeRoute: string;
    enableFirstRunSetupGate?: boolean;
    hasExplicitRedirect: boolean;
  }): string {
    if (!params.enableFirstRunSetupGate) return params.homeRoute;
    if (params.hasExplicitRedirect) return params.homeRoute;
    if (OneSetupGateService.hasSeen(params.userId)) return params.homeRoute;
    return ROUTES.ONE_SETUP;
  }

  static async resolveAfterLogin(params: {
    userId: string;
    redirectPath?: string;
    idToken?: string;
    phoneNumber?: string | null;
    phoneVerified?: boolean | null;
    hostname?: string | null;
    enableFirstRunSetupGate?: boolean;
  }): Promise<string> {
    const hasExplicitRedirect = Boolean(params.redirectPath && params.redirectPath.trim());
    const fallbackRoute = normalizeRedirectPath(params.redirectPath);
    const remoteState = await PreVaultUserStateService.bootstrapState(params.userId);
    const canOverrideWithPersona =
      !params.redirectPath ||
      fallbackRoute === ROUTES.HOME ||
      fallbackRoute === ROUTES.ONE_HOME ||
      fallbackRoute === ROUTES.KAI_HOME ||
      fallbackRoute === ROUTES.LEGACY_KAI_HOME ||
      fallbackRoute === ROUTES.ONE_ONBOARDING ||
      fallbackRoute === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
      fallbackRoute === ROUTES.LEGACY_KAI_ONBOARDING;

    if (params.idToken && canOverrideWithPersona) {
      try {
        const personaState = await RiaService.getPersonaState(params.idToken, {
          userId: params.userId,
        });
        if (personaState.iam_schema_ready && personaState.active_persona === "ria") {
          return ROUTES.RIA_HOME;
        }
      } catch (error) {
        console.warn("[PostAuthRouteService] Failed to resolve persona state:", error);
      }
    }

    if (remoteState.hasVault) {
      const onboardingResolved = PreVaultUserStateService.isOnboardingResolved(remoteState);
      const inviteRedirectTarget = inviteRedirectTargetFor(fallbackRoute);
      if (
        remoteState.preOnboardingCompleted === false &&
        !onboardingResolved
      ) {
        return PRE_VAULT_ROUTE;
      }
      if (
        (fallbackRoute === ROUTES.ONE_ONBOARDING ||
          fallbackRoute === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
          fallbackRoute === ROUTES.LEGACY_KAI_ONBOARDING) &&
        onboardingResolved
      ) {
        return DEFAULT_HOME_ROUTE;
      }
      if (
        inviteRedirectTarget &&
        shouldRequirePhoneMandate({
          phoneNumber: params.phoneNumber,
          phoneVerified: params.phoneVerified,
          hasVault: true,
          hostname: params.hostname ?? (typeof window === "undefined" ? null : window.location.hostname),
          pathname: fallbackRoute,
        })
      ) {
        return buildPhoneMandateRoute(fallbackRoute);
      }
      if (onboardingResolved && fallbackRoute === DEFAULT_HOME_ROUTE) {
        return PostAuthRouteService.applyFirstRunSetupGate({
          userId: params.userId,
          homeRoute: fallbackRoute,
          enableFirstRunSetupGate: params.enableFirstRunSetupGate,
          hasExplicitRedirect,
        });
      }
      return fallbackRoute;
    }

    let onboardingResolved = PreVaultUserStateService.isOnboardingResolved(remoteState);
    if (!onboardingResolved) {
      const pending = await PreVaultOnboardingService.load(params.userId);
      const remoteUnset =
        remoteState.preOnboardingCompleted === null &&
        remoteState.preOnboardingSkipped === null &&
        remoteState.preOnboardingCompletedAt === null;
      const pendingResolved =
        pending?.completed === true &&
        Boolean(pending.completed_at) &&
        (pending.skipped === true || hasCompletePreVaultAnswers(pending.answers));

      if (remoteUnset && pendingResolved) {
        const completedAtMs =
          pending.completed_at && !Number.isNaN(Date.parse(pending.completed_at))
            ? Date.parse(pending.completed_at)
            : Date.now();
        try {
          await PreVaultUserStateService.updatePreVaultState(params.userId, {
            preOnboardingCompleted: true,
            preOnboardingSkipped: pending.skipped,
            preOnboardingCompletedAt: completedAtMs,
          });
        } catch (error) {
          console.warn(
            "[PostAuthRouteService] Failed local->remote pre-vault onboarding bridge:",
            error
          );
        }
        onboardingResolved = true;
      }
    }

    const inviteRedirectTarget = inviteRedirectTargetFor(fallbackRoute);
    const resolvedNoVaultRoute = inviteRedirectTarget
      ? buildProfileVaultRoute(inviteRedirectTarget)
      : onboardingResolved
        ? NO_VAULT_DEFAULT_ROUTE
        : PRE_VAULT_ROUTE;

    if (
      shouldRequirePhoneMandate({
        phoneNumber: params.phoneNumber,
        phoneVerified: params.phoneVerified,
        hasVault: false,
        hostname: params.hostname ?? (typeof window === "undefined" ? null : window.location.hostname),
      })
    ) {
      return buildPhoneMandateRoute(inviteRedirectTarget ?? resolvedNoVaultRoute);
    }

    if (resolvedNoVaultRoute === NO_VAULT_DEFAULT_ROUTE) {
      return PostAuthRouteService.applyFirstRunSetupGate({
        userId: params.userId,
        homeRoute: resolvedNoVaultRoute,
        enableFirstRunSetupGate: params.enableFirstRunSetupGate,
        hasExplicitRedirect,
      });
    }

    return resolvedNoVaultRoute;
  }
}

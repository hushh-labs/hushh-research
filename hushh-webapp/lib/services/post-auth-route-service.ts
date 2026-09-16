"use client";

import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  buildOneSetupRoute,
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
  isFirebaseSessionOnlyRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import { shouldRequirePhoneMandate } from "@/lib/services/phone-mandate-service";
import type { PreVaultOnboardingAnswers } from "@/lib/services/pre-vault-onboarding-service";

// Unresolved-onboarding users land on the canonical `/one/setup` capability hub
// (the investor-preferences wizard opens from the hub's finance tile).
const PRE_VAULT_ROUTE = ROUTES.ONE_SETUP;
// The canonical post-auth landing is the root Chat workspace. `/one` remains
// an explicit dashboard destination; it must not win over an organic login.
const DEFAULT_HOME_ROUTE = ROUTES.HOME;
const NO_VAULT_DEFAULT_ROUTE = ROUTES.HOME;

function normalizeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.trim()) return DEFAULT_HOME_ROUTE;
  // `/` is the dual-mode entry route: anonymous visitors see the welcome
  // surface, while authenticated users enter the private-agent Chat workspace.
  // Organic authentication always enters that canonical home; explicit
  // internal deep links remain untouched.
  if (path === ROUTES.HOME) return DEFAULT_HOME_ROUTE;
  if (
    path === ROUTES.PHONE_MANDATE ||
    path.startsWith(`${ROUTES.PHONE_MANDATE}?`)
  ) {
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
    if (
      url.pathname !== ROUTES.PROFILE &&
      url.pathname !== ROUTES.PROFILE_SECURITY
    ) {
      return null;
    }
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
   * organic (no explicit redirect target), the destination isn't the chat
   * workspace, and the user has not yet seen the one-time setup nudge.
   * Otherwise returns the original home route unchanged.
   *
   * The chat-workspace exclusion is load-bearing, not cosmetic:
   * `OnboardingJourneyGuard` unconditionally ejects an already
   * `setupResolved` account from ANY setup surface back to `ROUTES.ONE_HOME`
   * ("the one place that catches every arrival path after the one-time gate
   * resolves" — see that guard's own comment). `applyFirstRunSetupGate` is
   * only ever invoked for a `setupResolved` user, so once `DEFAULT_HOME_ROUTE`
   * became `ROUTES.HOME` (chat), nudging here sent a resolved user straight
   * into that guard's eject path: chat -> ONE_SETUP -> immediately bounced to
   * ONE_HOME, so the person landed on the dashboard instead of chat, or the
   * nudge, either one. That guard's rule is intentionally absolute (it exists
   * to stop a dismissed user ever re-entering setup by any path), so the fix
   * belongs here: stop attempting a redirect the guard can never let land.
   */
  private static applyFirstRunSetupGate(params: {
    userId: string;
    homeRoute: string;
    enableFirstRunSetupGate?: boolean;
    hasExplicitRedirect: boolean;
  }): string {
    if (!params.enableFirstRunSetupGate) return params.homeRoute;
    if (params.hasExplicitRedirect) return params.homeRoute;
    if (params.homeRoute === ROUTES.HOME) return params.homeRoute;
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
    const requestedRoute = normalizeRedirectPath(params.redirectPath);
    const safeExplicitRedirect = normalizeInternalRouteHref(requestedRoute);
    const hasExplicitRedirect = Boolean(
      params.redirectPath &&
      params.redirectPath.trim() &&
      params.redirectPath !== ROUTES.HOME &&
      safeExplicitRedirect,
    );
    const fallbackRoute = safeExplicitRedirect ?? DEFAULT_HOME_ROUTE;
    const fallbackUrl = new URL(fallbackRoute, "https://one.local");
    if (
      hasExplicitRedirect &&
      safeExplicitRedirect &&
      isFirebaseSessionOnlyRoute(fallbackUrl.pathname)
    ) {
      return safeExplicitRedirect;
    }
    const isSetupHubRedirect = fallbackUrl.pathname === ROUTES.ONE_SETUP;
    const setupReturnTo = normalizeInternalRouteHref(
      fallbackUrl.searchParams.get("return_to"),
    );
    const remoteState = await PreVaultUserStateService.bootstrapState(
      params.userId,
      { idToken: params.idToken },
    );
    // Native auth bridges can restore a valid Firebase session before their
    // local user object has hydrated `phoneNumber`. A positive backend claim
    // is authoritative for this login decision; an unknown/false claim still
    // follows the normal fail-closed phone mandate.
    const phoneVerified =
      params.phoneVerified === true || remoteState.phoneVerified === true;
    if (remoteState.hasVault) {
      const setupResolved =
        PreVaultUserStateService.isSetupResolved(remoteState);
      const inviteRedirectTarget = inviteRedirectTargetFor(fallbackRoute);
      if (remoteState.setupCompleted === false && !setupResolved) {
        if (hasExplicitRedirect && isSetupHubRedirect) return fallbackRoute;
        return hasExplicitRedirect && fallbackRoute !== PRE_VAULT_ROUTE
          ? buildOneSetupRoute({ returnTo: fallbackRoute })
          : PRE_VAULT_ROUTE;
      }
      if (
        (isSetupHubRedirect ||
          fallbackRoute === ROUTES.ONE_SETUP_FINANCE ||
          fallbackRoute === ROUTES.ONE_SETUP_KAI ||
          fallbackRoute === ROUTES.LEGACY_ONE_KAI_ONBOARDING ||
          fallbackRoute === ROUTES.LEGACY_KAI_ONBOARDING) &&
        setupResolved
      ) {
        return setupReturnTo || DEFAULT_HOME_ROUTE;
      }
      if (
        inviteRedirectTarget &&
        shouldRequirePhoneMandate({
          phoneNumber: params.phoneNumber,
          phoneVerified,
          hasVault: true,
          hostname:
            params.hostname ??
            (typeof window === "undefined" ? null : window.location.hostname),
          pathname: fallbackRoute,
        })
      ) {
        return buildPhoneMandateRoute(fallbackRoute);
      }
      if (setupResolved && fallbackRoute === DEFAULT_HOME_ROUTE) {
        return PostAuthRouteService.applyFirstRunSetupGate({
          userId: params.userId,
          homeRoute: fallbackRoute,
          enableFirstRunSetupGate: params.enableFirstRunSetupGate,
          hasExplicitRedirect,
        });
      }
      return fallbackRoute;
    }

    let setupResolved = PreVaultUserStateService.isSetupResolved(remoteState);
    if (!setupResolved) {
      const pending = await PreVaultOnboardingService.load(params.userId);
      const remoteUnset =
        remoteState.setupCompleted === null &&
        remoteState.setupSkipped === null &&
        remoteState.setupCompletedAt === null;
      const pendingResolved =
        pending?.completed === true &&
        Boolean(pending.completed_at) &&
        (pending.skipped === true ||
          hasCompletePreVaultAnswers(pending.answers));

      if (remoteUnset && pendingResolved) {
        const completedAtMs =
          pending.completed_at &&
          !Number.isNaN(Date.parse(pending.completed_at))
            ? Date.parse(pending.completed_at)
            : Date.now();
        try {
          await PreVaultUserStateService.updatePreVaultState(params.userId, {
            setupCompleted: true,
            setupSkipped: pending.skipped,
            setupCompletedAt: completedAtMs,
          });
        } catch (error) {
          console.warn(
            "[PostAuthRouteService] Failed local->remote pre-vault onboarding bridge:",
            error,
          );
        }
        setupResolved = true;
      }
    }

    const inviteRedirectTarget = inviteRedirectTargetFor(fallbackRoute);
    const resolvedNoVaultRoute = inviteRedirectTarget
      ? buildProfileVaultRoute(inviteRedirectTarget)
      : setupResolved
        ? NO_VAULT_DEFAULT_ROUTE
        : PRE_VAULT_ROUTE;

    if (
      shouldRequirePhoneMandate({
        phoneNumber: params.phoneNumber,
        phoneVerified,
        hasVault: false,
        hostname:
          params.hostname ??
          (typeof window === "undefined" ? null : window.location.hostname),
      })
    ) {
      return buildPhoneMandateRoute(
        inviteRedirectTarget ?? resolvedNoVaultRoute,
      );
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

"use client";

import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { AuthService } from "@/lib/services/auth-service";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  buildOneSetupRoute,
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
  isFirebaseSessionOnlyRoute,
  isInvitationPreviewRoute,
  isOneSetupSurfaceRoute,
  normalizeInternalRouteHref,
  normalizeStaticExportPathname,
  ROUTES,
} from "@/lib/navigation/routes";
import { shouldRequirePhoneMandate } from "@/lib/services/phone-mandate-service";
import type { PreVaultOnboardingAnswers } from "@/lib/services/pre-vault-onboarding-service";

// Unresolved-onboarding users land directly on the one mandatory step --
// choosing an AI -- rather than the `/one/setup` hub around it. The hub has
// nothing else to show while that's the only remaining item, so routing
// through it first is a redundant extra screen, not a safety rail: the hub
// itself is unchanged and stays reachable (e.g. after the AI choice, or via
// an explicit `/one/setup` deep link) for whatever it still needs to surface.
const PRE_VAULT_ROUTE = ROUTES.ONE_SETUP_CONNECTIONS;
// The canonical post-auth landing is the root Chat workspace. `/one` remains
// an explicit dashboard destination; it must not win over an organic login.
const DEFAULT_HOME_ROUTE = ROUTES.HOME;
const NO_VAULT_DEFAULT_ROUTE = ROUTES.HOME;

function normalizeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.trim()) return DEFAULT_HOME_ROUTE;
  // `/` is the dual-mode entry route: invited guests see the introduction,
  // while authenticated users enter the private-agent Chat workspace.
  // Organic authentication always enters that canonical home; explicit
  // internal deep links remain untouched.
  if (path === ROUTES.HOME) return DEFAULT_HOME_ROUTE;
  const safePath = normalizeInternalRouteHref(path);
  if (!safePath) return DEFAULT_HOME_ROUTE;
  const url = new URL(safePath, "https://one.local");
  if (normalizeStaticExportPathname(url.pathname) === ROUTES.PHONE_MANDATE) {
    // A session can expire during phone verification. Its login handoff wraps
    // the invite in `redirect`; unwrap only a safe invitation target and let
    // the normal phone/setup/vault rules re-evaluate the restored account.
    const target = normalizeInternalRouteHref(url.searchParams.get("redirect"));
    return target && inviteRedirectTargetFor(target)
      ? target
      : DEFAULT_HOME_ROUTE;
  }
  return safePath;
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
  const url = new URL(path, "https://one.local");
  const pathname = normalizeStaticExportPathname(url.pathname);
  return (
    isInvitationPreviewRoute(pathname) ||
    (pathname === ROUTES.CONNECT &&
      url.searchParams.get("action") === "join-circle") ||
    path === ROUTES.ONE_LOCATION ||
    path.startsWith(`${ROUTES.ONE_LOCATION}?`) ||
    path.startsWith(`${ROUTES.ONE_LOCATION}/invite/`)
  );
}

function inviteRedirectTargetFor(path: string): string | null {
  if (isOneLocationInviteRedirect(path)) return path;
  try {
    const url = new URL(path, "https://one.local");
    const pathname = normalizeStaticExportPathname(url.pathname);
    if (
      pathname !== ROUTES.PROFILE &&
      pathname !== ROUTES.PROFILE_SECURITY &&
      !isOneSetupSurfaceRoute(pathname)
    ) {
      return null;
    }
    const returnTo = normalizeInternalRouteHref(
      url.searchParams.get("return_to"),
    );
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
    const fallbackPathname = normalizeStaticExportPathname(
      fallbackUrl.pathname,
    );
    if (
      hasExplicitRedirect &&
      safeExplicitRedirect &&
      isFirebaseSessionOnlyRoute(fallbackUrl.pathname)
    ) {
      return safeExplicitRedirect;
    }
    const isSetupHubRedirect = fallbackPathname === ROUTES.ONE_SETUP;
    const setupReturnTo = normalizeInternalRouteHref(
      fallbackUrl.searchParams.get("return_to"),
    );
    const remoteState = await PreVaultUserStateService.bootstrapState(
      params.userId,
      { idToken: params.idToken },
    );
    // Native auth bridges can restore a valid Firebase session before their
    // local user object has hydrated `phoneNumber`. A positive backend claim
    // is authoritative for this login decision. Unknown claims must not be
    // turned into a new-account phone challenge.
    const cachedPhoneVerified = AccountIdentityService.hasVerifiedPhone(
      AccountIdentityService.peekCachedIdentity(params.userId)?.data,
    );
    let phoneVerified = params.phoneVerified === true ||
      remoteState.phoneVerified === true || cachedPhoneVerified;
    if (remoteState.hasVault) {
      const setupResolved =
        PreVaultUserStateService.isSetupResolved(remoteState);
      if (remoteState.setupCompleted === false && !setupResolved) {
        if (
          hasExplicitRedirect &&
          (isSetupHubRedirect || fallbackPathname === PRE_VAULT_ROUTE)
        )
          return fallbackRoute;
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
    const invitePathname = inviteRedirectTarget
      ? normalizeStaticExportPathname(
          new URL(inviteRedirectTarget, "https://one.local").pathname,
        )
      : null;
    const invitationNeedsSetup = Boolean(
      invitePathname &&
      (isInvitationPreviewRoute(invitePathname) ||
        invitePathname === ROUTES.CONNECT),
    );
    const resolvedNoVaultRoute = inviteRedirectTarget
      ? invitationNeedsSetup && !setupResolved
        ? buildOneSetupRoute({ returnTo: inviteRedirectTarget })
        : buildProfileVaultRoute(inviteRedirectTarget)
      : setupResolved
        ? NO_VAULT_DEFAULT_ROUTE
        : PRE_VAULT_ROUTE;

    // Brand-new Google accounts may not have an identity shadow yet. Resolve
    // that missing claim through the existing identity refresh before deciding;
    // retrying bootstrap alone would keep returning unknown indefinitely.
    let phoneStatusKnown = remoteState.phoneVerified != null || params.phoneVerified != null;
    if (!phoneStatusKnown && shouldRequirePhoneMandate({
      phoneNumber: params.phoneNumber,
      phoneVerified,
      hasVault: remoteState.hasVault,
      setupResolved,
      hostname: params.hostname ?? (typeof window === "undefined" ? null : window.location.hostname),
    })) {
      const idToken = params.idToken || await AuthService.getIdToken();
      const identity = idToken
        ? await AccountIdentityService.refreshIdentityForSession(params.userId, idToken)
        : null;
      phoneStatusKnown = typeof identity?.phone_verified === "boolean";
      phoneVerified = AccountIdentityService.hasVerifiedPhone(identity);
    }

    if (
      shouldRequirePhoneMandate({
        phoneNumber: params.phoneNumber,
        phoneVerified,
        hasVault: remoteState.hasVault,
        setupResolved,
        hostname:
          params.hostname ??
          (typeof window === "undefined" ? null : window.location.hostname),
      })
    ) {
      if (remoteState.hasVault !== false ||
          !phoneStatusKnown) {
        throw new Error("Unable to verify account onboarding. Please try again.");
      }
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

"use client";

import { PreVaultOnboardingService } from "@/lib/services/pre-vault-onboarding-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { RiaService } from "@/lib/services/ria-service";
import { buildPhoneMandateRoute, ROUTES } from "@/lib/navigation/routes";
import { shouldRequirePhoneMandate } from "@/lib/services/phone-mandate-service";

const PRE_VAULT_ROUTE = ROUTES.KAI_ONBOARDING;
const NO_VAULT_DEFAULT_ROUTE = ROUTES.KAI_HOME;

function normalizeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.trim()) return ROUTES.KAI_HOME;
  if (path === ROUTES.PHONE_MANDATE || path.startsWith(`${ROUTES.PHONE_MANDATE}?`)) {
    return ROUTES.KAI_HOME;
  }
  return path;
}

export class PostAuthRouteService {
  static async resolveAfterLogin(params: {
    userId: string;
    redirectPath?: string;
    idToken?: string;
    phoneNumber?: string | null;
    hostname?: string | null;
  }): Promise<string> {
    const fallbackRoute = normalizeRedirectPath(params.redirectPath);
    const remoteState = await PreVaultUserStateService.bootstrapState(params.userId);
    const canOverrideWithPersona =
      !params.redirectPath ||
      fallbackRoute === ROUTES.KAI_HOME ||
      fallbackRoute === ROUTES.KAI_ONBOARDING;

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
      if (
        remoteState.preOnboardingCompleted === false &&
        !onboardingResolved
      ) {
        return PRE_VAULT_ROUTE;
      }
      if (fallbackRoute === ROUTES.KAI_ONBOARDING && onboardingResolved) {
        return ROUTES.KAI_HOME;
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
      if (remoteUnset && pending?.completed) {
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

    const resolvedNoVaultRoute = onboardingResolved
      ? NO_VAULT_DEFAULT_ROUTE
      : PRE_VAULT_ROUTE;

    if (
      shouldRequirePhoneMandate({
        phoneNumber: params.phoneNumber,
        hasVault: false,
        hostname:
          params.hostname ?? (typeof window === "undefined" ? null : window.location.hostname),
      })
    ) {
      return buildPhoneMandateRoute(resolvedNoVaultRoute);
    }

    return resolvedNoVaultRoute;
  }
}

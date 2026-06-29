import { ROUTES, isOneSetupSurfaceRoute } from "@/lib/navigation/routes";

/**
 * @deprecated The `hushh_setup_required` cookie is a client-only
 * (`document.cookie`) hint that the Next 16 `proxy.ts` CANNOT read — setup
 * gating is owned by the client guards (OneSetupGuard / PostAuthRouteService
 * / VaultLockGuard) reading the authoritative stores, not this cookie. It is
 * written in several places but currently has no reader, so it is effectively
 * dead state. It is retained only because the reset-account and register-phone
 * contract tests assert its presence as a behavioral marker; do not build new
 * gating on it. Prefer the setup registry
 * (`lib/navigation/onboarding-registry.ts`) for any new flow logic. Slated for
 * removal once those contract tests are migrated to assert store state directly.
 */
export const ONBOARDING_REQUIRED_COOKIE = "hushh_setup_required";
/**
 * Live cookie: read by `kai-chrome-state` and `AuthStep` to know a setup flow is
 * mid-progress (e.g. route to the import step after Continue).
 */
export const ONBOARDING_FLOW_ACTIVE_COOKIE = "hushh_setup_flow_active";

const COOKIE_PATH = "path=/";
const COOKIE_SAME_SITE = "SameSite=Lax";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function canUseDocumentCookie(): boolean {
  return typeof document !== "undefined" && typeof document.cookie === "string";
}

export function setOnboardingRequiredCookie(required: boolean): void {
  if (!canUseDocumentCookie()) return;

  if (required) {
    document.cookie = `${ONBOARDING_REQUIRED_COOKIE}=1; ${COOKIE_PATH}; ${COOKIE_SAME_SITE}; max-age=${COOKIE_MAX_AGE_SECONDS}`;
    return;
  }

  document.cookie = `${ONBOARDING_REQUIRED_COOKIE}=0; ${COOKIE_PATH}; ${COOKIE_SAME_SITE}; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

export function isOnboardingRequiredCookieEnabled(): boolean {
  if (!canUseDocumentCookie()) return false;

  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${ONBOARDING_REQUIRED_COOKIE}=1`);
}

export function setOnboardingFlowActiveCookie(active: boolean): void {
  if (!canUseDocumentCookie()) return;

  if (active) {
    document.cookie = `${ONBOARDING_FLOW_ACTIVE_COOKIE}=1; ${COOKIE_PATH}; ${COOKIE_SAME_SITE}; max-age=${COOKIE_MAX_AGE_SECONDS}`;
    return;
  }

  document.cookie = `${ONBOARDING_FLOW_ACTIVE_COOKIE}=0; ${COOKIE_PATH}; ${COOKIE_SAME_SITE}; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}

export function isOnboardingFlowActiveCookieEnabled(): boolean {
  if (!canUseDocumentCookie()) return false;

  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${ONBOARDING_FLOW_ACTIVE_COOKIE}=1`);
}

export function isOnboardingRoute(pathname: string): boolean {
  return isOneSetupSurfaceRoute(pathname);
}

export const ONBOARDING_ROUTES = {
  PREFERRED: ROUTES.ONE_SETUP,
} as const;

export function getOnboardingRoute(): string {
  return ONBOARDING_ROUTES.PREFERRED;
}

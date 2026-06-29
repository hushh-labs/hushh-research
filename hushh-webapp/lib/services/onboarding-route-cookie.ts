import { ROUTES, isKaiOnboardingRoute } from "@/lib/navigation/routes";

export const ONBOARDING_REQUIRED_COOKIE = "kai_onboarding_required";
export const ONBOARDING_FLOW_ACTIVE_COOKIE = "kai_onboarding_flow_active";

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
  return isKaiOnboardingRoute(pathname);
}

export const ONBOARDING_ROUTES = {
  PREFERRED: ROUTES.ONE_ONBOARDING,
} as const;

export function getOnboardingRoute(): string {
  return ONBOARDING_ROUTES.PREFERRED;
}

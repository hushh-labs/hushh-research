import {
  ROUTES,
  isKaiOnboardingRoute,
  isRiaOnboardingRoute,
} from "@/lib/navigation/routes";
import { isOnboardingFlowActiveCookieEnabled } from "@/lib/services/onboarding-route-cookie";

export interface KaiChromeState {
  isOnboardingRoute: boolean;
  isImportRoute: boolean;
  onboardingFlowActive: boolean;
  useOnboardingChrome: boolean;
  hideCommandBar: boolean;
}

function isKaiImportRoute(pathname: string): boolean {
  return pathname === ROUTES.KAI_IMPORT || pathname.startsWith(`${ROUTES.KAI_IMPORT}/`);
}

export function getKaiChromeState(
  pathname: string | null | undefined,
  options?: {
    onboardingFlowActive?: boolean;
  }
): KaiChromeState {
  const path = pathname ?? "";
  const isOnboardingRoute = isKaiOnboardingRoute(path);
  const isImportRoute = isKaiImportRoute(path);
  const onboardingFlowActive =
    options?.onboardingFlowActive ?? isOnboardingFlowActiveCookieEnabled();
  // Import is used by both first-time and returning users.
  // Onboarding chrome should only appear on:
  // 1) explicit onboarding routes, or
  // 2) import routes while onboarding flow is active.
  const useOnboardingChrome = isOnboardingRoute || (isImportRoute && onboardingFlowActive);
  const hideCommandBar =
    useOnboardingChrome ||
    path === ROUTES.HOME ||
    path.startsWith(ROUTES.LOGIN) ||
    path.startsWith(ROUTES.LOGOUT) ||
    path.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    path.startsWith(ROUTES.MARKETPLACE) ||
    isRiaOnboardingRoute(path);

  return {
    isOnboardingRoute,
    isImportRoute,
    onboardingFlowActive,
    useOnboardingChrome,
    hideCommandBar,
  };
}

import {
  ROUTES,
  isOneSetupSurfaceRoute,
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
  return (
    pathname === ROUTES.KAI_IMPORT ||
    pathname.startsWith(`${ROUTES.KAI_IMPORT}/`)
  );
}

export function getKaiChromeState(
  pathname: string | null | undefined,
  options?: {
    onboardingFlowActive?: boolean;
  },
): KaiChromeState {
  const path = pathname ?? "";
  const isOnboardingRoute = isOneSetupSurfaceRoute(path);
  const isImportRoute = isKaiImportRoute(path);
  const onboardingFlowActive =
    options?.onboardingFlowActive ?? isOnboardingFlowActiveCookieEnabled();
  // Import is used by both first-time and returning users.
  // Onboarding chrome should only appear on:
  // 1) explicit onboarding routes, or
  // 2) import routes while onboarding flow is active.
  const useOnboardingChrome =
    isOnboardingRoute || (isImportRoute && onboardingFlowActive);
  // `/` is the authenticated Chat workspace. It has no persistent idle
  // command-bar chrome, but its Search nav action still needs the global
  // command palette mounted so the open event has a receiver.
  const hideCommandBar =
    useOnboardingChrome ||
    path.startsWith(ROUTES.LOGIN) ||
    path.startsWith(ROUTES.PHONE_MANDATE) ||
    path.startsWith(ROUTES.LOGOUT) ||
    isRiaOnboardingRoute(path);

  return {
    isOnboardingRoute,
    isImportRoute,
    onboardingFlowActive,
    useOnboardingChrome,
    hideCommandBar,
  };
}

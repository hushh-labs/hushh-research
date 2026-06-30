import { describe, expect, it } from "vitest";

import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";

describe("getKaiChromeState", () => {
  it("returns expected defaults for a standard kai route", () => {
    const state = getKaiChromeState(ROUTES.KAI_HOME, {
      onboardingFlowActive: false,
    });

    expect(state.isOnboardingRoute).toBe(false);
    expect(state.isImportRoute).toBe(false);
    expect(state.useOnboardingChrome).toBe(false);
    expect(state.hideCommandBar).toBe(false);
    expect(state.hideBottomNav).toBe(false);
  });

  it("enables onboarding chrome for onboarding routes", () => {
    const state = getKaiChromeState(ROUTES.ONE_ONBOARDING, {
      onboardingFlowActive: false,
    });

    expect(state.isOnboardingRoute).toBe(true);
    expect(state.useOnboardingChrome).toBe(true);
    expect(state.hideCommandBar).toBe(true);
  });

  it("marks import routes correctly", () => {
    const state = getKaiChromeState(ROUTES.KAI_IMPORT, {
      onboardingFlowActive: false,
    });

    expect(state.isImportRoute).toBe(true);
  });

  it("enables onboarding chrome on import routes when onboarding flow is active", () => {
    const state = getKaiChromeState(ROUTES.KAI_IMPORT, {
      onboardingFlowActive: true,
    });

    expect(state.useOnboardingChrome).toBe(true);
    expect(state.hideCommandBar).toBe(true);
  });

  it("hides chrome for login routes", () => {
    const state = getKaiChromeState(ROUTES.LOGIN, {
      onboardingFlowActive: false,
    });

    expect(state.hideCommandBar).toBe(true);
    expect(state.hideBottomNav).toBe(true);
  });

  it("hides chrome for ria onboarding routes", () => {
    const state = getKaiChromeState(ROUTES.RIA_ONBOARDING, {
      onboardingFlowActive: false,
    });

    expect(state.hideCommandBar).toBe(true);
  });

  it("keeps hideBottomNav aligned with hideCommandBar", () => {
    const paths = [
      ROUTES.KAI_HOME,
      ROUTES.ONE_ONBOARDING,
      ROUTES.KAI_IMPORT,
      ROUTES.LOGIN,
      ROUTES.RIA_ONBOARDING,
    ];

    for (const path of paths) {
      const state = getKaiChromeState(path, {
        onboardingFlowActive: false,
      });

      expect(state.hideBottomNav).toBe(state.hideCommandBar);
    }
  });

  it("propagates onboardingFlowActive into returned state", () => {
    const state = getKaiChromeState(ROUTES.KAI_HOME, {
      onboardingFlowActive: true,
    });

    expect(state.onboardingFlowActive).toBe(true);
  });
});
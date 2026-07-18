import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "@/lib/navigation/routes";
import {
  ONBOARDING_FLOW_ACTIVE_COOKIE,
  ONBOARDING_REQUIRED_COOKIE,
  ONBOARDING_ROUTES,
  getOnboardingRoute,
  isOnboardingFlowActiveCookieEnabled,
  isOnboardingRequiredCookieEnabled,
  isOnboardingRoute,
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";

function resetCookies() {
  setOnboardingRequiredCookie(false);
  setOnboardingFlowActiveCookie(false);
}

describe("onboarding-route-cookie constants", () => {
  it("exports stable cookie names", () => {
    expect(ONBOARDING_REQUIRED_COOKIE).toBe("kai_onboarding_required");
    expect(ONBOARDING_FLOW_ACTIVE_COOKIE).toBe(
      "kai_onboarding_flow_active",
    );
  });
});

describe("required cookie contract", () => {
  beforeEach(resetCookies);
  afterEach(resetCookies);

  it("toggles required cookie state", () => {
    expect(isOnboardingRequiredCookieEnabled()).toBe(false);

    setOnboardingRequiredCookie(true);
    expect(isOnboardingRequiredCookieEnabled()).toBe(true);

    setOnboardingRequiredCookie(false);
    expect(isOnboardingRequiredCookieEnabled()).toBe(false);
  });
});

describe("flow active cookie contract", () => {
  beforeEach(resetCookies);
  afterEach(resetCookies);

  it("toggles flow-active cookie state", () => {
    expect(isOnboardingFlowActiveCookieEnabled()).toBe(false);

    setOnboardingFlowActiveCookie(true);
    expect(isOnboardingFlowActiveCookieEnabled()).toBe(true);

    setOnboardingFlowActiveCookie(false);
    expect(isOnboardingFlowActiveCookieEnabled()).toBe(false);
  });
});

describe("independent cookie state", () => {
  beforeEach(resetCookies);
  afterEach(resetCookies);

  it("allows both cookies simultaneously", () => {
    setOnboardingRequiredCookie(true);
    setOnboardingFlowActiveCookie(true);

    expect(isOnboardingRequiredCookieEnabled()).toBe(true);
    expect(isOnboardingFlowActiveCookieEnabled()).toBe(true);
  });
});

describe("isOnboardingRoute", () => {
  it("recognizes canonical onboarding routes", () => {
    expect(isOnboardingRoute(ROUTES.ONE_ONBOARDING)).toBe(true);

    expect(
      isOnboardingRoute(`${ROUTES.ONE_ONBOARDING}/step-2`),
    ).toBe(true);

    expect(
      isOnboardingRoute(ROUTES.LEGACY_KAI_ONBOARDING),
    ).toBe(true);
  });

  it("rejects unrelated routes", () => {
    expect(isOnboardingRoute(ROUTES.PROFILE)).toBe(false);
  });
});

describe("route resolution contract", () => {
  it("uses ONE_ONBOARDING as the preferred route", () => {
    expect(ONBOARDING_ROUTES.PREFERRED).toBe(
      ROUTES.ONE_ONBOARDING,
    );

    expect(getOnboardingRoute()).toBe(
      ROUTES.ONE_ONBOARDING,
    );
  });
});
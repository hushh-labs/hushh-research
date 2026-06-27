import { describe, it, expect } from "vitest";
import {
  ONBOARDING_REQUIRED_COOKIE,
  ONBOARDING_FLOW_ACTIVE_COOKIE,
  ONBOARDING_ROUTES,
  getOnboardingRoute,
} from "@/lib/services/onboarding-route-cookie";
import { ROUTES } from "@/lib/navigation/routes";

describe("onboarding route cookie constants — exact value contract", () => {
  it("exposes the onboarding-required cookie name", () => {
    expect(ONBOARDING_REQUIRED_COOKIE).toBe("kai_onboarding_required");
  });

  it("exposes the onboarding-flow-active cookie name", () => {
    expect(ONBOARDING_FLOW_ACTIVE_COOKIE).toBe("kai_onboarding_flow_active");
  });

  it("the two cookie names are distinct", () => {
    expect(ONBOARDING_REQUIRED_COOKIE).not.toBe(ONBOARDING_FLOW_ACTIVE_COOKIE);
  });
});

describe("ONBOARDING_ROUTES — preferred route contract", () => {
  it("sets PREFERRED to ROUTES.ONE_ONBOARDING", () => {
    expect(ONBOARDING_ROUTES.PREFERRED).toBe(ROUTES.ONE_ONBOARDING);
  });

  it("PREFERRED resolves to the literal onboarding path", () => {
    expect(ONBOARDING_ROUTES.PREFERRED).toBe("/one/onboarding");
  });
});

describe("getOnboardingRoute — return value contract", () => {
  it("returns ONBOARDING_ROUTES.PREFERRED", () => {
    expect(getOnboardingRoute()).toBe(ONBOARDING_ROUTES.PREFERRED);
  });

  it("returns the literal onboarding path", () => {
    expect(getOnboardingRoute()).toBe("/one/onboarding");
  });

  it("returns the same value on repeated calls", () => {
    expect(getOnboardingRoute()).toBe(getOnboardingRoute());
  });
});
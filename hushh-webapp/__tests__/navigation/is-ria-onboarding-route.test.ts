import { describe, it, expect } from "vitest";
import { isRiaOnboardingRoute, ROUTES } from "@/lib/navigation/routes";

describe("isRiaOnboardingRoute — classification boundary contract", () => {
  it("returns true for the exact ria onboarding path", () => {
    expect(isRiaOnboardingRoute(ROUTES.RIA_ONBOARDING)).toBe(true);
  });

  it("returns true for a nested path under the ria onboarding route", () => {
    expect(isRiaOnboardingRoute("/ria/onboarding/step1")).toBe(true);
  });

  it("returns true for a deeply nested path", () => {
    expect(isRiaOnboardingRoute("/ria/onboarding/step1/details")).toBe(true);
  });

  it("returns false for a path that shares the prefix without a slash boundary", () => {
    expect(isRiaOnboardingRoute("/ria/onboardingextra")).toBe(false);
  });

  it("returns false for the parent ria route", () => {
    expect(isRiaOnboardingRoute(ROUTES.RIA_HOME)).toBe(false);
  });

  it("returns false for an unrelated route", () => {
    expect(isRiaOnboardingRoute("/one/onboarding")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isRiaOnboardingRoute("")).toBe(false);
  });
});
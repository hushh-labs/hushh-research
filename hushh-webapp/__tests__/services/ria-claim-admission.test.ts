import { describe, expect, it } from "vitest";

import {
  isCapabilityOnboardingRoute,
  isOnboardingAdmissionExemptRoute,
  ROUTES,
} from "@/lib/navigation/routes";

/**
 * The claim screen is reached by REDIRECT from three places (the phone mandate,
 * RIA setup, and the setup hub). An app-wide journey guard bounces any route it
 * does not admit back to /one/setup, which silently reverts every one of those
 * redirects and leaves the adviser staring at the setup hub. These assertions
 * exist so that regression cannot return unnoticed.
 */
describe("the journey guard must admit the claim screen", () => {
  it("admits /ria/claim while the ria capability is being set up", () => {
    // Redirected here from /one/setup/ria after recognising the adviser.
    expect(isCapabilityOnboardingRoute("ria", ROUTES.RIA_CLAIM)).toBe(true);
  });

  it("still admits the RIA setup surface itself", () => {
    expect(isCapabilityOnboardingRoute("ria", ROUTES.ONE_SETUP_RIA)).toBe(true);
  });

  it("admits /ria/claim before any capability is active", () => {
    // Redirected here straight from the phone mandate, where onboarding has no
    // active capability yet, so capability admission cannot be what saves it.
    expect(isOnboardingAdmissionExemptRoute(ROUTES.RIA_CLAIM)).toBe(true);
  });

  it("does not widen admission to the rest of the RIA workspace", () => {
    // Only the claim screen is reachable mid-setup; clients/picks/profile must
    // still be gated behind completed onboarding.
    expect(isOnboardingAdmissionExemptRoute(ROUTES.RIA_CLIENTS)).toBe(false);
    expect(isOnboardingAdmissionExemptRoute(ROUTES.RIA_PICKS)).toBe(false);
    expect(isCapabilityOnboardingRoute("ria", ROUTES.RIA_CLIENTS)).toBe(false);
  });

  it("does not admit the claim screen under an unrelated capability", () => {
    expect(isCapabilityOnboardingRoute("finance", ROUTES.RIA_CLAIM)).toBe(false);
    expect(isCapabilityOnboardingRoute("location", ROUTES.RIA_CLAIM)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildOneSetupCapabilityFinishRoute,
  isCapabilityOnboardingRoute,
  isOnboardingAdmissionExemptRoute,
  resolveOnboardingCapabilityForRoute,
} from "@/lib/navigation/routes";

describe("onboarding route admission", () => {
  it("keeps every capability inside its own bounded route family", () => {
    expect(isCapabilityOnboardingRoute("finance", "/one/kai/import")).toBe(
      true,
    );
    expect(
      isCapabilityOnboardingRoute("finance", "/one/kai/plaid/oauth/return"),
    ).toBe(true);
    expect(
      isCapabilityOnboardingRoute("gmail", "/profile/gmail/oauth/return"),
    ).toBe(true);
    expect(isCapabilityOnboardingRoute("gmail", "/one/kai/import")).toBe(false);
    expect(isCapabilityOnboardingRoute("finance", "/profile")).toBe(false);
  });

  it("maps physical capability routes back to the correct terminal step", () => {
    expect(resolveOnboardingCapabilityForRoute("/one/gmail")).toBe("gmail");
    expect(resolveOnboardingCapabilityForRoute("/one/kyc")).toBe("email");
    expect(resolveOnboardingCapabilityForRoute("/ria/onboarding")).toBe("ria");
    expect(resolveOnboardingCapabilityForRoute("/consents")).toBeNull();
    expect(buildOneSetupCapabilityFinishRoute("finance")).toBe(
      "/one/setup/finance?finish=1",
    );
  });

  it("does not exempt signed-in internal surfaces from unfinished setup", () => {
    expect(isOnboardingAdmissionExemptRoute("/")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/login")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/profile")).toBe(false);
    expect(isOnboardingAdmissionExemptRoute("/marketplace")).toBe(false);
    expect(isOnboardingAdmissionExemptRoute("/ria")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildOneSetupCapabilityFinishRoute,
  isCapabilityOnboardingRoute,
  isOnboardingAdmissionExemptRoute,
  resolveOnboardingCapabilityForRoute,
} from "@/lib/navigation/routes";

describe("onboarding route admission", () => {
  it("keeps every capability inside its own bounded route family", () => {
    expect(isCapabilityOnboardingRoute("finance", "/one/setup/finance/import")).toBe(
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
    expect(resolveOnboardingCapabilityForRoute("/one/setup/gmail")).toBe("gmail");
    expect(resolveOnboardingCapabilityForRoute("/one/setup/email")).toBe("email");
    expect(resolveOnboardingCapabilityForRoute("/one/setup/ria")).toBe("ria");
    expect(resolveOnboardingCapabilityForRoute("/consents")).toBeNull();
    expect(buildOneSetupCapabilityFinishRoute("finance")).toBe(
      "/one/setup/finance",
    );
  });

  it("does not exempt signed-in internal surfaces from unfinished setup", () => {
    expect(isOnboardingAdmissionExemptRoute("/")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/login")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/profile")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/profile/security")).toBe(true);
    expect(isOnboardingAdmissionExemptRoute("/marketplace")).toBe(false);
    expect(isOnboardingAdmissionExemptRoute("/ria")).toBe(false);
  });
});

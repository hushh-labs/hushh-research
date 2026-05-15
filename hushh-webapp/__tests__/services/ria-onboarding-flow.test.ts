import { describe, expect, it } from "vitest";

import {
  buildRiaOnboardingSteps,
  canContinueRiaOnboardingStep,
  createEmptyRiaOnboardingDraft,
  findFirstIncompleteRiaOnboardingStepId,
  normalizeRiaOnboardingDraft,
  resolveRiaOnboardingStepId,
} from "@/lib/ria/ria-onboarding-flow";

describe("ria-onboarding-flow", () => {
  it("builds 6-step license-first flow", () => {
    const draft = createEmptyRiaOnboardingDraft();
    expect(buildRiaOnboardingSteps(draft).map((step) => step.id)).toEqual([
      "welcome",
      "license_number",
      "license_details",
      "services",
      "contact_location",
      "review",
    ]);
  });

  it("falls back to advisory-only defaults for invalid capability payloads", () => {
    const draft = normalizeRiaOnboardingDraft({
      requestedCapabilities: ["invalid" as never],
    });

    expect(draft.requestedCapabilities).toEqual(["advisory"]);
  });

  it("validates license-first trust-critical steps", () => {
    const draft = {
      ...createEmptyRiaOnboardingDraft(),
      onboardingType: "individual" as const,
      licenseNumber: "123456",
      licenseVerificationStatus: "found" as const,
      advisorName: "Manish Sainani",
      servicesOffered: ["Portfolio Management"],
      feeStructure: ["Fee-only"],
      contactEmail: "manish@example.com",
    };

    expect(canContinueRiaOnboardingStep("welcome", draft)).toBe(true);
    expect(
      canContinueRiaOnboardingStep("license_number", draft, {
        licenseVerificationSatisfied: true,
      })
    ).toBe(true);
    expect(canContinueRiaOnboardingStep("license_details", draft)).toBe(true);
    expect(canContinueRiaOnboardingStep("services", draft)).toBe(true);
    expect(canContinueRiaOnboardingStep("contact_location", draft)).toBe(true);
    expect(canContinueRiaOnboardingStep("review", draft)).toBe(true);
  });

  it("finds the first incomplete step for seeded onboarding", () => {
    const draft = normalizeRiaOnboardingDraft({
      onboardingType: "individual",
      licenseNumber: "123456",
      licenseVerificationStatus: "found",
      advisorName: "Manish Sainani",
    });

    expect(
      findFirstIncompleteRiaOnboardingStepId(draft, {
        licenseVerificationSatisfied: true,
      })
    ).toBe("services");
  });

  it("falls back to first step when preferred step is invalid", () => {
    const draft = normalizeRiaOnboardingDraft({
      requestedCapabilities: ["advisory"],
    });

    expect(resolveRiaOnboardingStepId(draft, "broker_firm" as any)).toBe("welcome");
  });

  it("blocks license step until explicit verification succeeds", () => {
    const draft = normalizeRiaOnboardingDraft({
      licenseNumber: "123456",
    });

    expect(canContinueRiaOnboardingStep("license_number", draft)).toBe(false);
    expect(
      canContinueRiaOnboardingStep("license_number", draft, {
        licenseVerificationSatisfied: true,
      })
    ).toBe(true);
  });
});

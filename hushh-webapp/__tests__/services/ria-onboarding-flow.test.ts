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
  it("builds dynamic firm steps from requested capabilities", () => {
    const draft = normalizeRiaOnboardingDraft({
      requestedCapabilities: ["advisory", "brokerage"],
    });

    expect(buildRiaOnboardingSteps(draft).map((step) => step.id)).toEqual([
      "capabilities",
      "display_name",
      "broker_firm",
      "public_profile",
      "review",
    ]);
  });

  it("falls back to advisory-only defaults for invalid capability payloads", () => {
    const draft = normalizeRiaOnboardingDraft({
      requestedCapabilities: ["invalid" as never],
    });

    expect(draft.requestedCapabilities).toEqual(["advisory"]);
  });

  it("validates trust-critical steps only", () => {
    const draft = {
      ...createEmptyRiaOnboardingDraft(),
      displayName: "Manish Sainani",
      individualLegalName: "Manish Sainani",
      individualCrd: "12345",
      advisoryFirmName: "Hushh Advisory",
      advisoryFirmIapdNumber: "9012",
      headline: "Global macro wealth planning",
    };

    expect(canContinueRiaOnboardingStep("capabilities", draft)).toBe(true);
    expect(
      canContinueRiaOnboardingStep("display_name", draft, {
        nameVerificationSatisfied: true,
      })
    ).toBe(true);
    expect(canContinueRiaOnboardingStep("legal_identity", draft)).toBe(true);
    expect(canContinueRiaOnboardingStep("advisory_firm", draft)).toBe(true);
    expect(canContinueRiaOnboardingStep("public_profile", draft)).toBe(true);
  });

  it("finds the first incomplete step for seeded onboarding", () => {
    const draft = normalizeRiaOnboardingDraft({
      displayName: "Manish Sainani",
      individualLegalName: "Manish Sainani",
      individualCrd: "12345",
    });

    expect(
      findFirstIncompleteRiaOnboardingStepId(draft, {
        nameVerificationSatisfied: true,
      })
    ).toBe("public_profile");
  });

  it("clamps removed steps when capabilities change", () => {
    const draft = normalizeRiaOnboardingDraft({
      requestedCapabilities: ["advisory"],
    });

    expect(resolveRiaOnboardingStepId(draft, "broker_firm")).toBe("capabilities");
  });

  it("blocks the default display-name step until explicit verification succeeds", () => {
    const draft = normalizeRiaOnboardingDraft({
      displayName: "Ana Roumenova Carter",
    });

    expect(canContinueRiaOnboardingStep("display_name", draft)).toBe(false);
    expect(
      canContinueRiaOnboardingStep("display_name", draft, {
        nameVerificationSatisfied: true,
      })
    ).toBe(true);
  });
});

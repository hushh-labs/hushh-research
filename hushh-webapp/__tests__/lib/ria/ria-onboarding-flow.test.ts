import { describe, expect, it } from "vitest";

import {
  buildRiaOnboardingSteps,
  canContinueRiaOnboardingStep,
  createEmptyRiaOnboardingDraft,
  findFirstIncompleteRiaOnboardingStepId,
  getOnboardingTypeLabel,
  getRiaOnboardingStepIndex,
  isRiaOnboardingStepId,
  normalizeRiaCapabilities,
  normalizeRiaOnboardingDraft,
  resolveRiaOnboardingStepId,
  type RiaOnboardingDraft,
} from "@/lib/ria/ria-onboarding-flow";

describe("ria-onboarding-flow", () => {
  describe("buildRiaOnboardingSteps", () => {
    it("returns exactly 6 steps in order", () => {
      const draft = createEmptyRiaOnboardingDraft();
      const steps = buildRiaOnboardingSteps(draft);
      expect(steps).toHaveLength(6);
      expect(steps.map((s) => s.id)).toEqual([
        "welcome",
        "license_number",
        "license_details",
        "services",
        "contact_location",
        "review",
      ]);
    });

    it("each step has eyebrow, title, and description", () => {
      const draft = createEmptyRiaOnboardingDraft();
      const steps = buildRiaOnboardingSteps(draft);
      for (const step of steps) {
        expect(step.eyebrow).toBeTruthy();
        expect(step.title).toBeTruthy();
        expect(step.description).toBeTruthy();
      }
    });
  });

  describe("canContinueRiaOnboardingStep", () => {
    it("welcome: requires onboardingType set", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(canContinueRiaOnboardingStep("welcome", draft)).toBe(true);
      expect(
        canContinueRiaOnboardingStep("welcome", { ...draft, onboardingType: "" as any })
      ).toBe(false);
    });

    it("license_number: blocks without verification", () => {
      const draft: RiaOnboardingDraft = {
        ...createEmptyRiaOnboardingDraft(),
        licenseNumber: "12345",
        licenseVerificationStatus: "found",
      };
      expect(canContinueRiaOnboardingStep("license_number", draft)).toBe(false);
      expect(
        canContinueRiaOnboardingStep("license_number", draft, {
          licenseVerificationSatisfied: true,
        })
      ).toBe(true);
    });

    it("license_number: blocks with empty license number even when verified", () => {
      const draft: RiaOnboardingDraft = {
        ...createEmptyRiaOnboardingDraft(),
        licenseNumber: "  ",
        licenseVerificationStatus: "found",
      };
      expect(
        canContinueRiaOnboardingStep("license_number", draft, {
          licenseVerificationSatisfied: true,
        })
      ).toBe(false);
    });

    it("license_details: requires advisorName", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(canContinueRiaOnboardingStep("license_details", draft)).toBe(false);
      expect(
        canContinueRiaOnboardingStep("license_details", {
          ...draft,
          advisorName: "Jane Doe",
        })
      ).toBe(true);
    });

    it("services: requires both servicesOffered and feeStructure", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(canContinueRiaOnboardingStep("services", draft)).toBe(false);

      const withServices = { ...draft, servicesOffered: ["Portfolio Management"] };
      expect(canContinueRiaOnboardingStep("services", withServices)).toBe(false);

      const withFees = { ...draft, feeStructure: ["Fee-only"] };
      expect(canContinueRiaOnboardingStep("services", withFees)).toBe(false);

      const withBoth = {
        ...draft,
        servicesOffered: ["Portfolio Management"],
        feeStructure: ["Fee-only"],
      };
      expect(canContinueRiaOnboardingStep("services", withBoth)).toBe(true);
    });

    it("contact_location: requires email or phone", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(canContinueRiaOnboardingStep("contact_location", draft)).toBe(false);

      expect(
        canContinueRiaOnboardingStep("contact_location", {
          ...draft,
          contactEmail: "a@b.com",
        })
      ).toBe(true);

      expect(
        canContinueRiaOnboardingStep("contact_location", {
          ...draft,
          contactPhone: "+1234567890",
        })
      ).toBe(true);
    });

    it("review: always allows continue", () => {
      expect(
        canContinueRiaOnboardingStep("review", createEmptyRiaOnboardingDraft())
      ).toBe(true);
    });
  });

  describe("createEmptyRiaOnboardingDraft", () => {
    it("has correct defaults for all fields", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(draft.currentStepId).toBe("welcome");
      expect(draft.onboardingType).toBe("individual");
      expect(draft.licenseNumber).toBe("");
      expect(draft.licenseVerificationStatus).toBe("idle");
      expect(draft.scrapeJobId).toBeNull();
      expect(draft.requestedCapabilities).toEqual(["advisory"]);
      expect(draft.certifications).toEqual([]);
      expect(draft.servicesOffered).toEqual([]);
      expect(draft.feeStructure).toEqual([]);
      expect(draft.latitude).toBeNull();
      expect(draft.longitude).toBeNull();
      expect(draft.displayName).toBe("");
      expect(draft.headline).toBe("");
      expect(draft.strategySummary).toBe("");
    });
  });

  describe("normalizeRiaOnboardingDraft", () => {
    it("handles null/undefined input", () => {
      expect(normalizeRiaOnboardingDraft(null)).toEqual(createEmptyRiaOnboardingDraft());
      expect(normalizeRiaOnboardingDraft(undefined)).toEqual(
        createEmptyRiaOnboardingDraft()
      );
    });

    it("preserves valid fields", () => {
      const partial: Partial<RiaOnboardingDraft> = {
        currentStepId: "services",
        onboardingType: "firm",
        licenseNumber: "999888",
        advisorName: "John Doe",
        firmName: "Acme Wealth",
        servicesOffered: ["Tax Planning"],
        feeStructure: ["AUM %"],
        contactEmail: "john@acme.com",
      };
      const normalized = normalizeRiaOnboardingDraft(partial);
      expect(normalized.currentStepId).toBe("services");
      expect(normalized.onboardingType).toBe("firm");
      expect(normalized.licenseNumber).toBe("999888");
      expect(normalized.advisorName).toBe("John Doe");
      expect(normalized.firmName).toBe("Acme Wealth");
      expect(normalized.servicesOffered).toEqual(["Tax Planning"]);
      expect(normalized.feeStructure).toEqual(["AUM %"]);
      expect(normalized.contactEmail).toBe("john@acme.com");
    });

    it("rejects invalid stepId", () => {
      const result = normalizeRiaOnboardingDraft({
        currentStepId: "bogus_step" as any,
      });
      expect(result.currentStepId).toBe("welcome");
    });

    it("rejects invalid onboardingType", () => {
      const result = normalizeRiaOnboardingDraft({
        onboardingType: "corporate" as any,
      });
      expect(result.onboardingType).toBe("individual");
    });

    it("rejects invalid licenseVerificationStatus", () => {
      const result = normalizeRiaOnboardingDraft({
        licenseVerificationStatus: "magic" as any,
      });
      expect(result.licenseVerificationStatus).toBe("idle");
    });

    it("sanitizes non-string text fields to empty string", () => {
      const result = normalizeRiaOnboardingDraft({
        licenseNumber: 12345 as any,
        advisorName: null as any,
        firmName: undefined as any,
      });
      expect(result.licenseNumber).toBe("");
      expect(result.advisorName).toBe("");
      expect(result.firmName).toBe("");
    });

    it("sanitizes non-array certifications to empty array", () => {
      const result = normalizeRiaOnboardingDraft({
        certifications: "Series 65" as any,
      });
      expect(result.certifications).toEqual([]);
    });

    it("preserves valid latitude/longitude", () => {
      const result = normalizeRiaOnboardingDraft({
        latitude: 37.7749,
        longitude: -122.4194,
      });
      expect(result.latitude).toBe(37.7749);
      expect(result.longitude).toBe(-122.4194);
    });

    it("rejects non-number coordinates", () => {
      const result = normalizeRiaOnboardingDraft({
        latitude: "37.7749" as any,
        longitude: null,
      });
      expect(result.latitude).toBeNull();
      expect(result.longitude).toBeNull();
    });

    it("defaults requestedCapabilities to advisory when empty", () => {
      const result = normalizeRiaOnboardingDraft({
        requestedCapabilities: [],
      });
      expect(result.requestedCapabilities).toEqual(["advisory"]);
    });

    it("preserves valid requestedCapabilities", () => {
      const result = normalizeRiaOnboardingDraft({
        requestedCapabilities: ["advisory", "brokerage"],
      });
      expect(result.requestedCapabilities).toEqual(["advisory", "brokerage"]);
    });
  });

  describe("normalizeRiaCapabilities", () => {
    it("filters invalid entries", () => {
      expect(normalizeRiaCapabilities(["advisory", "bogus", "brokerage"])).toEqual([
        "advisory",
        "brokerage",
      ]);
    });

    it("deduplicates", () => {
      expect(
        normalizeRiaCapabilities(["advisory", "advisory", "brokerage"])
      ).toEqual(["advisory", "brokerage"]);
    });

    it("returns empty for non-array input", () => {
      expect(normalizeRiaCapabilities(null)).toEqual([]);
      expect(normalizeRiaCapabilities("advisory")).toEqual([]);
    });
  });

  describe("isRiaOnboardingStepId", () => {
    it("accepts valid step IDs", () => {
      expect(isRiaOnboardingStepId("welcome")).toBe(true);
      expect(isRiaOnboardingStepId("license_number")).toBe(true);
      expect(isRiaOnboardingStepId("license_details")).toBe(true);
      expect(isRiaOnboardingStepId("services")).toBe(true);
      expect(isRiaOnboardingStepId("contact_location")).toBe(true);
      expect(isRiaOnboardingStepId("review")).toBe(true);
    });

    it("rejects invalid values", () => {
      expect(isRiaOnboardingStepId("intro")).toBe(false);
      expect(isRiaOnboardingStepId("")).toBe(false);
      expect(isRiaOnboardingStepId(null)).toBe(false);
      expect(isRiaOnboardingStepId(42)).toBe(false);
    });
  });

  describe("findFirstIncompleteRiaOnboardingStepId", () => {
    it("returns welcome for empty draft", () => {
      const draft = createEmptyRiaOnboardingDraft();
      draft.onboardingType = "" as any;
      expect(findFirstIncompleteRiaOnboardingStepId(draft)).toBe("welcome");
    });

    it("returns license_number when welcome is complete", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(findFirstIncompleteRiaOnboardingStepId(draft)).toBe("license_number");
    });

    it("returns review when all steps are complete", () => {
      const draft: RiaOnboardingDraft = {
        ...createEmptyRiaOnboardingDraft(),
        onboardingType: "individual",
        licenseNumber: "123456",
        licenseVerificationStatus: "found",
        advisorName: "Jane Doe",
        servicesOffered: ["Portfolio Management"],
        feeStructure: ["Fee-only"],
        contactEmail: "jane@example.com",
      };
      expect(
        findFirstIncompleteRiaOnboardingStepId(draft, {
          licenseVerificationSatisfied: true,
        })
      ).toBe("review");
    });
  });

  describe("resolveRiaOnboardingStepId", () => {
    it("returns preferred step if valid", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(resolveRiaOnboardingStepId(draft, "services")).toBe("services");
    });

    it("falls back to first step if preferred is invalid", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(resolveRiaOnboardingStepId(draft, "bogus" as any)).toBe("welcome");
    });

    it("returns first incomplete when no preference", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(resolveRiaOnboardingStepId(draft)).toBe("license_number");
    });
  });

  describe("getRiaOnboardingStepIndex", () => {
    it("returns correct index for each step", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(getRiaOnboardingStepIndex(draft, "welcome")).toBe(0);
      expect(getRiaOnboardingStepIndex(draft, "license_number")).toBe(1);
      expect(getRiaOnboardingStepIndex(draft, "license_details")).toBe(2);
      expect(getRiaOnboardingStepIndex(draft, "services")).toBe(3);
      expect(getRiaOnboardingStepIndex(draft, "contact_location")).toBe(4);
      expect(getRiaOnboardingStepIndex(draft, "review")).toBe(5);
    });

    it("returns 0 for unknown step", () => {
      const draft = createEmptyRiaOnboardingDraft();
      expect(getRiaOnboardingStepIndex(draft, "bogus" as any)).toBe(0);
    });
  });

  describe("getOnboardingTypeLabel", () => {
    it("returns correct labels", () => {
      expect(getOnboardingTypeLabel("individual")).toBe("Individual RIA");
      expect(getOnboardingTypeLabel("firm")).toBe("Firm / Practice");
    });
  });
});

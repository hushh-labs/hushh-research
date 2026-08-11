import { describe, expect, it } from "vitest";

import {
  isRiaAdvisoryAccessReady,
  mapRiaStatusToReviewProps,
  seedRiaDraftFromStatus,
} from "@/lib/ria/ria-profile-view-model";
import type { RiaOnboardingStatus } from "@/lib/services/ria-service";

function baseStatus(
  overrides: Partial<RiaOnboardingStatus> = {},
): RiaOnboardingStatus {
  return {
    exists: true,
    verification_status: "verified",
    advisory_status: "verified",
    display_name: "Jane Advisor",
    advisory_firm_legal_name: "Doe Advisory LLC",
    individual_crd: "1234567",
    regulator: "SEC",
    regulator_status: "Investment Adviser Representative",
    certifications: ["CFP", "Series 65"],
    onboarding_type: "individual",
    services_offered: ["Portfolio Management", "Tax Planning"],
    fee_structure: ["AUM %"],
    min_engagement_amount: 250000,
    business_city: "Phoenix",
    business_area: "AZ",
    business_address: "4050 E. Cotton Center Blvd.",
    business_pin_zip: "85040",
    bio: "Fiduciary advisor focused on retirement.",
    contact_email: "jane@doe-advisory.com",
    contact_phone: "+1 555 111 2222",
    ...overrides,
  };
}

describe("ria-profile-view-model", () => {
  it("maps server status to OnboardingStepReview props", () => {
    const props = mapRiaStatusToReviewProps(baseStatus());
    expect(props.advisorName).toBe("Jane Advisor");
    expect(props.firmName).toBe("Doe Advisory LLC");
    expect(props.crdNumber).toBe("1234567");
    expect(props.regulator).toBe("SEC");
    expect(props.servicesOffered).toEqual([
      "Portfolio Management",
      "Tax Planning",
    ]);
    expect(props.feeStructure).toEqual(["AUM %"]);
    // number -> string for the review row.
    expect(props.minEngagementAmount).toBe("250000");
    expect(props.city).toBe("Phoenix");
    expect(props.pinZip).toBe("85040");
    expect(props.bio).toBe("Fiduciary advisor focused on retirement.");
    expect(props.advisoryAccessReady).toBe(true);
  });

  it("falls back across name/crd fields and tolerates missing data", () => {
    const props = mapRiaStatusToReviewProps({
      exists: true,
      verification_status: "submitted",
      individual_legal_name: "Legal Name",
      finra_crd: "9999999",
    });
    expect(props.advisorName).toBe("Legal Name");
    expect(props.crdNumber).toBe("9999999");
    expect(props.servicesOffered).toEqual([]);
    expect(props.feeStructure).toEqual([]);
    expect(props.minEngagementAmount).toBe("");
    expect(props.advisoryAccessReady).toBe(false);
  });

  it("handles a null status", () => {
    const props = mapRiaStatusToReviewProps(null);
    expect(props.advisorName).toBe("");
    expect(props.servicesOffered).toEqual([]);
    expect(props.advisoryAccessReady).toBe(false);
  });

  it("treats active/verified as advisory access ready", () => {
    expect(isRiaAdvisoryAccessReady(baseStatus({ advisory_status: "active" }))).toBe(
      true,
    );
    expect(
      isRiaAdvisoryAccessReady(baseStatus({ advisory_status: "submitted" })),
    ).toBe(false);
  });

  it("seeds an editable draft from status for the edit form", () => {
    const draft = seedRiaDraftFromStatus(baseStatus());
    expect(draft.servicesOffered).toEqual([
      "Portfolio Management",
      "Tax Planning",
    ]);
    expect(draft.feeStructure).toEqual(["AUM %"]);
    expect(draft.minEngagementAmount).toBe("250000");
    expect(draft.bio).toBe("Fiduciary advisor focused on retirement.");
    expect(draft.city).toBe("Phoenix");
    expect(draft.fullStreetAddress).toBe("4050 E. Cotton Center Blvd.");
    expect(draft.contactEmail).toBe("jane@doe-advisory.com");
    expect(draft.contactPhone).toBe("+1 555 111 2222");
    expect(draft.onboardingType).toBe("individual");
    // Verified advisor is seeded as licence-found so the draft is coherent.
    expect(draft.licenseVerificationStatus).toBe("found");
  });

  it("seeds stored coordinates so saving the profile cannot wipe them", () => {
    const draft = seedRiaDraftFromStatus(
      baseStatus({ business_latitude: 33.4084, business_longitude: -111.9797 }),
    );
    expect(draft.latitude).toBe(33.4084);
    expect(draft.longitude).toBe(-111.9797);

    // Mirrors the payload ria-profile-section builds in handleSaveProfile:
    // before the seeding fix these resolved to undefined on every save, which
    // erased the adviser's geocoded office.
    const savePayload = {
      business_latitude: draft.latitude ?? undefined,
      business_longitude: draft.longitude ?? undefined,
    };
    expect(savePayload.business_latitude).toBe(33.4084);
    expect(savePayload.business_longitude).toBe(-111.9797);
  });

  it("leaves coordinates null when the record has none", () => {
    const draft = seedRiaDraftFromStatus(baseStatus());
    expect(draft.latitude).toBeNull();
    expect(draft.longitude).toBeNull();
  });
});

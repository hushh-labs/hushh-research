import { describe, expect, it } from "vitest";

import {
  buildRiaLicensePrefillPatch,
  buildRiaScrapePrefillPatch,
} from "@/lib/ria/ria-onboarding-prefill";
import { createEmptyRiaOnboardingDraft } from "@/lib/ria/ria-onboarding-flow";
import type {
  CrdScrapeJobResult,
  RiaLicenseVerificationResult,
} from "@/lib/services/ria-service";

describe("ria-onboarding-prefill", () => {
  it("prepopulates license facts, certifications, services, and bio from broker intelligence", () => {
    const draft = createEmptyRiaOnboardingDraft();
    const result: RiaLicenseVerificationResult = {
      status: "found",
      advisor_name: "Andrew Garrett Kirkland",
      firm_name: "Eissman Wealth Management",
      regulator: "SEC",
      regulator_status: "Investment Adviser Representative",
      crd_number: "7413463",
      provider: "ria_intelligence_combined",
      exams_passed: [
        "Securities Industry Essentials Examination (SIE)",
        "General Securities Representative Examination (Series 7TO)",
        "Uniform Combined State Law Examination (Series 66)",
      ],
      broker_intelligence_summary:
        "Andrew Garrett Kirkland provides brokerage and advisory services at Eissman Wealth Management.",
    };

    const patch = buildRiaLicensePrefillPatch(draft, result, "7413463");

    expect(patch.advisorName).toBe("Andrew Garrett Kirkland");
    expect(patch.firmName).toBe("Eissman Wealth Management");
    expect(patch.certifications).toEqual(["SIE", "Series 7TO", "Series 66"]);
    expect(patch.servicesOffered).toEqual(["Portfolio Management"]);
    expect(patch.bio).toBe(
      "Andrew Garrett Kirkland provides brokerage and advisory services at Eissman Wealth Management."
    );
    expect(patch.individualCrd).toBe("7413463");
  });

  it("prepopulates official scrape location, exams, fees, minimums, and bio fallback", () => {
    const draft = {
      ...createEmptyRiaOnboardingDraft(),
      advisorName: "Andrew Garrett Kirkland",
      firmName: "Financial Advocates Advisory Services",
      regulatorStatus: "Active",
      crdNumber: "7413463",
    };
    const result: CrdScrapeJobResult = {
      jobId: "crd_scrape_test",
      status: "completed",
      crdNumber: "7413463",
      reportAvailable: true,
      report: {
        fullName: "Andrew Garrett Kirkland",
        registrationStatus: "active",
        officialLocation: {
          city: "Kennesaw",
          state: "GA",
          pinZip: "30144",
          address: "114 Townpark Drive, Ste. 175",
        },
        exams: [
          { category: "Series 66", name: "Uniform Combined State Law Examination" },
          { category: "SIE", name: "Securities Industry Essentials Examination" },
        ],
        officialReports: [
          {
            source: "iapd_pdf",
            textExcerpt:
              "The adviser provides portfolio management services as a fee-only adviser. Minimum account size is $250,000.",
          },
        ],
      },
    };

    const patch = buildRiaScrapePrefillPatch(draft, result);

    expect(patch.city).toBe("Kennesaw");
    expect(patch.areaLocality).toBe("GA");
    expect(patch.pinZip).toBe("30144");
    expect(patch.fullStreetAddress).toBe("114 Townpark Drive, Ste. 175");
    expect(patch.certifications).toEqual(["Series 66", "SIE"]);
    expect(patch.servicesOffered).toEqual(["Portfolio Management"]);
    expect(patch.feeStructure).toEqual(["Fee-only"]);
    expect(patch.minEngagementAmount).toBe("250,000");
    expect(patch.bio).toContain("Andrew Garrett Kirkland is listed as active");
  });

  it("does not overwrite user-edited service and bio fields during async scrape enrichment", () => {
    const draft = {
      ...createEmptyRiaOnboardingDraft(),
      advisorName: "Jane Advisor",
      servicesOffered: ["Tax Planning"],
      bio: "User-written bio.",
    };
    const result: CrdScrapeJobResult = {
      jobId: "crd_scrape_test",
      status: "completed",
      report: {
        fullName: "Jane Advisor",
        officialLocation: { city: "San Francisco", pinZip: "94105" },
        officialReports: [
          {
            textExcerpt:
              "Portfolio management services. Fee-only. Minimum account size is $100,000.",
          },
        ],
      },
    };

    const patch = buildRiaScrapePrefillPatch(draft, result);

    expect(patch.servicesOffered).toEqual(["Tax Planning"]);
    expect(patch.bio).toBe("User-written bio.");
    expect(patch.city).toBe("San Francisco");
    expect(patch.pinZip).toBe("94105");
    expect(patch.feeStructure).toEqual(["Fee-only"]);
  });
});

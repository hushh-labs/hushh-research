import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepLicenseDetails } from "@/components/ria/onboarding/onboarding-step-license-details";

describe("OnboardingStepLicenseDetails", () => {
  it("covers license detail field rendering", () => {
    render(
      <OnboardingStepLicenseDetails
        advisorName="Jane Advisor"
        firmName="Acme Wealth"
        regulator="SEC"
        regulatorStatus="Active"
        licenseExpiry="2027-12-31"
        certifications={["Series 65", "SIE"]}
        city="Atlanta"
        pinZip="30301"
        crdNumber="123456"
        onAdvisorNameChange={vi.fn()}
        onCityChange={vi.fn()}
        onPinZipChange={vi.fn()}
        isEnriching={false}
      />,
    );

    expect(screen.getByText("SEC - Active")).toBeTruthy();
    expect(screen.getByDisplayValue("Jane Advisor")).toBeTruthy();
    expect(screen.getByText("Acme Wealth")).toBeTruthy();
    expect(screen.getByText("123456")).toBeTruthy();
    expect(screen.getByText("2027-12-31")).toBeTruthy();
    expect(screen.getByText("Series 65, SIE")).toBeTruthy();
    expect(screen.getByDisplayValue("Atlanta")).toBeTruthy();
    expect(screen.getByDisplayValue("30301")).toBeTruthy();
  });
});

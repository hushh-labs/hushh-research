import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingShell } from "@/components/ria/onboarding/onboarding-shell";
import { OnboardingStepLicenseDetails } from "@/components/ria/onboarding/onboarding-step-license-details";

describe("RIA onboarding license details layout", () => {
  it("renders the verification fields and lets long certifications wrap", () => {
    render(
      <OnboardingStepLicenseDetails
        advisorName="Jane Advisor"
        firmName="Northstar Wealth Studio"
        regulator="SEC"
        regulatorStatus="Not currently registered"
        licenseExpiry=""
        certifications={[
          "Series 66 - Uniform Combined State Law Examination, Series 66",
        ]}
        city="Little Rock"
        pinZip="72211"
        crdNumber="123456"
        onAdvisorNameChange={vi.fn()}
        onCityChange={vi.fn()}
        onPinZipChange={vi.fn()}
        isEnriching={false}
      />,
    );

    expect(screen.getByText("SEC - Not currently registered")).toBeTruthy();
    expect(screen.getByDisplayValue("Jane Advisor")).toBeTruthy();
    expect(screen.getByText("Northstar Wealth Studio")).toBeTruthy();
    expect(screen.getByText("123456")).toBeTruthy();
    expect(screen.getByDisplayValue("Little Rock")).toBeTruthy();
    expect(screen.getByDisplayValue("72211")).toBeTruthy();

    const certification = screen.getByText(
      "Series 66 - Uniform Combined State Law Examination, Series 66",
    );
    expect(certification.className).toContain("whitespace-normal");
    expect(certification.className).toContain("break-words");
    expect(certification.className).not.toContain("whitespace-nowrap");
  });

  it("keeps the Continue action on the same full-width content grid", () => {
    render(
      <OnboardingShell
        currentStepIndex={2}
        totalSteps={5}
        eyebrow="Verification"
        title="Verify your details"
        description="Prefilled - fix what's off."
        canContinue
        saving={false}
        isFirstStep={false}
        isLastStep={false}
        advisoryAccessReady={false}
        heroImage={{
          src: "/ria/onboarding/verification.png",
          variant: "accent",
          badge: true,
        }}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      >
        <div>Verification details</div>
      </OnboardingShell>,
    );

    expect(screen.getByRole("button", { name: "Go back to previous step" }))
      .toBeTruthy();
    expect(screen.getByText("Verification")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verify your details" }))
      .toBeTruthy();
    expect(screen.getByText("Prefilled - fix what's off.")).toBeTruthy();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeTruthy();
    expect(continueButton.parentElement?.className).toBe("w-full");
  });
});

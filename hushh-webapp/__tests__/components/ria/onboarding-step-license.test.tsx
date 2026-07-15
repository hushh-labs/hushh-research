import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepLicense } from "@/components/ria/onboarding/onboarding-step-license";

describe("OnboardingStepLicense", () => {
  it("keeps live verification and dev/UAT bypass as separate actions", () => {
    const onVerify = vi.fn();
    const onBypassVerification = vi.fn();

    render(
      <OnboardingStepLicense
        licenseNumber="123456"
        onLicenseNumberChange={vi.fn()}
        verificationStatus="idle"
        onVerify={onVerify}
        onBypassVerification={onBypassVerification}
        verificationBypassEnabled
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Verify licence" }));
    fireEvent.click(screen.getByRole("button", { name: "Bypass for dev/UAT" }));

    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(onBypassVerification).toHaveBeenCalledTimes(1);
  });

  it("hides bypass action when environment bypass is disabled", () => {
    render(
      <OnboardingStepLicense
        licenseNumber="123456"
        onLicenseNumberChange={vi.fn()}
        verificationStatus="idle"
        onVerify={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Verify licence" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bypass for dev/UAT" })).toBeNull();
  });

  it("covers no registration fallback", () => {
    render(
      <OnboardingStepLicense
        licenseNumber="999999"
        onLicenseNumberChange={vi.fn()}
        verificationStatus="not_found"
        onVerify={vi.fn()}
      />,
    );

    expect(screen.getByText("No matching registration found.")).toBeTruthy();
    expect(screen.getByText("Try a different licence number.")).toBeTruthy();
  });
});

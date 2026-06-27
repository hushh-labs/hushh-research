import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepServices } from "@/components/ria/onboarding/onboarding-step-services";

describe("OnboardingStepServices", () => {
  it("covers services group semantics", () => {
    render(
      <OnboardingStepServices
        servicesOffered={["Portfolio Management"]}
        feeStructure={["Fee-only"]}
        minEngagementAmount="250000"
        bio="Advisor bio"
        city="Atlanta"
        areaLocality="Downtown"
        fullStreetAddress="100 Market Street"
        pinZip="30301"
        onServicesChange={vi.fn()}
        onFeeStructureChange={vi.fn()}
        onMinEngagementChange={vi.fn()}
        onBioChange={vi.fn()}
        onCityChange={vi.fn()}
        onAreaLocalityChange={vi.fn()}
        onFullStreetAddressChange={vi.fn()}
        onPinZipChange={vi.fn()}
        onDraftBio={vi.fn()}
      />,
    );

    expect(screen.getByRole("group", { name: "Services offered" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Fee structure" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Portfolio Management" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Tax Planning" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

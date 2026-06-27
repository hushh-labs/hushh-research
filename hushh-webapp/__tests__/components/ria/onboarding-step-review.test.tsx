import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepReview } from "@/components/ria/onboarding/onboarding-step-review";

describe("OnboardingStepReview", () => {
  it("covers review action button type", () => {
    render(
      <OnboardingStepReview
        advisorName="Jane Advisor"
        firmName="Acme Wealth"
        crdNumber="123456"
        regulator="SEC"
        regulatorStatus="Active"
        certifications={["Series 65"]}
        servicesOffered={["Portfolio Management"]}
        feeStructure={["Fee-only"]}
        minEngagementAmount="$250,000"
        bio="RIA profile bio"
        city="Atlanta"
        pinZip="30301"
        areaLocality="Downtown"
        fullStreetAddress="100 Market Street"
        advisoryAccessReady={false}
        onEditSection={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /ask kai to update anything/i }).getAttribute("type"),
    ).toBe("button");
  });
});

import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepServices } from "@/components/ria/onboarding/onboarding-step-services";

const noop = vi.fn();

function renderServicesStep(
  overrides: Partial<ComponentProps<typeof OnboardingStepServices>> = {},
) {
  return render(
    <OnboardingStepServices
      servicesOffered={["Portfolio Management"]}
      feeStructure={["Fee-only"]}
      minEngagementAmount="250,000"
      bio="Andrew Garrett Kirkland is a financial advisor."
      city=""
      areaLocality=""
      fullStreetAddress=""
      pinZip=""
      onServicesChange={noop}
      onFeeStructureChange={noop}
      onMinEngagementChange={noop}
      onBioChange={noop}
      onCityChange={noop}
      onAreaLocalityChange={noop}
      onFullStreetAddressChange={noop}
      onPinZipChange={noop}
      onDraftBio={noop}
      {...overrides}
    />,
  );
}

describe("OnboardingStepServices", () => {
  it("renders the static design map when onboarding passes one", () => {
    renderServicesStep({ staticMapPreviewSrc: "/ria/onboarding/map.png" });

    const map = screen.getByAltText("Business location map");
    expect(map).toHaveAttribute("src", "/ria/onboarding/map.png");
    expect(screen.queryByText("Map preview")).toBeNull();
  });

  it("keeps the existing map preview fallback when no static map is provided", () => {
    renderServicesStep();

    expect(screen.getByText("Map preview")).toBeTruthy();
    expect(screen.queryByAltText("Business location map")).toBeNull();
  });
});

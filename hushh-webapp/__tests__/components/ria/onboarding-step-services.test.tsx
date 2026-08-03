import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("uses accessible checkboxes for independently selectable services", () => {
    const onServicesChange = vi.fn();
    renderServicesStep({
      servicesOffered: ["Portfolio Management", "Retirement Planning"],
      onServicesChange,
    });

    const portfolio = screen.getByRole("checkbox", {
      name: "Portfolio Management",
    });
    const retirement = screen.getByRole("checkbox", {
      name: "Retirement Planning",
    });
    expect(portfolio).toHaveAttribute("aria-checked", "true");
    expect(retirement).toHaveAttribute("aria-checked", "true");

    fireEvent.click(portfolio);
    expect(onServicesChange).toHaveBeenCalledWith(["Retirement Planning"]);
  });
});

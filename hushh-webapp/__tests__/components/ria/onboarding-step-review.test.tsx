import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepReview } from "@/components/ria/onboarding/onboarding-step-review";

const baseProps = {
  advisorName: "Andrew Garrett Kirkland",
  firmName: "YOUR WEALTH ADVISORS",
  crdNumber: "7413463",
  regulator: "SEC",
  regulatorStatus:
    "Not currently registered as an Investment Adviser Representative",
  certifications: ["Series 66 - Uniform Combined State Law Examination"],
  servicesOffered: ["Portfolio Management", "Tax Planning"],
  feeStructure: ["AUM %", "Fee-only"],
  minEngagementAmount: "250,000",
  bio: "Andrew Garrett Kirkland is a financial advisor focused on tax-aware planning for high-growth founders.",
  city: "Little Rock",
  pinZip: "72211",
  areaLocality: "AR",
  fullStreetAddress: "1701 Centerview Dr, STE 121",
  advisoryAccessReady: false,
  onEditSection: vi.fn(),
  onAskKaiUpdateAnything: vi.fn(),
};

describe("OnboardingStepReview detail card alignment", () => {
  it("renders licence and services information without removing edit actions", () => {
    const onEditSection = vi.fn();

    render(
      <OnboardingStepReview {...baseProps} onEditSection={onEditSection} />,
    );

    expect(screen.getByText("Andrew Garrett Kirkland")).toBeTruthy();
    expect(screen.getByText("YOUR WEALTH ADVISORS")).toBeTruthy();
    expect(screen.getByText("7413463")).toBeTruthy();
    expect(
      screen.getByText(
        "SEC - Not currently registered as an Investment Adviser Representative",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Series 66 - Uniform Combined State Law Examination"),
    ).toBeTruthy();
    expect(screen.getByText("Portfolio Management, Tax Planning")).toBeTruthy();
    expect(screen.getByText("AUM %, Fee-only")).toBeTruthy();
    expect(screen.getByText("250,000")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /edit/i })).toHaveLength(3);

    fireEvent.click(screen.getAllByRole("button", { name: /edit/i })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /edit/i })[1]);

    expect(onEditSection).toHaveBeenNthCalledWith(1, "license");
    expect(onEditSection).toHaveBeenNthCalledWith(2, "services");
  });

  it("uses one value-column grid for long licence, certification, and services rows", () => {
    const { container } = render(<OnboardingStepReview {...baseProps} />);

    const expectedGrid =
      "grid-cols-[7.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[8rem_minmax(0,1fr)]";
    const rowIds = [
      "ria-review-row-advisor",
      "ria-review-row-firm",
      "ria-review-row-crd",
      "ria-review-row-regulator",
      "ria-review-row-certifications",
      "ria-review-row-services",
      "ria-review-row-fees",
      "ria-review-row-min-engagement",
      "ria-review-row-bio",
    ];

    for (const rowId of rowIds) {
      const row = screen.getByTestId(rowId);
      expect(row.className).toContain(expectedGrid);
      expect(row.querySelector('[data-slot="review-label"]')).toBeTruthy();
      expect(row.querySelector('[data-slot="review-value"]')).toBeTruthy();
    }

    const regulatorValue = screen
      .getByTestId("ria-review-row-regulator")
      .querySelector('[data-slot="review-value"]');
    expect(regulatorValue?.className).toContain("text-left");
    expect(regulatorValue?.className).not.toContain("text-right");

    const certificationValue = screen
      .getByTestId("ria-review-row-certifications")
      .querySelector('[data-slot="review-value"]');
    expect(certificationValue?.textContent).toContain(
      "Series 66 - Uniform Combined State Law Examination",
    );
    expect(certificationValue?.textContent).toContain("Series 66");

    const detachedCertificationChips = Array.from(
      container.querySelectorAll("span"),
    ).filter(
      (node) =>
        node.textContent === "Series 66" &&
        !screen
          .getByTestId("ria-review-row-certifications")
          .contains(node),
    );
    expect(detachedCertificationChips).toHaveLength(0);
  });
});

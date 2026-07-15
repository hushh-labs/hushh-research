import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingStepWelcome } from "@/components/ria/onboarding/onboarding-step-welcome";

describe("OnboardingStepWelcome", () => {
  it("covers persona option pressed state", () => {
    render(
      <OnboardingStepWelcome
        onboardingType="individual"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /individual ria/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /firm \/ practice/i }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

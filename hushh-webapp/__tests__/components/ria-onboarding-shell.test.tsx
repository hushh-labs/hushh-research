import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingShell } from "@/components/ria/onboarding/onboarding-shell";

describe("OnboardingShell", () => {
  it("covers step status live region", () => {
    render(
      <OnboardingShell
        currentStepIndex={1}
        totalSteps={4}
        eyebrow="License"
        title="Verify your license"
        description="Confirm your advisor registration."
        canContinue
        saving={false}
        isFirstStep={false}
        isLastStep={false}
        advisoryAccessReady={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      >
        <div>License form</div>
      </OnboardingShell>,
    );

    const status = screen.getByRole("status");

    expect(status.textContent).toBe("Step 2 of 4");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
  });
});

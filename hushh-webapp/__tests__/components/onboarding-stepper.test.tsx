import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";

const STEPS = [
  { id: "a", label: "Investment horizon" },
  { id: "b", label: "Risk response" },
  { id: "c", label: "Volatility comfort" },
];

describe("OnboardingStepper", () => {
  it("marks the active step with aria-current=step", () => {
    render(<OnboardingStepper steps={STEPS} currentIndex={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[1].getAttribute("aria-current")).toBe("step");
    expect(items[2].getAttribute("aria-current")).toBeNull();
  });

  it("exposes a labelled navigation region and visible position", () => {
    render(
      <OnboardingStepper
        steps={STEPS}
        currentIndex={0}
        ariaLabel="Preferences setup"
      />,
    );
    expect(
      screen.getByRole("navigation", { name: "Preferences setup" }),
    ).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("announces the active step label to assistive tech", () => {
    render(<OnboardingStepper steps={STEPS} currentIndex={2} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Step 3 of 3");
    expect(status.textContent).toContain("Volatility comfort");
  });

  it("clamps an out-of-range index instead of crashing", () => {
    render(<OnboardingStepper steps={STEPS} currentIndex={99} />);
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  });

  it("renders nothing for an empty step list", () => {
    const { container } = render(
      <OnboardingStepper steps={[]} currentIndex={0} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

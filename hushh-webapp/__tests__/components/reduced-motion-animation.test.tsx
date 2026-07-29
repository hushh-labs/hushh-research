import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function MotionCard({
  prefersReducedMotion,
}: {
  prefersReducedMotion: boolean;
}) {
  return (
    <div
      data-testid="motion-card"
      data-motion={prefersReducedMotion ? "disabled" : "enabled"}
    >
      Portfolio insights
    </div>
  );
}

describe("reduced motion animation contract", () => {
  it("preserves disabled motion state for reduced-motion users", () => {
    render(<MotionCard prefersReducedMotion />);

    expect(
      screen.getByTestId("motion-card").getAttribute("data-motion")
    ).toBe("disabled");
  });

  it("preserves enabled motion state for standard users", () => {
    render(<MotionCard prefersReducedMotion={false} />);

    expect(
      screen.getByTestId("motion-card").getAttribute("data-motion")
    ).toBe("enabled");
  });
});
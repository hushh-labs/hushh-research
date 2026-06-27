import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Progress } from "@/components/ui/progress";

describe("Progress", () => {
  it("renders root and indicator data-slot contracts", () => {
    const { container } = render(<Progress value={50} />);

    expect(
      container.querySelector('[data-slot="progress"]'),
    ).toBeTruthy();

    expect(
      container.querySelector('[data-slot="progress-indicator"]'),
    ).toBeTruthy();
  });

  it("propagates custom class names", () => {
    const { container } = render(<Progress className="custom-progress" />);
    expect(container.querySelector('[data-slot="progress"]')?.className).toContain("custom-progress");
  });

  it("uses provided value when within range", () => {
    const { container } = render(<Progress value={50} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translate3d(-50%, 0, 0)");
  });

  it("keeps the progress indicator data-slot when indicatorClassName is provided", () => {
    const { container } = render(
      <Progress value={25} indicatorClassName="custom-indicator" />,
    );

    expect(container.querySelector(".custom-indicator")?.getAttribute("data-slot")).toBe(
      "progress-indicator",
    );
  });

  it("clamps values above 100", () => {
    const { container } = render(<Progress value={150} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translate3d(-0%, 0, 0)");
  });

  it("clamps values below 0", () => {
    const { container } = render(<Progress value={-50} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translate3d(-100%, 0, 0)");
  });
  it("sets aria-valuenow to the provided value", () => {
    const { container } = render(<Progress value={50} />);

    const root = container.querySelector('[data-slot="progress"]');

    expect(root?.getAttribute("aria-valuenow")).toBe("50");
  });
});

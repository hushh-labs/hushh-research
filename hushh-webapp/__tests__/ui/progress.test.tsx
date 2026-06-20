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

  it("uses provided value when within range", () => {
    const { container } = render(<Progress value={50} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translateX(-50%)");
  });

  it("clamps values above 100", () => {
    const { container } = render(<Progress value={150} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translateX(-0%)");
  });

  it("clamps values below 0", () => {
    const { container } = render(<Progress value={-50} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;

    expect(indicator.style.transform).toBe("translateX(-100%)");
  });
});
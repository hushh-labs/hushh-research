import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";

describe("Checkbox", () => {
  it("renders root with data-slot='checkbox'", () => {
    const { container } = render(<Checkbox />);

    expect(container.querySelector('[data-slot="checkbox"]')).toBeTruthy();
  });

  it("renders indicator with data-slot='checkbox-indicator'", () => {
    const { container } = render(<Checkbox checked />);

    expect(
      container.querySelector('[data-slot="checkbox-indicator"]'),
    ).toBeTruthy();
  });

  it("sets aria-required when required is true", () => {
    const { container } = render(<Checkbox required />);

    const el = container.querySelector('[data-slot="checkbox"]');

    expect(el?.getAttribute("aria-required")).toBe("true");
  });
});
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

  it("reflects controlled checked state with aria-checked", () => {
    const { container, rerender } = render(<Checkbox checked={false} />);
    const checkbox = container.querySelector('[data-slot="checkbox"]');

    expect(checkbox?.getAttribute("aria-checked")).toBe("false");

    rerender(<Checkbox checked />);

    expect(checkbox?.getAttribute("aria-checked")).toBe("true");
  });

  it("has role='checkbox'", () => {
    const { container } = render(<Checkbox />);

    const checkbox = container.querySelector('[data-slot="checkbox"]');

    expect(checkbox?.getAttribute("role")).toBe("checkbox");
  });

});

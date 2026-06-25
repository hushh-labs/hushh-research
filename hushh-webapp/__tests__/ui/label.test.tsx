import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label } from "@/components/ui/label";

describe("Label", () => {
  it("renders with data-slot='label'", () => {
    const { container } = render(<Label>Email</Label>);

    expect(container.querySelector('[data-slot="label"]')).toBeTruthy();
  });

  it("preserves data-slot='label' when htmlFor is set", () => {
    const { container } = render(<Label htmlFor="email">Email</Label>);

    expect(
      container.querySelector('label[for="email"][data-slot="label"]'),
    ).toBeTruthy();
  });

  it("applies disabled peer styling class", () => {
    const { container } = render(<Label>Email</Label>);

    const label = container.querySelector('[data-slot="label"]');

    expect(label?.className).toContain("peer-disabled:opacity-50");
  });

  it("renders with select-none class for user-select prevention", () => {
    const { container } = render(<Label>Email</Label>);

    const label = container.querySelector('[data-slot="label"]');

    expect(label?.className).toContain("select-none");
  });
});

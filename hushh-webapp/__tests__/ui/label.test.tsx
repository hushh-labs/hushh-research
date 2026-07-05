import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label } from "@/components/ui/label";

describe("Label", () => {
  it("renders with data-slot='label'", () => {
    const { container } = render(<Label>Email</Label>);

    expect(container.querySelector('[data-slot="label"]')).toBeTruthy();
  });

  it("applies disabled peer styling class", () => {
    const { container } = render(<Label>Email</Label>);

    const label = container.querySelector('[data-slot="label"]');

    expect(label?.className).toContain("peer-disabled:opacity-50");
  });
});
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label } from "@/components/ui/label";

describe("Label", () => {
  it("exposes the label data-slot contract", () => {
    const { container } = render(<Label>Username</Label>);

    expect(
      container.querySelector('[data-slot="label"]')
    ).not.toBeNull();
  });

  it("renders as a label element", () => {
    const { container } = render(<Label>Email</Label>);

    const label = container.querySelector('[data-slot="label"]');

    expect(label?.tagName).toBe("LABEL");
  });

});
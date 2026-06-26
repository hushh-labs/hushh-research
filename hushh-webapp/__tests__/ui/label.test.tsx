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
});
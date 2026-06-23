import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Separator } from "@/components/ui/separator";

describe("Separator", () => {
  it("exposes the separator data-slot contract", () => {
    const { container } = render(<Separator />);

    expect(
      container.querySelector('[data-slot="separator"]'),
    ).not.toBeNull();
  });
});
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders with data-slot='skeleton'", () => {
    const { container } = render(<Skeleton />);

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("renders with aria-hidden='true'", () => {
    const { container } = render(<Skeleton />);

    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders with pointer-events-none class", () => {
    const { container } = render(<Skeleton />);

    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.className).toContain("pointer-events-none");
  });
});
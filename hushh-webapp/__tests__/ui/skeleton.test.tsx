import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders with data-slot='skeleton'", () => {
    const { container } = render(<Skeleton />);

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("keeps the skeleton data-slot when custom layout classes are provided", () => {
    const { container } = render(<Skeleton className="h-8 w-24" />);

    expect(container.firstElementChild?.getAttribute("data-slot")).toBe("skeleton");
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

  it("propagates className to the underlying element", () => {
    const { container } = render(<Skeleton className="test-class" />);

    const el = container.querySelector('[data-slot="skeleton"]');
    
    expect(el?.classList.contains("test-class")).toBe(true);
  });
});

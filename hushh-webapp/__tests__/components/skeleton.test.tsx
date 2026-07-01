import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("reserves a stable noninteractive layout box", () => {
    const { container } = render(<Skeleton className="h-10 w-full" />);
    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton?.className).toContain("pointer-events-none");
    expect(skeleton?.className).toContain("overflow-hidden");
    expect(skeleton?.className).toContain("[contain:layout_paint]");
    expect(skeleton?.className).toContain("h-10");
    expect(skeleton?.className).toContain("w-full");
  });

  it("renders with default styling classes", () => {
    const { container } = render(<Skeleton />);
    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.className).toContain("rounded-md");
    expect(skeleton?.className).toContain("bg-accent");
    expect(skeleton?.className).toContain("animate-pulse");
  });

  it("forwards extra html attributes and props", () => {
    const { container } = render(<Skeleton id="my-skeleton" data-testid="skeleton-test" />);
    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.getAttribute("id")).toBe("my-skeleton");
    expect(skeleton?.getAttribute("data-testid")).toBe("skeleton-test");
  });
});

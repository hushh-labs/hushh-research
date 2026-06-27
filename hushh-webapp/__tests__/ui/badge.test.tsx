import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders with data-slot='badge'", () => {
    const { container } = render(<Badge>Label</Badge>);

    expect(
      container.querySelector('[data-slot="badge"]'),
    ).toBeTruthy();
  });

  it("propagates custom class names", () => {
    const { container } = render(<Badge className="custom-badge">Label</Badge>);
    expect(container.querySelector('[data-slot="badge"]')?.className).toContain("custom-badge");
  });

  it("preserves the badge data-slot when rendered asChild", () => {
    const { container } = render(
      <Badge asChild>
        <a href="/profile">Profile</a>
      </Badge>,
    );

    expect(container.querySelector("a")?.getAttribute("data-slot")).toBe("badge");
  });

  it("defaults to data-variant='default'", () => {
    const { container } = render(<Badge>Label</Badge>);

    const badge = container.querySelector('[data-slot="badge"]');

    expect(
      badge?.getAttribute("data-variant"),
    ).toBe("default");
  });

  it("propagates variant as data-variant", () => {
    const variants = [
      "secondary",
      "destructive",
      "outline",
      "ghost",
      "link",
    ] as const;

    variants.forEach((variant) => {
      const { container } = render(
        <Badge variant={variant}>
          {variant}
        </Badge>,
      );

      const badge = container.querySelector(
        '[data-slot="badge"]',
      );

      expect(
        badge?.getAttribute("data-variant"),
      ).toBe(variant);
    });
  });

  it("renders Badge as a span element", () => {
    const { container } = render(<Badge>Label</Badge>);

    const badge = container.querySelector('[data-slot="badge"]');

    expect(badge?.tagName).toBe("SPAN");
  });

});

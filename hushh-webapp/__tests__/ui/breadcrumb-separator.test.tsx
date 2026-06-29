import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BreadcrumbSeparator } from "@/components/ui/breadcrumb";

describe("BreadcrumbSeparator", () => {
  it("hides the decorative chevron from assistive technology", () => {
    const { container } = render(<BreadcrumbSeparator />);

    const separator = container.querySelector(
      '[data-slot="breadcrumb-separator"]',
    );
    const chevron = separator?.querySelector("svg");

    expect(separator?.getAttribute("aria-hidden")).toBe("true");
    expect(separator?.getAttribute("role")).toBe("presentation");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
  });
});

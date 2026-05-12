import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ScrollToTop } from "@/components/app-ui/scroll-to-top";

describe("ScrollToTop Component - A11y & Structure", () => {
  it("renders as a button with mandatory ARIA labels", () => {
    const { container } = render(<ScrollToTop />);
    const button = container.querySelector("button");
    
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Scroll to top of page");
  });

  it("includes required fixed positioning and transition classes", () => {
    const { container } = render(<ScrollToTop />);
    const button = container.querySelector("button");
    
    expect(button?.className).toContain("fixed");
    expect(button?.className).toContain("transition-all");
    expect(button?.className).toContain("z-50");
  });

  it("includes strict keyboard focus-visible states", () => {
    const { container } = render(<ScrollToTop />);
    const button = container.querySelector("button");
    
    expect(button?.className).toContain("focus-visible:ring-2");
    expect(button?.className).toContain("focus-visible:outline-none");
  });
});
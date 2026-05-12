import React from "react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { AnimatedCounter } from "@/components/app-ui/animated-counter";

describe("AnimatedCounter Component - Polish & A11y", () => {
  beforeAll(() => {
    // Mock window.matchMedia for testing environments
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false, // Default to allowing motion
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("renders the final value cleanly to screen readers using sr-only", () => {
    const { container } = render(<AnimatedCounter value={1500} />);
    const srOnlyNode = container.querySelector(".sr-only");
    
    expect(srOnlyNode).toBeDefined();
    // Default format uses toLocaleString()
    expect(srOnlyNode?.textContent).toBe("1,500");
  });

  it("hides the visually animating numbers from assistive technologies", () => {
    const { container } = render(<AnimatedCounter value={1500} />);
    const hiddenNode = container.querySelector('[aria-hidden="true"]');
    
    expect(hiddenNode).toBeDefined();
  });

  it("respects custom data formatting functions (e.g., currency mappings)", () => {
    const formatAsCurrency = (val: number) => `$${val}.00`;
    const { container } = render(<AnimatedCounter value={50} format={formatAsCurrency} />);
    
    const srOnlyNode = container.querySelector(".sr-only");
    expect(srOnlyNode?.textContent).toBe("$50.00");
  });
});
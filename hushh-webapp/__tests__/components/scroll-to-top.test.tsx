import { describe, expect, it } from "vitest";
import { ScrollToTop } from "@/components/app-ui/scroll-to-top";

describe("ScrollToTop Component - A11y & Structure", () => {
  it("renders as a button with mandatory ARIA labels", () => {
    const element = ScrollToTop();
    expect(element.props.type).toBe("button");
    expect(element.props["aria-label"]).toBe("Scroll to top of page");
  });

  it("includes required fixed positioning and transition classes", () => {
    const element = ScrollToTop();
    expect(element.props.className).toContain("fixed");
    expect(element.props.className).toContain("transition-all");
    expect(element.props.className).toContain("z-50");
  });

  it("includes strict keyboard focus-visible states", () => {
    const element = ScrollToTop();
    expect(element.props.className).toContain("focus-visible:ring-2");
    expect(element.props.className).toContain("focus-visible:outline-none");
  });
});
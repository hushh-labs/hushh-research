import { describe, expect, it } from "vitest";
import { SkipToContent } from "@/components/app-ui/skip-to-content";

describe("SkipToContent - A11y Keyboard Navigation", () => {
  it("generates correct default fallback href", () => {
    const element = SkipToContent({});
    expect(element.props.href).toBe("#main-content");
  });

  it("accepts custom target IDs for dynamic routing", () => {
    const element = SkipToContent({ targetId: "dashboard-view" });
    expect(element.props.href).toBe("#dashboard-view");
  });

  it("contains mandatory screen-reader utility classes for visual hiding", () => {
    const element = SkipToContent({});
    expect(element.props.className).toContain("sr-only");
    expect(element.props.className).toContain("focus:not-sr-only");
  });

  it("preserves additional user-injected class names", () => {
    const element = SkipToContent({ className: "custom-testing-class" });
    expect(element.props.className).toContain("custom-testing-class");
  });
});
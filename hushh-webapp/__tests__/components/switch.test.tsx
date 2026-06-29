import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("renders with data-slot=switch", () => {
    const { container } = render(<Switch />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-slot")).toBe("switch");
  });

  it("renders with default size data attribute", () => {
    const { container } = render(<Switch />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("default");
  });

  it("renders with sm size data attribute", () => {
    const { container } = render(<Switch size="sm" />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("data-size")).toBe("sm");
  });
});

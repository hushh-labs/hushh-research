import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("renders with data-slot switch on root", () => {
    render(<Switch />);
    const el = screen.getByRole("switch");
    expect(el.getAttribute("data-slot")).toBe("switch");
  });

  it("renders switch-thumb with data-slot switch-thumb", () => {
    const { container } = render(<Switch />);
    const thumb = container.querySelector('[data-slot="switch-thumb"]');
    expect(thumb).not.toBeNull();
  });

  it("applies data-size default when no size prop is given", () => {
    render(<Switch />);
    const el = screen.getByRole("switch");
    expect(el.getAttribute("data-size")).toBe("default");
  });

  it("applies data-size sm when size is sm", () => {
    render(<Switch size="sm" />);
    const el = screen.getByRole("switch");
    expect(el.getAttribute("data-size")).toBe("sm");
  });

  it("applies data-size default when size is default", () => {
    render(<Switch size="default" />);
    const el = screen.getByRole("switch");
    expect(el.getAttribute("data-size")).toBe("default");
  });
});